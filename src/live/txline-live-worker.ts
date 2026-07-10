import { appendPrivateCapture } from "../private/capture-store.js";
import { normalize1x2Quote, normalizeMatchEvent } from "../txline/normalize.js";
import type { Fixture, OddsPayload, ScorePayload } from "../txline/types.js";
import type { LiveWorkerCallbacks, LiveWorkerStatus } from "./types.js";

interface StreamCallbacks<T> {
  onOpen: () => void | Promise<void>;
  onHeartbeat: (timestamp: number | null) => void | Promise<void>;
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
    this.#heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? 20_000;
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

    const fixtures = await this.#client.fetchFixtures();
    this.#loadParticipants(fixtures);
    this.#status.fixturesLoaded = this.#participants.size;
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
              onData: (payload) => this.#handleOdds(payload),
            },
            controller.signal,
          );
        } else {
          await this.#client.streamScores(
            {
              onOpen: () => this.#touch(name),
              onHeartbeat: () => this.#touch(name),
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
    this.#touch("odds", receivedAt);
    await this.#capture(captureName(), {
      stream: "odds",
      receivedAt,
      payload,
    });
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
    this.#touch("scores", receivedAt);
    await this.#capture(captureName(), {
      stream: "scores",
      receivedAt,
      payload,
    });
    const input = normalizeMatchEvent(payload, receivedAt);
    if (!input) return;
    this.#status.normalizedEvents += 1;
    await this.#callbacks.onInput(input);
  }

  #touch(name: "odds" | "scores", timestamp = this.#now()) {
    this.#status.lastMessageAt[name] = timestamp;
    void this.#setHealth(name, true);
  }

  async #monitorHealth(signal: AbortSignal) {
    while (!signal.aborted) {
      await abortableDelay(1_000, signal);
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
    streamHealth: { odds: true, scores: true },
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
