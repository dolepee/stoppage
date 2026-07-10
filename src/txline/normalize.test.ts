import { describe, expect, it } from "vitest";

import { normalize1x2Quote, normalizeMatchEvent } from "./normalize.js";
import { oddsPayloadSchema, scorePayloadSchema } from "./types.js";

describe("TxLINE normalization", () => {
  it("normalizes de-margined percentages by named 1X2 selections", () => {
    const normalized = normalize1x2Quote(
      {
        FixtureId: 77,
        MessageId: "odds-1",
        Ts: 1_000,
        Bookmaker: "StablePrice",
        BookmakerId: 1,
        SuperOddsType: "1X2",
        InRunning: true,
        PriceNames: ["Eastport", "Draw", "Northbridge"],
        Pct: ["20.000", "25.000", "55.000"],
      },
      { home: "Northbridge", away: "Eastport" },
      1_120,
    );

    expect(normalized?.probabilities).toEqual({
      HOME: 0.55,
      DRAW: 0.25,
      AWAY: 0.2,
    });
    expect(normalized?.receivedTs).toBe(1_120);
  });

  it("rejects non-1X2 shapes instead of guessing", () => {
    const normalized = normalize1x2Quote(
      {
        FixtureId: 77,
        MessageId: "odds-2",
        Ts: 1_000,
        Bookmaker: "StablePrice",
        BookmakerId: 1,
        SuperOddsType: "OU",
        InRunning: true,
        PriceNames: ["Over", "Under"],
        Pct: ["50.000", "50.000"],
      },
      { home: "Northbridge", away: "Eastport" },
    );
    expect(normalized).toBeNull();
  });

  it("maps TxLINE part1 and part2 labels to the home and away sides", () => {
    const normalized = normalize1x2Quote(
      {
        FixtureId: 77,
        MessageId: "odds-participants",
        Ts: 1_000,
        Bookmaker: "TXLineStablePriceDemargined",
        BookmakerId: 1,
        SuperOddsType: "1X2_PARTICIPANT_RESULT",
        InRunning: true,
        PriceNames: ["part1", "draw", "part2"],
        Pct: ["60.000", "25.000", "15.000"],
      },
      { home: "part1", away: "part2" },
    );

    expect(normalized?.probabilities).toEqual({
      HOME: 0.6,
      DRAW: 0.25,
      AWAY: 0.15,
    });
  });

  it("rejects period-specific 1X2 records on the full-match governor", () => {
    const normalized = normalize1x2Quote(
      {
        FixtureId: 77,
        MessageId: "odds-first-half",
        Ts: 1_000,
        Bookmaker: "TXLineStablePriceDemargined",
        BookmakerId: 10_021,
        SuperOddsType: "1X2_PARTICIPANT_RESULT",
        InRunning: true,
        MarketPeriod: "half=1",
        PriceNames: ["part1", "draw", "part2"],
        Pct: ["60.000", "25.000", "15.000"],
      },
      { home: "part1", away: "part2" },
    );

    expect(normalized).toBeNull();
  });

  it("rejects unknown selection labels instead of guessing their order", () => {
    const normalized = normalize1x2Quote(
      {
        FixtureId: 77,
        MessageId: "odds-unknown-labels",
        Ts: 1_000,
        Bookmaker: "StablePrice",
        BookmakerId: 1,
        SuperOddsType: "1X2",
        InRunning: true,
        PriceNames: ["Side A", "Draw", "Side B"],
        Pct: ["50.000", "25.000", "25.000"],
      },
      { home: "Northbridge", away: "Eastport" },
    );

    expect(normalized).toBeNull();
  });

  it("accepts TxLINE pre-market messages with nullable state fields", () => {
    const payload = oddsPayloadSchema.parse({
      FixtureId: 77,
      MessageId: "odds-null-state",
      Ts: 1_000,
      Bookmaker: "StablePrice",
      BookmakerId: 1,
      SuperOddsType: "1X2",
      GameState: null,
      InRunning: false,
      MarketPeriod: null,
    });

    expect(payload.GameState).toBeNull();
    expect(
      normalize1x2Quote(payload, { home: "Home", away: "Away" }),
    ).toBeNull();
  });

  it("normalizes high-impact score actions", () => {
    const normalized = normalizeMatchEvent(
      {
        fixtureId: 77,
        gameState: "H2",
        action: "goal",
        id: 9,
        ts: 2_000,
        seq: 44,
        participant: 1,
        confirmed: true,
        dataSoccer: { Goal: true },
      },
      2_180,
    );
    expect(normalized).toMatchObject({
      eventType: "GOAL",
      eventId: "score:77:9:44",
      sourceTs: 2_000,
      receivedTs: 2_180,
    });
  });

  it("normalizes PascalCase mainnet history records", () => {
    const payload = scorePayloadSchema.parse({
      FixtureId: 77,
      GameState: "H2",
      Action: "red_card",
      Id: 10,
      Ts: 2_100,
      Seq: 45,
      Confirmed: true,
      Data: { RedCard: true },
      Stats: { "5": 1 },
    });

    expect(normalizeMatchEvent(payload)).toMatchObject({
      fixtureId: 77,
      eventType: "RED_CARD",
      sourceTs: 2_100,
    });
    expect(payload.stats).toEqual({ "5": 1 });
  });

  it("does not treat goal kicks or penalty outcomes as high-impact triggers", () => {
    const base = {
      fixtureId: 77,
      gameState: "H2",
      id: 10,
      ts: 2_100,
      seq: 45,
    };

    expect(normalizeMatchEvent({ ...base, action: "goal_kick" })).toBeNull();
    expect(
      normalizeMatchEvent({ ...base, action: "penalty_outcome" }),
    ).toBeNull();
    expect(
      normalizeMatchEvent({
        ...base,
        action: "action_amend",
        dataSoccer: { Goal: true },
      }),
    ).toBeNull();
  });
});
