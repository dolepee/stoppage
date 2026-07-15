import type {
  PublicAgentHandshakeRequest,
  PublicAgentHandshakeResponse,
} from "../execution-gate/public-agent-lab.js";
import type {
  ExecutionGateRequest,
  ExecutionGateResult,
  ExecutionPermit,
} from "../execution-gate/types.js";
import { sha256 } from "../domain/canonical.js";

export interface StoppageAgentClientOptions {
  baseUrl?: string;
  fetch?: typeof fetch;
}

export class StoppageAgentClient {
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;

  constructor(options: StoppageAgentClientOptions = {}) {
    this.#baseUrl = (options.baseUrl ?? "").replace(/\/$/, "");
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  evaluate(
    request: ExecutionGateRequest,
    signal?: AbortSignal,
  ): Promise<ExecutionGateResult> {
    return this.#post("/api/execution-gate/evaluate", request, signal);
  }

  runPublicLab(
    request: PublicAgentHandshakeRequest,
    signal?: AbortSignal,
  ): Promise<PublicAgentHandshakeResponse> {
    return this.#post("/api/agent-gate", request, signal);
  }

  verifyPermitBinding(
    permit: ExecutionPermit | null,
    request: ExecutionGateRequest,
    now: number,
  ): boolean {
    if (!permit || !Number.isInteger(now)) return false;
    const { body } = permit;
    return (
      permit.hash === sha256(body) &&
      body.version === 1 &&
      body.subjectHash === request.subjectHash &&
      body.market === request.market &&
      body.quoteHash === request.quoteHash &&
      body.issuedAt <= now &&
      now < body.expiresAt &&
      body.expiresAt - body.issuedAt === 5_000
    );
  }

  async #post<T>(
    path: string,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    const response = await this.#fetch(`${this.#baseUrl}${path}`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) {
      throw new Error(`Stoppage request failed with HTTP ${response.status}`);
    }
    return (await response.json()) as T;
  }
}
