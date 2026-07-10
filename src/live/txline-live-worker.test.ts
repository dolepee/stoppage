import { describe, expect, it } from "vitest";

import type { GovernorInput } from "../domain/types.js";
import type { OddsPayload, ScorePayload } from "../txline/types.js";
import { TxLineLiveWorker } from "./txline-live-worker.js";

describe("TxLineLiveWorker", () => {
  it("normalizes dual streams without exposing captured payloads", async () => {
    const inputs: GovernorInput[] = [];
    const captures: string[] = [];
    const controller = new AbortController();
    const client = {
      fetchFixtures: async () => [
        {
          FixtureId: 77,
          StartTime: 1_000,
          Participant1: "Northbridge",
          Participant2: "Eastport",
          Participant1IsHome: true,
        },
      ],
      streamOdds: async (
        callbacks: FakeCallbacks<OddsPayload>,
        signal: AbortSignal,
      ) => {
        await callbacks.onOpen();
        await callbacks.onHeartbeat(1_000);
        const payload = {
          FixtureId: 77,
          MessageId: "m1",
          Ts: 1_000,
          Bookmaker: "StablePrice",
          BookmakerId: 1,
          SuperOddsType: "1X2",
          InRunning: true,
          PriceNames: ["Northbridge", "Draw", "Eastport"],
          Pct: ["50.000", "25.000", "25.000"],
        };
        await callbacks.onRaw?.(payload, "odds:1");
        await callbacks.onData(payload);
        await untilAborted(signal);
      },
      streamScores: async (
        callbacks: FakeCallbacks<ScorePayload>,
        signal: AbortSignal,
      ) => {
        await callbacks.onOpen();
        await callbacks.onHeartbeat(1_000);
        const payload = {
          fixtureId: 77,
          gameState: "H2",
          action: "goal",
          id: 3,
          ts: 1_500,
          seq: 8,
          confirmed: true,
          dataSoccer: { Goal: true },
        };
        await callbacks.onRaw?.(payload, "scores:1");
        await callbacks.onData(payload);
        await untilAborted(signal);
      },
    };
    const worker = new TxLineLiveWorker({
      client,
      callbacks: {
        onInput: (input) => {
          inputs.push(input);
          if (inputs.length === 2) controller.abort();
        },
      },
      capture: async (name) => captures.push(name),
    });

    await worker.run(controller.signal);
    expect(inputs.map((input) => input.kind).sort()).toEqual([
      "match-event",
      "quote",
    ]);
    expect(captures).toHaveLength(2);
    expect(worker.status()).toMatchObject({
      running: false,
      fixturesLoaded: 1,
      normalizedOdds: 1,
      normalizedEvents: 1,
    });
  });
});

interface FakeCallbacks<T> {
  onOpen: () => void | Promise<void>;
  onHeartbeat: (timestamp: number | null) => void | Promise<void>;
  onRaw?: (payload: unknown, eventId?: string) => void | Promise<void>;
  onData: (payload: T) => void | Promise<void>;
}

function untilAborted(signal: AbortSignal) {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) =>
    signal.addEventListener("abort", () => resolve(), { once: true }),
  );
}
