import { appendPrivateCapture } from "../private/capture-store.js";
import {
  normalize1x2Quote,
  normalizeEventResolution,
  normalizeMatchEvent,
} from "../txline/normalize.js";
import type { Fixture, OddsPayload, ScorePayload } from "../txline/types.js";
import type { LiveWorkerCallbacks, LiveWorkerStatus } from "./types.js";

interface StreamCallbacks<T> {
  onOpen: () => void | Promise<void>;
  onHeartbeat: (timestamp: number | null) => void | Promise<void>;
  onRaw?: (payload: unknown, eventId?: string) => void | Promise<void>;
  onData: (payload: T, eventId?: string) => void | Promise<void>;
}

interface LiveTxLineClient {
  fetchFixtures(options?: { signal?: AbortSignal }): Promise<Fixture[]>;
  streamOdds(
    callbacks: StreamCallbacks<OddsPayload>,
    signal: AbortSignal,
  ): Promise<void>;
  streamScores(
    callbacks: StreamCallbacks<ScorePayload>,
    signal: AbortSignal,
  ): Promise<void>;
}

interface LiveWorkerOptions {
  client: LiveTxLineClient;
  callbacks: LiveWorkerCallbacks;
  heartbeatTimeoutMs?: number;
  streamConnectTimeoutMs?: number;
  reconnectBaseMs?: number;
  fixtureRefreshMs?: number;
  now?: () => number;
  capture?: (name: string, value: unknown) => Promise<unknown>;
}

type StreamAbortReason = "heartbeat-timeout" | "stream-connect-timeout";

interface ActiveStreamAttempt {
  abortReason: StreamAbortReason | null;
  failureRecorded: boolean;
  controller: AbortController;
}

export class TxLineLiveWorker {
  readonly #client: LiveTxLineClient;
  readonly #callbacks: LiveWorkerCallbacks;
  readonly #heartbeatTimeoutMs: number;
  readonly #streamConnectTimeoutMs: number;
  readonly #reconnectBaseMs: number;
  readonly #fixtureRefreshMs: number;
  readonly #now: () => number;
  readonly #capture: (name: string, value: unknown) => Promise<unknown>;
  readonly #participants = new Map<number, { home: string; away: string }>();
  readonly #activeStreamAttempts: Record<
    "odds" | "scores",
    ActiveStreamAttempt | null
  > = { odds: null, scores: null };
  #status: LiveWorkerStatus = emptyStatus();
  #lastHealthEmission = { odds: true, scores: true };

  constructor(options: LiveWorkerOptions) {
    this.#client = options.client;
    this.#callbacks = options.callbacks;
    this.#heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? 45_000;
    this.#streamConnectTimeoutMs = options.streamConnectTimeoutMs ?? 30_000;
    this.#reconnectBaseMs = options.reconnectBaseMs ?? 1_000;
    this.#fixtureRefreshMs = options.fixtureRefreshMs ?? 300_000;
    this.#now = options.now ?? Date.now;
    this.#capture = options.capture ?? appendPrivateCapture;
  }

