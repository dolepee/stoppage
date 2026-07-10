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
  fetchFixtures(): Promise<Fixture[]>;
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
  reconnectBaseMs?: number;
  now?: () => number;
  capture?: (name: string, value: unknown) => Promise<unknown>;
}

export class TxLineLiveWorker {
  readonly #client: LiveTxLineClient;
  readonly #callbacks: LiveWorkerCallbacks;
  readonly #heartbeatTimeoutMs: number;
  readonly #reconnectBaseMs: number;
  readonly #now: () => number;
  readonly #capture: (name: string, value: unknown) => Promise<unknown>;
  readonly #participants = new Map<number, { home: string; away: string }>();
  #status: LiveWorkerStatus = emptyStatus();
  #lastHealthEmission = { odds: true, scores: true };

  constructor(options: LiveWorkerOptions) {
    this.#client = options.client;
    this.#callbacks = options.callbacks;
    this.#heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? 45_000;
    this.#reconnectBaseMs = options.reconnectBaseMs ?? 1_000;
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

    const fixtures = await this.#client.fetchFixtures();
    this.#loadParticipants(fixtures);
    this.#status.fixturesLoaded = this.#participants.size;
    await this.#setHealth("odds", false, "stream-connecting");
    await this.#setHealth("scores", false, "stream-connecting");
    await this.#publishStatus();

    const monitor = this.#monitorHealth(signal);
    await Promise.all([
      this.#runStream("odds", signal),
      this.#runStream("scores", signal),
      monitor,
    ]);
    this.#status.running = false;
    await this.#publishStatus();
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

  async #runStream(name: "odds" | "scores", signal: AbortSignal) {
    let attempt = 0;
    while (!signal.aborted) {
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal.addEventListener("abort", abort, { once: true });
      try {
        if (name === "odds") {
          await this.#client.streamOdds(
            {
              onOpen: () => this.#touch(name),
              onHeartbeat: () => this.#touch(name),
              onRaw: (payload, eventId) =>
                this.#captureRaw(name, payload, eventId),
              onData: (payload) => this.#handleOdds(payload),
            },
            controller.signal,
          );
        } else {
          await this.#client.streamScores(
            {
              onOpen: () => this.#touch(name),
              onHeartbeat: () => this.#touch(name),
              onRaw: (payload, eventId) =>
                this.#captureRaw(name, payload, eventId),
              onData: (payload) => this.#handleScore(payload),
            },
            controller.signal,
          );
        }
        if (!signal.aborted) {
          this.#status.reconnects[name] += 1;
          await this.#setHealth(name, false, "stream-closed");
          attempt += 1;
        }
      } catch (error) {
        if (signal.aborted || (error as Error).name === "AbortError") return;
        this.#status.reconnects[name] += 1;
        await this.#setHealth(
          name,
          false,
          `stream-error:${(error as Error).name}`,
        );
        attempt += 1;
      } finally {
        signal.removeEventListener("abort", abort);
      }

      if (!signal.aborted) {
        const backoff = Math.min(this.#reconnectBaseMs * 2 ** attempt, 30_000);
        await abortableDelay(backoff, signal);
      }
    }
  }

  async #handleOdds(payload: OddsPayload) {
    const receivedAt = this.#now();
    await this.#touch("odds", receivedAt);
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
    this.#status.lastMessageAt[name] = timestamp;
    await this.#setHealth(name, true);
  }

  async #monitorHealth(signal: AbortSignal) {
    while (!signal.aborted) {
      await abortableDelay(1_000, signal);
      if (signal.aborted) break;
      const now = this.#now();
      for (const name of ["odds", "scores"] as const) {
        const lastMessage = this.#status.lastMessageAt[name];
        if (
          lastMessage !== null &&
          now - lastMessage > this.#heartbeatTimeoutMs
        ) {
          await this.#setHealth(name, false, "heartbeat-timeout");
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

  async #publishStatus() {
    await this.#callbacks.onStatus?.(this.status());
  }
}

function emptyStatus(): LiveWorkerStatus {
  return {
    running: false,
    fixturesLoaded: 0,
    normalizedOdds: 0,
    normalizedEvents: 0,
    skippedOdds: 0,
    reconnects: { odds: 0, scores: 0 },
    streamHealth: { odds: false, scores: false },
    lastMessageAt: { odds: null, scores: null },
    startedAt: null,
  };
}

function captureName() {
  return `live-${new Date().toISOString().slice(0, 10)}.jsonl`;
}

function abortableDelay(milliseconds: number, signal: AbortSignal) {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, milliseconds);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true },
    );
  });
}
