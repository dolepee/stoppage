import { sha256 as sha256Digest } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import nacl from "tweetnacl";

export const STOPPAGE_PERMIT_MAX_CLOCK_SKEW_MS = 1_000;

export type GateDecision =
  | "BLOCK_UNRESOLVED_INCIDENT"
  | "BLOCK_INVALIDATED_BRANCH"
  | "BLOCK_STREAM_UNHEALTHY"
  | "BLOCK_QUOTE_STALE"
  | "BLOCK_PERMIT_EXPIRED"
  | "ALLOW_HEALTHY_QUOTE"
  | "ALLOW_CERTIFIED_REOPEN";

export type VerificationDecision =
  | "ALLOW"
  | "BLOCK_GATE_UNAVAILABLE"
  | "BLOCK_GATE_DECISION"
  | "BLOCK_KEY_DISCOVERY_FAILED"
  | "BLOCK_PERMIT_MALFORMED"
  | "BLOCK_UNKNOWN_SIGNING_KEY"
  | "BLOCK_SIGNATURE_INVALID"
  | "BLOCK_BINDING_INVALID"
  | "BLOCK_AUDIENCE_MISMATCH"
  | "BLOCK_PERMIT_EXPIRED"
  | "BLOCK_NONCE_REPLAY";

export type BenchLiteAttack =
  | "QUOTE_TAMPER"
  | "RECEIPT_TAMPER"
  | "EXPIRED_REPLAY"
  | "WRONG_AUDIENCE"
  | "UNKNOWN_SIGNING_KEY"
  | "REUSED_NONCE";

export interface ExecutionIntent {
  version: 2;
  agentId: string;
  audience: string;
  nonce: string;
  command: "PUBLISH_QUOTE";
  sequence: number;
  subjectHash: string;
  market: "1X2";
  quoteHash: string;
}

export interface ExecutionPermitV2Body {
  version: 2;
  issuer: string;
  kid: string;
  agentId: string;
  audience: string;
  nonce: string;
  command: "PUBLISH_QUOTE";
  decision: "ALLOW_HEALTHY_QUOTE" | "ALLOW_CERTIFIED_REOPEN";
  reason: string;
  subjectHash: string;
  market: "1X2";
  quoteHash: string;
  configHash: string;
  stateReceiptHash: string | null;
  reopenProofHash: string | null;
  sequence: number;
  issuedAt: number;
  expiresAt: number;
}

export interface SignedExecutionPermitV2 {
  alg: "Ed25519";
  body: ExecutionPermitV2Body;
  hash: string;
  signature: string;
}

export interface PermitVerificationKey {
  kid: string;
  alg: "Ed25519";
  use: "sig";
  publicKey: string;
  status: "ACTIVE" | "RETIRED";
}

export interface PermitVerificationKeySet {
  version: 1;
  issuer: string;
  keys: PermitVerificationKey[];
}

export interface PublicAgentContext {
  version: 2;
  dataMode: "SYNTHETIC";
  scenario: string;
  sequence: number;
  subjectHash: string;
  market: "1X2";
  quoteHash: string;
}

export interface ExecutionGateResultV2 {
  version: 2;
  command: "PUBLISH_QUOTE";
  decision: GateDecision;
  reason: string;
  evaluatedAt: number;
  sequence: number;
  permit: SignedExecutionPermitV2 | null;
}

export interface PublicAgentResponseV2 {
  version: 2;
  dataMode: "SYNTHETIC";
  scenario: string;
  agent: { id: string; automated: true };
  transport: {
    protocol: "HTTPS";
    endpoint: "/api/agent-gate";
    keyEndpoint: "/api/permit-keys";
    requestId: string;
  };
  request: ExecutionIntent;
  result: ExecutionGateResultV2;
  challenge: {
    challenge: BenchLiteAttack;
    expected: "REJECT";
    valid: boolean;
    decision: VerificationDecision | GateDecision;
    reason: string;
  } | null;
}

export interface PermitVerificationResult {
  valid: boolean;
  decision: VerificationDecision;
  reason: string;
}

export interface BenchLiteResult extends PermitVerificationResult {
  challenge: BenchLiteAttack;
  expected: "REJECT";
}

export interface NonceRegistry {
  has(value: string): boolean;
}

export interface VerifyPermitOptions {
  permit: SignedExecutionPermitV2;
  intent: ExecutionIntent;
  keys: PermitVerificationKeySet;
  now?: number;
  usedNonces?: NonceRegistry;
}

export type GuardActionResult<T> =
  | {
      status: "VENUE_CALL_EXECUTED";
      response: PublicAgentResponseV2;
      verification: PermitVerificationResult & { valid: true };
      value: T;
    }
  | {
      status: "VENUE_CALL_WITHHELD";
      response: PublicAgentResponseV2 | null;
      verification: PermitVerificationResult & { valid: false };
    };

