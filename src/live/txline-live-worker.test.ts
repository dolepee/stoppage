import { describe, expect, it, vi } from "vitest";

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
          const kinds = new Set(inputs.map((candidate) => candidate.kind));
          if (kinds.has("quote") && kinds.has("match-event")) {
            controller.abort();
          }
        },
      },
      capture: async (name) => captures.push(name),
    });

    await worker.run(controller.signal);
    expect(inputs.map((input) => input.kind)).toEqual(
      expect.arrayContaining(["stream-health", "match-event", "quote"]),
    );
    expect(captures).toHaveLength(2);
    expect(worker.status()).toMatchObject({
      running: false,
      fixturesLoaded: 1,
      oddsMessages: 1,
      scoreMessages: 1,
      normalizedOdds: 1,
      normalizedEvents: 1,
    });
  });

  it("emits clock ticks so fail-safe recovery can advance", async () => {
    vi.useFakeTimers();
    const inputs: GovernorInput[] = [];
    const controller = new AbortController();
    let now = 1_000;
    const client = {
      fetchFixtures: async () => [],
      streamOdds: async (
        callbacks: FakeCallbacks<OddsPayload>,
        signal: AbortSignal,
      ) => {
        await callbacks.onOpen();
        await untilAborted(signal);
      },
      streamScores: async (
        callbacks: FakeCallbacks<ScorePayload>,
        signal: AbortSignal,
      ) => {
        await callbacks.onOpen();
        await untilAborted(signal);
      },
    };
    const worker = new TxLineLiveWorker({
      client,
      now: () => now,
      callbacks: {
        onInput: (input) => {
          inputs.push(input);
          if (input.kind === "tick") controller.abort();
        },
      },
      capture: async () => undefined,
    });

    try {
      const run = worker.run(controller.signal);
      await vi.advanceTimersByTimeAsync(0);
      now = 2_000;
      await vi.advanceTimersByTimeAsync(1_000);
      await run;

      expect(inputs).toContainEqual({ kind: "tick", observedTs: 2_000 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("refreshes the fixture catalog without restarting", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    let fixtureRequests = 0;
    let now = 1_000;
    const client = {
      fetchFixtures: async () => {
        fixtureRequests += 1;
        return [
          {
            FixtureId: fixtureRequests === 1 ? 77 : 88,
            StartTime: 1_000,
            Participant1: `Home ${fixtureRequests}`,
            Participant2: `Away ${fixtureRequests}`,
          },
        ];
      },
      streamOdds: async (
        callbacks: FakeCallbacks<OddsPayload>,
        signal: AbortSignal,
      ) => {
        await callbacks.onOpen();
        await untilAborted(signal);
      },
      streamScores: async (
        callbacks: FakeCallbacks<ScorePayload>,
        signal: AbortSignal,
      ) => {
        await callbacks.onOpen();
        await untilAborted(signal);
      },
    };
    const worker = new TxLineLiveWorker({
      client,
      fixtureRefreshMs: 1_000,
      now: () => now,
      callbacks: { onInput: () => undefined },
      capture: async () => undefined,
    });

    try {
      const run = worker.run(controller.signal);
      await vi.advanceTimersByTimeAsync(0);
      expect(worker.status()).toMatchObject({
        fixturesLoaded: 1,
        fixtureRefreshes: 1,
      });

      now = 2_000;
      await vi.advanceTimersByTimeAsync(1_000);
      expect(worker.status()).toMatchObject({
        fixturesLoaded: 2,
        fixtureRefreshes: 2,
        fixtureRefreshFailures: 0,
        lastFixtureRefreshAt: 2_000,
      });

      controller.abort();
      await vi.advanceTimersByTimeAsync(0);
      await run;
    } finally {
      vi.useRealTimers();
    }
  });

  it("publishes a stopped status when startup fails", async () => {
    const statuses: boolean[] = [];
    const client = {
      fetchFixtures: async () => {
        throw new Error("fixture snapshot unavailable");
      },
      streamOdds: async () => undefined,
      streamScores: async () => undefined,
    };
    const worker = new TxLineLiveWorker({
      client,
      callbacks: {
        onInput: () => undefined,
        onStatus: (status) => {
          statuses.push(status.running);
        },
      },
      capture: async () => undefined,
    });

    await expect(worker.run(new AbortController().signal)).rejects.toThrow(
      "fixture snapshot unavailable",
    );
    expect(worker.status().running).toBe(false);
    expect(statuses.at(-1)).toBe(false);
  });

  it("resets reconnect backoff after a healthy heartbeat", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    let oddsConnections = 0;
    const client = {
      fetchFixtures: async () => [],
      streamOdds: async (
        callbacks: FakeCallbacks<OddsPayload>,
        signal: AbortSignal,
      ) => {
        oddsConnections += 1;
        await callbacks.onOpen();
        if (oddsConnections === 1) throw new Error("connect-reset");
        if (oddsConnections === 2) {
          await callbacks.onHeartbeat(1_000);
          return;
        }
        controller.abort();
        await untilAborted(signal);
      },
      streamScores: async (
        callbacks: FakeCallbacks<ScorePayload>,
        signal: AbortSignal,
      ) => {
        await callbacks.onOpen();
        await untilAborted(signal);
      },
    };
    const worker = new TxLineLiveWorker({
      client,
      reconnectBaseMs: 100,
      callbacks: { onInput: () => undefined },
      capture: async () => undefined,
    });

    try {
      const run = worker.run(controller.signal);
      await vi.advanceTimersByTimeAsync(0);
      expect(oddsConnections).toBe(1);
      await vi.advanceTimersByTimeAsync(100);
      expect(oddsConnections).toBe(2);
      await vi.advanceTimersByTimeAsync(99);
      expect(oddsConnections).toBe(2);
      await vi.advanceTimersByTimeAsync(1);
      await run;

      expect(oddsConnections).toBe(3);
      expect(worker.status().reconnects.odds).toBe(2);
    } finally {
      vi.useRealTimers();
    }
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
