import {
  fixtureSchema,
  guestSessionSchema,
  oddsPayloadSchema,
  scorePayloadSchema,
  type Fixture,
  type OddsPayload,
  type ScorePayload,
} from "./types.js";
import { parseSseData, readSseMessages } from "./sse.js";

interface TxLineClientOptions {
  origin: string;
  apiToken?: string | undefined;
  fetchImplementation?: typeof fetch | undefined;
}

interface StreamCallbacks<T> {
  onData: (payload: T, eventId?: string) => void | Promise<void>;
  onHeartbeat?: (timestamp: number | null) => void | Promise<void>;
}

export class TxLineClient {
  readonly #origin: string;
  readonly #apiToken: string | undefined;
  readonly #fetch: typeof fetch;
  #jwt?: string;

  constructor(options: TxLineClientOptions) {
    this.#origin = options.origin.replace(/\/$/, "");
    this.#apiToken = options.apiToken;
    this.#fetch = options.fetchImplementation ?? fetch;
  }

  get hasApiToken() {
    return Boolean(this.#apiToken);
  }

  async startGuestSession(): Promise<string> {
    const response = await this.#fetch(`${this.#origin}/auth/guest/start`, {
      method: "POST",
      headers: { Accept: "application/json" },
    });

    if (!response.ok) {
      throw new Error(`TxLINE guest auth failed with HTTP ${response.status}`);
    }

    const session = guestSessionSchema.parse(await response.json());
    this.#jwt = session.token;
    return session.token;
  }

  async fetchFixtures(): Promise<Fixture[]> {
    const response = await this.#authorizedFetch("/api/fixtures/snapshot");
    return fixtureSchema.array().parse(await response.json());
  }

  async fetchHistoricalScores(fixtureId: number): Promise<ScorePayload[]> {
    const response = await this.#authorizedFetch(
      `/api/scores/historical/${fixtureId}`,
    );
    return scorePayloadSchema.array().parse(await response.json());
  }

  async fetchHistoricalOddsInterval(input: {
    epochDay: number;
    hourOfDay: number;
    interval: number;
    fixtureId?: number;
  }): Promise<OddsPayload[]> {
    const query = input.fixtureId
      ? `?fixtureId=${encodeURIComponent(input.fixtureId)}`
      : "";
    const response = await this.#authorizedFetch(
      `/api/odds/updates/${input.epochDay}/${input.hourOfDay}/${input.interval}${query}`,
    );
    return oddsPayloadSchema.array().parse(await response.json());
  }

  async streamOdds(
    callbacks: StreamCallbacks<OddsPayload>,
    signal: AbortSignal,
    fixtureId?: number,
  ): Promise<void> {
    const query = fixtureId
      ? `?fixtureId=${encodeURIComponent(fixtureId)}`
      : "";
    await this.#stream(
      `/api/odds/stream${query}`,
      oddsPayloadSchema,
      callbacks,
      signal,
    );
  }

  async streamScores(
    callbacks: StreamCallbacks<ScorePayload>,
    signal: AbortSignal,
    fixtureId?: number,
  ): Promise<void> {
    const query = fixtureId
      ? `?fixtureId=${encodeURIComponent(fixtureId)}`
      : "";
    await this.#stream(
      `/api/scores/stream${query}`,
      scorePayloadSchema,
      callbacks,
      signal,
    );
  }

  async #stream<T>(
    path: string,
    schema: { parse(value: unknown): T },
    callbacks: StreamCallbacks<T>,
    signal: AbortSignal,
  ) {
    const response = await this.#authorizedFetch(path, {
      signal,
      headers: {
        Accept: "text/event-stream",
        "Cache-Control": "no-cache",
      },
    });

    for await (const message of readSseMessages(response)) {
      if (signal.aborted) return;
      const parsed = parseSseData(message.data);

      if (message.event === "heartbeat") {
        const timestamp =
          typeof parsed === "object" && parsed !== null && "Ts" in parsed
            ? Number((parsed as { Ts: unknown }).Ts)
            : null;
        await callbacks.onHeartbeat?.(
          Number.isFinite(timestamp) ? timestamp : null,
        );
        continue;
      }

      const payload = schema.parse(parsed);
      await callbacks.onData(payload, message.id);
    }
  }

  async #authorizedFetch(
    path: string,
    init: RequestInit = {},
  ): Promise<Response> {
    if (!this.#apiToken) {
      throw new Error(
        "TXLINE_API_TOKEN is required for fixtures, history, and streams",
      );
    }
    if (!this.#jwt) await this.startGuestSession();

    const response = await this.#fetch(`${this.#origin}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.#jwt}`,
        "X-Api-Token": this.#apiToken,
        ...init.headers,
      },
    });

    if (response.status === 401) {
      await this.startGuestSession();
      return this.#authorizedFetch(path, init);
    }

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `TxLINE ${path} failed with HTTP ${response.status}: ${body.slice(0, 300)}`,
      );
    }

    return response;
  }
}