  status(): LiveWorkerStatus {
    return structuredClone(this.#status);
  }

  async run(signal: AbortSignal): Promise<void> {
    if (this.#status.running)
      throw new Error("TxLINE live worker is already running");
    this.#status = {
      ...emptyStatus(),
      running: true,
      startedAt: new Date().toISOString(),
    };
    this.#lastHealthEmission = { odds: true, scores: true };

    try {
      await this.#refreshFixtures(signal);
      await this.#setHealth("odds", false, "stream-connecting");
      await this.#setHealth("scores", false, "stream-connecting");
      await this.#publishStatus();

      const monitor = this.#monitorHealth(signal);
      const fixtureRefresh = this.#refreshFixtureLoop(signal);
      await Promise.all([
        this.#runStream("odds", signal),
        this.#runStream("scores", signal),
        monitor,
        fixtureRefresh,
      ]);
    } finally {
      this.#status.running = false;
      await this.#publishStatus();
    }
  }

  #loadParticipants(fixtures: Fixture[]) {
    for (const fixture of fixtures) {
      if (!fixture.Participant1 || !fixture.Participant2) continue;
      const participant1IsHome = fixture.Participant1IsHome !== false;
      this.#participants.set(fixture.FixtureId, {
        home: participant1IsHome ? fixture.Participant1 : fixture.Participant2,
        away: participant1IsHome ? fixture.Participant2 : fixture.Participant1,
      });
    }
  }

  async #refreshFixtures(signal: AbortSignal) {
    try {
      const fixtures = await this.#client.fetchFixtures({ signal });
      this.#loadParticipants(fixtures);
      this.#status.fixturesLoaded = this.#participants.size;
      this.#status.fixtureRefreshes += 1;
      this.#status.lastFixtureRefreshAt = this.#now();
      this.#status.lastFixtureRefreshFailure = null;
    } catch (error) {
      if (!signal.aborted && (error as Error).name !== "AbortError") {
        this.#status.fixtureRefreshFailures += 1;
        this.#status.lastFixtureRefreshFailure = {
          reason: `fixture-refresh-error:${safeErrorReason(error)}`,
          at: this.#now(),
        };
      }
      throw error;
    }
  }

  async #refreshFixtureLoop(signal: AbortSignal) {
    while (!signal.aborted) {
      await abortableDelay(this.#fixtureRefreshMs, signal);
      if (signal.aborted) break;
      try {
        await this.#refreshFixtures(signal);
      } catch (error) {
        if (signal.aborted || (error as Error).name === "AbortError") break;
      }
      await this.#publishStatus();
    }
  }

  async #runStream(name: "odds" | "scores", signal: AbortSignal) {
    let attempt = 0;
    while (!signal.aborted) {
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal.addEventListener("abort", abort, { once: true });
      let connected = false;
      const activeAttempt: ActiveStreamAttempt = {
        abortReason: null,
        failureRecorded: false,
        controller,
      };
      this.#activeStreamAttempts[name] = activeAttempt;
      const connectTimeout = setTimeout(() => {
        if (connected || signal.aborted) return;
        activeAttempt.abortReason = "stream-connect-timeout";
        controller.abort();
      }, this.#streamConnectTimeoutMs);
      const markConnected = () => {
        if (
          controller.signal.aborted ||
          this.#activeStreamAttempts[name] !== activeAttempt
        ) {
          return false;
        }
        connected = true;
        clearTimeout(connectTimeout);
        return true;
      };
      try {
        if (name === "odds") {
          await this.#client.streamOdds(
            {
              onOpen: () => {
                if (!markConnected()) return;
                return this.#touch(name);
              },
              onHeartbeat: () => {
                if (!markConnected()) return;
                attempt = 0;
                return this.#touch(name);
              },
              onRaw: (payload, eventId) => {
                if (
                  controller.signal.aborted ||
                  this.#activeStreamAttempts[name] !== activeAttempt
                ) {
                  return;
                }
                return this.#captureRaw(name, payload, eventId);
              },
              onData: (payload) => {
                if (!markConnected()) return;
                attempt = 0;
                return this.#handleOdds(payload);
              },
            },
            controller.signal,
          );
        } else {
          await this.#client.streamScores(
            {
              onOpen: () => {
                if (!markConnected()) return;
                return this.#touch(name);
              },
              onHeartbeat: () => {
                if (!markConnected()) return;
                attempt = 0;
                return this.#touch(name);
              },
              onRaw: (payload, eventId) => {
                if (
                  controller.signal.aborted ||
                  this.#activeStreamAttempts[name] !== activeAttempt
                ) {
                  return;
                }
                return this.#captureRaw(name, payload, eventId);
              },
              onData: (payload) => {
                if (!markConnected()) return;
                attempt = 0;
                return this.#handleScore(payload);
              },
            },
            controller.signal,
          );
        }
        if (!signal.aborted) {
          this.#status.reconnects[name] += 1;
          const reason = activeAttempt.abortReason ?? "stream-closed";
          if (!activeAttempt.failureRecorded) {
            this.#recordStreamFailure(name, reason);
            activeAttempt.failureRecorded = true;
            await this.#setHealth(name, false, reason);
          }
          await this.#publishStatus();
          attempt += 1;
        }
      } catch (error) {
        if (signal.aborted) return;
        this.#status.reconnects[name] += 1;
        const reason =
          activeAttempt.abortReason ?? `stream-error:${safeErrorReason(error)}`;
        if (!activeAttempt.failureRecorded) {
          this.#recordStreamFailure(name, reason);
          activeAttempt.failureRecorded = true;
          await this.#setHealth(name, false, reason);
        }
        await this.#publishStatus();
        attempt += 1;
      } finally {
        clearTimeout(connectTimeout);
        if (this.#activeStreamAttempts[name] === activeAttempt) {
          this.#activeStreamAttempts[name] = null;
        }
        signal.removeEventListener("abort", abort);
      }

      if (!signal.aborted) {
        const backoff = Math.min(
          this.#reconnectBaseMs * 2 ** Math.max(0, attempt - 1),
          30_000,
        );
        await abortableDelay(backoff, signal);
      }
    }
  }

  async #handleOdds(payload: OddsPayload) {
    const receivedAt = this.#now();
    await this.#touch("odds", receivedAt);
    this.#status.oddsMessages += 1;
    const participants = this.#participants.get(payload.FixtureId);
    if (!participants) {
      this.#status.skippedOdds += 1;
      return;
    }
    const input = normalize1x2Quote(payload, participants, receivedAt);
    if (!input) {
      this.#status.skippedOdds += 1;
      return;
    }
    this.#status.normalizedOdds += 1;
    await this.#callbacks.onInput(input);
  }

  async #handleScore(payload: ScorePayload) {
    const receivedAt = this.#now();
    await this.#touch("scores", receivedAt);
    this.#status.scoreMessages += 1;
    const inputs = [
      normalizeMatchEvent(payload, receivedAt),
      normalizeEventResolution(payload, receivedAt),
    ].filter((input) => input !== null);
    for (const input of inputs) {
      this.#status.normalizedEvents += 1;
      await this.#callbacks.onInput(input);
    }
  }

  async #captureRaw(
    stream: "odds" | "scores",
    payload: unknown,
    eventId?: string,
  ) {
    await this.#capture(captureName(), {
      stream,
      receivedAt: this.#now(),
      ...(eventId ? { eventId } : {}),
      payload,
    });
  }

  async #touch(name: "odds" | "scores", timestamp = this.#now()) {
    const recovered =
      !this.#status.streamHealth[name] ||
      Boolean(this.#status.lastStreamFailure?.[name]);
    this.#status.lastMessageAt[name] = timestamp;
    this.#status.lastStreamFailure![name] = null;
    await this.#setHealth(name, true);
    if (recovered) await this.#publishStatus();
  }

  async #monitorHealth(signal: AbortSignal) {
    while (!signal.aborted) {
      await abortableDelay(1_000, signal);
      if (signal.aborted) break;
      const now = this.#now();
      for (const name of ["odds", "scores"] as const) {
        const lastMessage = this.#status.lastMessageAt[name];
        if (
          this.#status.streamHealth[name] &&
          lastMessage !== null &&
          now - lastMessage > this.#heartbeatTimeoutMs
        ) {
          const activeAttempt = this.#activeStreamAttempts[name];
          if (activeAttempt && !activeAttempt.controller.signal.aborted) {
            activeAttempt.abortReason = "heartbeat-timeout";
            activeAttempt.failureRecorded = true;
            this.#recordStreamFailure(name, "heartbeat-timeout");
            const healthUpdate = this.#setHealth(
              name,
              false,
              "heartbeat-timeout",
            );
            activeAttempt.controller.abort();
            await healthUpdate;
          }
        }
      }
      await this.#callbacks.onInput({ kind: "tick", observedTs: now });
      await this.#publishStatus();
    }
  }

  async #setHealth(name: "odds" | "scores", healthy: boolean, reason?: string) {
    this.#status.streamHealth[name] = healthy;
    if (this.#lastHealthEmission[name] === healthy) return;
    this.#lastHealthEmission[name] = healthy;
    await this.#callbacks.onInput({
      kind: "stream-health",
      stream: name,
      healthy,
      observedTs: this.#now(),
      ...(reason ? { reason } : {}),
    });
  }

  #recordStreamFailure(name: "odds" | "scores", reason: string) {
    this.#status.lastStreamFailure![name] = {
      reason,
      at: this.#now(),
    };
  }

  async #publishStatus() {
    await this.#callbacks.onStatus?.(this.status());
  }
}