export interface StoppageClientOptions {
  baseUrl?: string;
  fetch?: typeof fetch;
  keySet?: PermitVerificationKeySet;
}

// Shared by every client created from this loaded SDK module. This closes
// same-runtime replay across client instances without implying durable or
// distributed replay protection.
const sharedUsedNonces = new Map<string, number>();

export class StoppageClient {
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #usedNonces = sharedUsedNonces;
  #keySet: PermitVerificationKeySet | null;

  constructor(options: StoppageClientOptions = {}) {
    this.#baseUrl = (options.baseUrl ?? "").replace(/\/$/, "");
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#keySet = options.keySet ?? null;
  }

  evaluate(
    intent: ExecutionIntent,
    signal?: AbortSignal,
  ): Promise<PublicAgentResponseV2> {
    return this.#request<PublicAgentResponseV2>(
      "/api/agent-gate",
      { method: "POST", body: intent },
      signal,
    );
  }

  runBenchLiteCheck(
    intent: ExecutionIntent,
    challenge: BenchLiteAttack,
    signal?: AbortSignal,
  ): Promise<PublicAgentResponseV2> {
    return this.#request<PublicAgentResponseV2>(
      "/api/agent-gate",
      { method: "POST", body: { ...intent, challenge } },
      signal,
    );
  }

  discoverContext(signal?: AbortSignal): Promise<PublicAgentContext> {
    return this.#request<PublicAgentContext>(
      "/api/agent-context",
      { method: "GET", cache: "no-store" },
      signal,
    );
  }

  async discoverKeys(signal?: AbortSignal): Promise<PermitVerificationKeySet> {
    const keys = await this.#request<PermitVerificationKeySet>(
      "/api/permit-keys",
      { method: "GET", cache: "no-store" },
      signal,
    );
    this.#keySet = keys;
    return keys;
  }

  verifyPermit(
    permit: SignedExecutionPermitV2,
    intent: ExecutionIntent,
    keys: PermitVerificationKeySet,
    now = Date.now(),
  ): PermitVerificationResult {
    this.#pruneUsedNonces(now);
    return verifyPermit({
      permit,
      intent,
      keys,
      now,
      usedNonces: this.#usedNonces,
    });
  }

  async guardAction<T>(
    intent: ExecutionIntent,
    callback: () => T | Promise<T>,
    signal?: AbortSignal,
  ): Promise<GuardActionResult<T>> {
    let response: PublicAgentResponseV2;
    try {
      response = await this.evaluate(intent, signal);
    } catch {
      return withheld(
        null,
        "BLOCK_GATE_UNAVAILABLE",
        "The Stoppage gate is unavailable; the venue callback remains closed.",
      );
    }

    if (
      response.version !== 2 ||
      !response.result.decision.startsWith("ALLOW_") ||
      !response.result.permit
    ) {
      return withheld(
        response,
        "BLOCK_GATE_DECISION",
        response.result.reason || "Stoppage did not authorize the action.",
      );
    }

    let keys = this.#keySet;
    if (!keys) {
      try {
        keys = await this.discoverKeys(signal);
      } catch {
        return withheld(
          response,
          "BLOCK_KEY_DISCOVERY_FAILED",
          "Signing keys could not be discovered; the venue callback remains closed.",
        );
      }
    }

    let verification = this.verifyPermit(response.result.permit, intent, keys);
    if (verification.decision === "BLOCK_UNKNOWN_SIGNING_KEY") {
      try {
        keys = await this.discoverKeys(signal);
        verification = this.verifyPermit(response.result.permit, intent, keys);
      } catch {
        return withheld(
          response,
          "BLOCK_KEY_DISCOVERY_FAILED",
          "Signing keys could not be refreshed; the venue callback remains closed.",
        );
      }
    }
    if (!verification.valid) {
      return {
        status: "VENUE_CALL_WITHHELD",
        response,
        verification: { ...verification, valid: false },
      };
    }
    if (
      response.result.sequence !== response.result.permit.body.sequence ||
      response.result.evaluatedAt !== response.result.permit.body.issuedAt ||
      response.result.reason !== response.result.permit.body.reason ||
      response.result.decision !== response.result.permit.body.decision
    ) {
      return withheld(
        response,
        "BLOCK_BINDING_INVALID",
        "The gate response and signed permit disagree.",
      );
    }

    // Claim the nonce synchronously before callback invocation. Every client
    // from this loaded SDK module observes the claim before a callback can run.
    this.#usedNonces.set(
      nonceKey(response.result.permit.body),
      response.result.permit.body.expiresAt,
    );
    const value = await callback();
    return {
      status: "VENUE_CALL_EXECUTED",
      response,
      verification: { ...verification, valid: true },
      value,
    };
  }

  #pruneUsedNonces(now: number): void {
    for (const [key, expiresAt] of this.#usedNonces) {
      if (expiresAt <= now) this.#usedNonces.delete(key);
    }
  }

  async #request<T>(
    path: string,
    options: {
      method: "GET" | "POST";
      body?: unknown;
      cache?: RequestCache;
    },
    signal?: AbortSignal,
  ): Promise<T> {
    const response = await this.#fetch(`${this.#baseUrl}${path}`, {
      method: options.method,
      headers: {
        Accept: "application/json",
        ...(options.body ? { "Content-Type": "application/json" } : {}),
      },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
      ...(options.cache ? { cache: options.cache } : {}),
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) {
      throw new Error(`Stoppage request failed with HTTP ${response.status}`);
    }
    return (await response.json()) as T;
  }
}

