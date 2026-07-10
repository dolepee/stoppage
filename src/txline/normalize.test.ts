import { describe, expect, it } from "vitest";

import { normalize1x2Quote, normalizeMatchEvent } from "./normalize.js";

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
});
