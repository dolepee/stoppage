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

  it("records fixture refresh failures and clears them after recovery", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    let fixtureRequests = 0;
    let now = 1_000;
    const client = {
      fetchFixtures: async () => {
        fixtureRequests += 1;
        if (fixtureRequests === 2) {
          throw new Error(
            "TxLINE fixture snapshot failed with HTTP 503: private",
          );
        }
        return [];
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

      now = 2_000;
      await vi.advanceTimersByTimeAsync(1_000);
      expect(worker.status()).toMatchObject({
        fixtureRefreshes: 1,
        fixtureRefreshFailures: 1,
        lastFixtureRefreshFailure: {
          reason: "fixture-refresh-error:Error:HTTP_503",
          at: 2_000,
        },
      });
      expect(JSON.stringify(worker.status())).not.toContain("private");

      now = 3_000;
      await vi.advanceTimersByTimeAsync(1_000);
      expect(worker.status()).toMatchObject({
        fixtureRefreshes: 2,
        fixtureRefreshFailures: 1,
        lastFixtureRefreshAt: 3_000,
        lastFixtureRefreshFailure: null,
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
    expect(worker.status()).toMatchObject({
      fixtureRefreshFailures: 1,
      lastFixtureRefreshFailure: {
        reason: "fixture-refresh-error:Error",
      },
    });
    expect(statuses.at(-1)).toBe(false);
  });

  it("records stream failures and clears them when the stream reconnects", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    let now = 1_000;
    let oddsConnections = 0;
    const statuses: ReturnType<TxLineLiveWorker["status"]>[] = [];
    const client = {
      fetchFixtures: async () => [],
      streamOdds: async (
        callbacks: FakeCallbacks<OddsPayload>,
        signal: AbortSignal,
      ) => {
        oddsConnections += 1;
        if (oddsConnections === 1) {
          throw new Error("TxLINE odds failed with HTTP 502: private");
        }
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
      reconnectBaseMs: 100,
      now: () => now,
      callbacks: {
        onInput: () => undefined,
        onStatus: (status) => {
          statuses.push(status);
        },
      },
      capture: async () => undefined,
    });

    try {
      const run = worker.run(controller.signal);
      await vi.advanceTimersByTimeAsync(0);
      expect(worker.status()).toMatchObject({
        reconnects: { odds: 1, scores: 0 },
        lastStreamFailure: {
          odds: {
            reason: "stream-error:Error:HTTP_502",
            at: 1_000,
          },
          scores: null,
        },
      });
      expect(JSON.stringify(worker.status())).not.toContain("private");
      expect(
        statuses.some(
          (status) =>
            status.lastStreamFailure?.odds?.reason ===
            "stream-error:Error:HTTP_502",
        ),
      ).toBe(true);

      now = 1_100;
      await vi.advanceTimersByTimeAsync(100);
      expect(oddsConnections).toBe(2);
      expect(worker.status().lastStreamFailure?.odds).toBeNull();
      expect(worker.status().streamHealth.odds).toBe(true);

      controller.abort();
      await vi.advanceTimersByTimeAsync(0);
      await run;
    } finally {
      vi.useRealTimers();
    }
  });

  it("reconnects and recovers after a heartbeat timeout", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    let now = 1_000;
    let oddsConnections = 0;
    let scoreConnections = 0;
    const client = {
      fetchFixtures: async () => [],
      streamOdds: async (
        callbacks: FakeCallbacks<OddsPayload>,
        signal: AbortSignal,
      ) => {
        oddsConnections += 1;
        await callbacks.onOpen();
        await untilAborted(signal);
      },
      streamScores: async (
        callbacks: FakeCallbacks<ScorePayload>,
        signal: AbortSignal,
      ) => {
        scoreConnections += 1;
        await callbacks.onOpen();
        await untilAborted(signal);
      },
    };
    const worker = new TxLineLiveWorker({
      client,
      heartbeatTimeoutMs: 500,
      reconnectBaseMs: 100,
      now: () => now,
      callbacks: { onInput: () => undefined },
      capture: async () => undefined,
    });

    try {
      const run = worker.run(controller.signal);
      await vi.advanceTimersByTimeAsync(0);

      now = 2_000;
      await vi.advanceTimersByTimeAsync(1_000);
      expect(worker.status().lastStreamFailure).toEqual({
        odds: { reason: "heartbeat-timeout", at: 2_000 },
        scores: { reason: "heartbeat-timeout", at: 2_000 },
      });
      expect(worker.status()).toMatchObject({
        reconnects: { odds: 1, scores: 1 },
        streamHealth: { odds: false, scores: false },
      });

      now = 2_100;
      await vi.advanceTimersByTimeAsync(100);
      expect({ oddsConnections, scoreConnections }).toEqual({
        oddsConnections: 2,
        scoreConnections: 2,
      });
      expect(worker.status()).toMatchObject({
        reconnects: { odds: 1, scores: 1 },
        streamHealth: { odds: true, scores: true },
        lastStreamFailure: { odds: null, scores: null },
      });

      controller.abort();
      await vi.advanceTimersByTimeAsync(0);
      await run;
    } finally {
      vi.useRealTimers();
    }
  });

  it("removes completed delay listeners before scheduling the next tick", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const addListener = vi.spyOn(controller.signal, "addEventListener");
    const removeListener = vi.spyOn(controller.signal, "removeEventListener");
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
      callbacks: { onInput: () => undefined },
      capture: async () => undefined,
    });
    const abortListenerBalance = () =>
      addListener.mock.calls.filter(([type]) => type === "abort").length -
      removeListener.mock.calls.filter(([type]) => type === "abort").length;

    try {
      const run = worker.run(controller.signal);
      await vi.advanceTimersByTimeAsync(0);
      const initialBalance = abortListenerBalance();

      await vi.advanceTimersByTimeAsync(3_000);
      expect(abortListenerBalance()).toBe(initialBalance);

      controller.abort();
      await vi.advanceTimersByTimeAsync(0);
      await run;
      expect(abortListenerBalance()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("times out an unopened stream attempt and reconnects", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    let now = 1_000;
    let oddsConnections = 0;
    const statuses: ReturnType<TxLineLiveWorker["status"]>[] = [];
    const client = {
      fetchFixtures: async () => [],
      streamOdds: async (
        callbacks: FakeCallbacks<OddsPayload>,
        signal: AbortSignal,
      ) => {
        oddsConnections += 1;
        if (oddsConnections > 1) await callbacks.onOpen();
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
      streamConnectTimeoutMs: 100,
      reconnectBaseMs: 50,
      now: () => now,
      callbacks: {
        onInput: () => undefined,
        onStatus: (status) => {
          statuses.push(status);
        },
      },
      capture: async () => undefined,
    });

    try {
      const run = worker.run(controller.signal);
      await vi.advanceTimersByTimeAsync(0);
      expect(oddsConnections).toBe(1);

      now = 1_100;
      await vi.advanceTimersByTimeAsync(100);
      expect(worker.status()).toMatchObject({
        reconnects: { odds: 1, scores: 0 },
        streamHealth: { odds: false, scores: true },
        lastStreamFailure: {
          odds: { reason: "stream-connect-timeout", at: 1_100 },
          scores: null,
        },
      });
      expect(
        statuses.some(
          (status) =>
            status.lastStreamFailure?.odds?.reason === "stream-connect-timeout",
        ),
      ).toBe(true);

      await vi.advanceTimersByTimeAsync(49);
      expect(oddsConnections).toBe(1);
      now = 1_150;
      await vi.advanceTimersByTimeAsync(1);
      expect(oddsConnections).toBe(2);
      expect(worker.status().streamHealth.odds).toBe(true);
      expect(worker.status().lastStreamFailure?.odds).toBeNull();

      controller.abort();
      await vi.advanceTimersByTimeAsync(0);
      await run;
      expect(worker.status().reconnects.odds).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not classify parent shutdown as a connection timeout", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const client = {
      fetchFixtures: async () => [],
      streamOdds: async (
        _callbacks: FakeCallbacks<OddsPayload>,
        signal: AbortSignal,
      ) => untilAborted(signal),
      streamScores: async (
        _callbacks: FakeCallbacks<ScorePayload>,
        signal: AbortSignal,
      ) => untilAborted(signal),
    };
    const worker = new TxLineLiveWorker({
      client,
      streamConnectTimeoutMs: 100,
      callbacks: { onInput: () => undefined },
      capture: async () => undefined,
    });

    try {
      const run = worker.run(controller.signal);
      await vi.advanceTimersByTimeAsync(0);
      controller.abort();
      await vi.advanceTimersByTimeAsync(0);
      await run;
      await vi.advanceTimersByTimeAsync(100);

      expect(worker.status()).toMatchObject({
        running: false,
        reconnects: { odds: 0, scores: 0 },
        lastStreamFailure: { odds: null, scores: null },
      });
    } finally {
      vi.useRealTimers();
    }
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
