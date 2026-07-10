import {
  fixtureSchema,
  guestSessionSchema,
  oddsPayloadSchema,
  scorePayloadSchema,
  type Fixture,
  type OddsPayload,
  type ScorePayload,
} from "./types.js";
import {
  scoreStatValidationSchema,
  type ScoreStatValidation,
} from "./validation-types.js";
import { parseSseData, readSseMessages } from "./sse.js";

interface TxLineClientOptions {
  origin: string;
  apiToken?: string | undefined;
  fetchImplementation?: typeof fetch | undefined;
}

interface StreamCallbacks<T> {
  onOpen?: () => void | Promise<void>;
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

  async fetchFixtures(
    options: {
      startEpochDay?: number;
      competitionId?: number;
    } = {},
  ): Promise<Fixture[]> {
    const query = new URLSearchParams();
    if (options.startEpochDay !== undefined) {
      query.set("startEpochDay", String(options.startEpochDay));
    }
    if (options.competitionId !== undefined) {
      query.set("competitionId", String(options.competitionId));
    }
    const suffix = query.size ? `?${query.toString()}` : "";
    const response = await this.#authorizedFetch(
      `/api/fixtures/snapshot${suffix}`,
    );
    return parseResponseArray(response, fixtureSchema);
  }

  async fetchHistoricalScores(fixtureId: number): Promise<ScorePayload[]> {
    const response = await this.#authorizedFetch(
      `/api/scores/historical/${fixtureId}`,
      { signal: AbortSignal.timeout(30_000) },
    );
    return parseResponseArray(response, scorePayloadSchema);
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
      { signal: AbortSignal.timeout(15_000) },
    );
    return parseResponseArray(response, oddsPayloadSchema);
  }

  async fetchScoreStatValidation(input: {
    fixtureId: number;
    seq: number;
    statKey: number;
  }): Promise<ScoreStatValidation> {
    const query = new URLSearchParams({
      fixtureId: String(input.fixtureId),
      seq: String(input.seq),
      statKey: String(input.statKey),
    });
    const response = await this.#authorizedFetch(
      `/api/scores/stat-validation?${query.toString()}`,
    );
    return scoreStatValidationSchema.parse(await response.json());
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
    await callbacks.onOpen?.();

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

async function parseResponseArray<T>(
  response: Response,
  schema: { parse(value: unknown): T },
): Promise<T[]> {
  const body = await response.text();
  try {
    const value = JSON.parse(body) as unknown;
    if (!Array.isArray(value)) {
      throw new Error("TxLINE response was not an array");
    }
    return value.map((item) => schema.parse(item));
  } catch (jsonError) {
    const parsed: T[] = [];
    const sseResponse = new Response(body, {
      headers: { "Content-Type": "text/event-stream" },
    });
    for await (const message of readSseMessages(sseResponse)) {
      if (message.event === "heartbeat") continue;
      const value = parseSseData(message.data);
      if (typeof value === "string") throw jsonError;
      parsed.push(schema.parse(value));
    }
    if (!parsed.length && body.trim()) throw jsonError;
    return parsed;
  }
}