function emptyStatus(): LiveWorkerStatus {
  return {
    running: false,
    fixturesLoaded: 0,
    oddsMessages: 0,
    scoreMessages: 0,
    normalizedOdds: 0,
    normalizedEvents: 0,
    skippedOdds: 0,
    reconnects: { odds: 0, scores: 0 },
    fixtureRefreshes: 0,
    fixtureRefreshFailures: 0,
    lastFixtureRefreshAt: null,
    lastFixtureRefreshFailure: null,
    streamHealth: { odds: false, scores: false },
    lastMessageAt: { odds: null, scores: null },
    lastStreamFailure: { odds: null, scores: null },
    startedAt: null,
  };
}

function safeErrorReason(error: unknown) {
  const name =
    error instanceof Error && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(error.name)
      ? error.name
      : "UnknownError";
  const status =
    error instanceof Error
      ? /\bHTTP\s+(\d{3})\b/.exec(error.message)?.[1]
      : null;
  return status ? `${name}:HTTP_${status}` : name;
}

function captureName() {
  return `live-${new Date().toISOString().slice(0, 10)}.jsonl`;
}

function abortableDelay(milliseconds: number, signal: AbortSignal) {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal.removeEventListener("abort", settle);
      resolve();
    };
    const timeout = setTimeout(settle, milliseconds);
    signal.addEventListener("abort", settle, { once: true });
  });
}