export function runBenchLite({
  permit,
  intent,
  keys,
  now = permit.body.issuedAt,
}: Omit<VerifyPermitOptions, "usedNonces">): BenchLiteResult[] {
  const attacks: BenchLiteAttack[] = [
    "QUOTE_TAMPER",
    "RECEIPT_TAMPER",
    "EXPIRED_REPLAY",
    "WRONG_AUDIENCE",
    "UNKNOWN_SIGNING_KEY",
    "REUSED_NONCE",
  ];

  return attacks.map((challenge) => {
    const candidate: SignedExecutionPermitV2 = {
      ...permit,
      body: { ...permit.body },
    };
    const expected: ExecutionIntent = { ...intent };
    const usedNonces = new Set<string>();
    let verificationTime = now;

    if (challenge === "QUOTE_TAMPER") {
      candidate.body.quoteHash = differentHash(candidate.body.quoteHash);
    } else if (challenge === "RECEIPT_TAMPER") {
      candidate.body.stateReceiptHash = differentHash(
        candidate.body.stateReceiptHash ?? candidate.hash,
      );
    } else if (challenge === "EXPIRED_REPLAY") {
      verificationTime = candidate.body.expiresAt;
    } else if (challenge === "WRONG_AUDIENCE") {
      expected.audience = differentAudience(expected.audience);
    } else if (challenge === "UNKNOWN_SIGNING_KEY") {
      candidate.body.kid = "stp_unknown000000";
    } else {
      usedNonces.add(nonceKey(candidate.body));
    }

    return {
      challenge,
      expected: "REJECT",
      ...verifyPermit({
        permit: candidate,
        intent: expected,
        keys,
        now: verificationTime,
        usedNonces,
      }),
    };
  });
}

export function verifyPermit({
  permit,
  intent,
  keys,
  now = Date.now(),
  usedNonces,
}: VerifyPermitOptions): PermitVerificationResult {
  try {
    if (!validPermitShape(permit) || !validIntentShape(intent)) {
      return blocked(
        "BLOCK_PERMIT_MALFORMED",
        "The signed permit or intended action is malformed.",
      );
    }
    if (keys.version !== 1 || keys.issuer !== permit.body.issuer) {
      return blocked(
        "BLOCK_UNKNOWN_SIGNING_KEY",
        "The permit issuer is not present in the trusted key set.",
      );
    }
    const key = keys.keys.find(
      (candidate) =>
        candidate.kid === permit.body.kid &&
        candidate.alg === "Ed25519" &&
        candidate.use === "sig" &&
        candidate.status === "ACTIVE",
    );
    if (!key) {
      return blocked(
        "BLOCK_UNKNOWN_SIGNING_KEY",
        "The permit signing key is unknown.",
      );
    }
    const publicKey = decodeBase64Url(key.publicKey);
    const signature = decodeBase64Url(permit.signature);
    if (
      publicKey.length !== nacl.sign.publicKeyLength ||
      signature.length !== nacl.sign.signatureLength ||
      !nacl.sign.detached.verify(
        signingBytes(permit.body),
        signature,
        publicKey,
      )
    ) {
      return blocked(
        "BLOCK_SIGNATURE_INVALID",
        "The Ed25519 permit signature is invalid.",
      );
    }
    if (permit.hash !== hashCanonical(permit.body)) {
      return blocked(
        "BLOCK_BINDING_INVALID",
        "The permit hash does not bind the signed body.",
      );
    }
    if (permit.body.audience !== intent.audience) {
      return blocked(
        "BLOCK_AUDIENCE_MISMATCH",
        "The permit was issued for a different audience.",
      );
    }
    if (
      permit.body.agentId !== intent.agentId ||
      permit.body.nonce !== intent.nonce ||
      permit.body.command !== intent.command ||
      permit.body.subjectHash !== intent.subjectHash ||
      permit.body.market !== intent.market ||
      permit.body.quoteHash !== intent.quoteHash ||
      permit.body.sequence !== intent.sequence
    ) {
      return blocked(
        "BLOCK_BINDING_INVALID",
        "The permit does not bind the exact intended venue action.",
      );
    }
    if (
      !Number.isInteger(now) ||
      now + STOPPAGE_PERMIT_MAX_CLOCK_SKEW_MS < permit.body.issuedAt ||
      permit.body.expiresAt !== permit.body.issuedAt + 5_000 ||
      now >= permit.body.expiresAt
    ) {
      return blocked("BLOCK_PERMIT_EXPIRED", "The permit has expired.");
    }
    if (usedNonces?.has(nonceKey(permit.body))) {
      return blocked(
        "BLOCK_NONCE_REPLAY",
        "The one-use request nonce has already been consumed.",
      );
    }
    return {
      valid: true,
      decision: "ALLOW",
      reason: "The signed permit authorizes this exact action.",
    };
  } catch {
    return blocked(
      "BLOCK_PERMIT_MALFORMED",
      "The signed permit could not be decoded safely.",
    );
  }
}

