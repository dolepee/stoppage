import type {
  PublicAgentHandshakeRequest,
  PublicAgentHandshakeResponse,
} from "../execution-gate/public-agent-lab.js";
import type {
  ExecutionGateRequest,
  ExecutionGateResult,
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
    result: ExecutionGateResult,
    request: ExecutionGateRequest,
    now: number,
  ): boolean {
    try {
      const permit = result.permit;
      if (
        !permit ||
        !Number.isInteger(now) ||
        now < 0 ||
        request.version !== 1 ||
        request.command !== "PUBLISH_QUOTE" ||
        !isHash(request.subjectHash) ||
        request.market !== "1X2" ||
        !isHash(request.quoteHash) ||
        result.version !== 1 ||
        result.command !== request.command ||
        (result.decision !== "ALLOW_HEALTHY_QUOTE" &&
          result.decision !== "ALLOW_CERTIFIED_REOPEN") ||
        !Number.isInteger(result.evaluatedAt) ||
        result.evaluatedAt < 0 ||
        !Number.isInteger(result.sequence) ||
        result.sequence < 1
      ) {
        return false;
      }

      const { body } = permit;
      if (
        permit.hash !== sha256(body) ||
        !isHash(permit.hash) ||
        body.version !== 1 ||
        body.decision !== result.decision ||
        body.reason !== result.reason ||
        body.subjectHash !== request.subjectHash ||
        body.market !== request.market ||
        body.quoteHash !== request.quoteHash ||
        !isHash(body.subjectHash) ||
        !isHash(body.quoteHash) ||
        !isHash(body.configHash) ||
        (body.stateReceiptHash !== null && !isHash(body.stateReceiptHash)) ||
        (body.reopenProofHash !== null && !isHash(body.reopenProofHash)) ||
        body.sequence !== result.sequence ||
        body.issuedAt !== result.evaluatedAt ||
        !Number.isInteger(body.issuedAt) ||
        !Number.isInteger(body.expiresAt) ||
        body.issuedAt < 0 ||
        body.issuedAt > now ||
        now >= body.expiresAt ||
        body.expiresAt - body.issuedAt !== 5_000
      ) {
        return false;
      }

      if (body.decision === "ALLOW_CERTIFIED_REOPEN") {
        return isHash(body.stateReceiptHash) && isHash(body.reopenProofHash);
      }

      return body.reopenProofHash === null;
    } catch {
      return false;
    }
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

function isHash(value: unknown): value is string {
  return typeof value === "string" && /^0x[0-9a-f]{64}$/.test(value);
}