function validPermitShape(permit: SignedExecutionPermitV2): boolean {
  const { body } = permit;
  return (
    permit.alg === "Ed25519" &&
    body.version === 2 &&
    body.issuer.length >= 3 &&
    body.kid.length >= 8 &&
    validAgentId(body.agentId) &&
    validAudience(body.audience) &&
    validNonce(body.nonce) &&
    body.command === "PUBLISH_QUOTE" &&
    (body.decision === "ALLOW_HEALTHY_QUOTE" ||
      body.decision === "ALLOW_CERTIFIED_REOPEN") &&
    isHash(body.subjectHash) &&
    body.market === "1X2" &&
    isHash(body.quoteHash) &&
    isHash(body.configHash) &&
    (body.stateReceiptHash === null || isHash(body.stateReceiptHash)) &&
    (body.reopenProofHash === null || isHash(body.reopenProofHash)) &&
    Number.isInteger(body.sequence) &&
    body.sequence >= 1 &&
    Number.isInteger(body.issuedAt) &&
    Number.isInteger(body.expiresAt) &&
    isHash(permit.hash) &&
    typeof permit.signature === "string"
  );
}

function validIntentShape(intent: ExecutionIntent): boolean {
  return (
    intent.version === 2 &&
    validAgentId(intent.agentId) &&
    validAudience(intent.audience) &&
    validNonce(intent.nonce) &&
    intent.command === "PUBLISH_QUOTE" &&
    Number.isInteger(intent.sequence) &&
    intent.sequence >= 1 &&
    isHash(intent.subjectHash) &&
    intent.market === "1X2" &&
    isHash(intent.quoteHash)
  );
}

function differentHash(value: string): string {
  const replacement = value.endsWith("0") ? "1" : "0";
  return `${value.slice(0, -1)}${replacement}`;
}

function differentAudience(value: string): string {
  return value === "venue:bench-lite-other"
    ? "venue:bench-lite-alternate"
    : "venue:bench-lite-other";
}

function blocked(
  decision: Exclude<VerificationDecision, "ALLOW">,
  reason: string,
): PermitVerificationResult {
  return { valid: false, decision, reason };
}

function withheld<T>(
  response: PublicAgentResponseV2 | null,
  decision: Exclude<VerificationDecision, "ALLOW">,
  reason: string,
): GuardActionResult<T> {
  return {
    status: "VENUE_CALL_WITHHELD",
    response,
    verification: { valid: false, decision, reason },
  };
}

function nonceKey(
  body: Pick<
    ExecutionPermitV2Body,
    "issuer" | "agentId" | "audience" | "nonce"
  >,
): string {
  return `${body.issuer}:${body.agentId}:${body.audience}:${body.nonce}`;
}

function signingBytes(body: ExecutionPermitV2Body): Uint8Array {
  return utf8ToBytes(
    canonicalJson({ kind: "STOPPAGE_EXECUTION_PERMIT_V2", body }),
  );
}

function hashCanonical(value: unknown): string {
  return `0x${bytesToHex(sha256Digest(utf8ToBytes(canonicalJson(value))))}`;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value));
}

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, normalize(nested)]),
    );
  }
  return value;
}

function decodeBase64Url(value: string): Uint8Array {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  const binary = globalThis.atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function validAgentId(value: string): boolean {
  return /^[a-z0-9][a-z0-9-]{2,63}$/.test(value);
}

function validAudience(value: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9:._/-]{2,127}$/.test(value);
}

function validNonce(value: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9:._-]{7,127}$/.test(value);
}

function isHash(value: string): boolean {
  return /^0x[0-9a-f]{64}$/.test(value);
}
