import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import { resolve } from "node:path";

import nacl from "tweetnacl";

import { canonicalJson, sha256 } from "../domain/canonical.js";
import type { ExecutionGateDecision, ExecutionGateResult } from "./types.js";

try {
  process.loadEnvFile();
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

export const STOPPAGE_PERMIT_ISSUER = "stoppage";
export const STOPPAGE_PERMIT_TTL_MS = 5_000;
export const STOPPAGE_PERMIT_MAX_CLOCK_SKEW_MS = 1_000;

export type PermitV2BlockDecision =
  | "BLOCK_PERMIT_MALFORMED"
  | "BLOCK_UNKNOWN_SIGNING_KEY"
  | "BLOCK_SIGNATURE_INVALID"
  | "BLOCK_BINDING_INVALID"
  | "BLOCK_AUDIENCE_MISMATCH"
  | "BLOCK_PERMIT_EXPIRED"
  | "BLOCK_NONCE_REPLAY";

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

export interface ExecutionGateResultV2 {
  version: 2;
  command: "PUBLISH_QUOTE";
  decision: ExecutionGateDecision;
  reason: string;
  evaluatedAt: number;
  sequence: number;
  permit: SignedExecutionPermitV2 | null;
}

export interface PermitVerificationKey {
  kid: string;
  alg: "Ed25519";
  use: "sig";
  publicKey: string;
  status: "ACTIVE" | "RETIRED";
}

const STOPPAGE_PERMIT_RETIRED_VERIFICATION_KEYS =
  "STOPPAGE_PERMIT_RETIRED_VERIFICATION_KEYS";

export interface PermitVerificationKeySet {
  version: 1;
  issuer: string;
  keys: PermitVerificationKey[];
}

export interface PermitSigner {
  issuer: string;
  kid: string;
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

export interface PermitV2RequestBinding {
  agentId: string;
  audience: string;
  nonce: string;
  command: "PUBLISH_QUOTE";
  subjectHash: string;
  market: "1X2";
  quoteHash: string;
  sequence: number;
}

export interface PermitV2VerificationResult {
  valid: boolean;
  decision: "ALLOW" | PermitV2BlockDecision;
  reason: string;
}

export interface PermitV2VerificationOptions {
  permit: SignedExecutionPermitV2;
  request: PermitV2RequestBinding;
  keys: PermitVerificationKeySet;
  now: number;
  usedNonces?: ReadonlySet<string>;
  allowRetiredSigners?: boolean;
}

const developmentSeed = Uint8Array.from([
  83, 116, 111, 112, 112, 97, 103, 101, 45, 100, 101, 118, 101, 108, 111, 112,
  109, 101, 110, 116, 45, 111, 110, 108, 121, 45, 107, 101, 121, 33, 33, 33,
]);

export function createPermitSigner(
  seed: Uint8Array,
  issuer = STOPPAGE_PERMIT_ISSUER,
): PermitSigner {
  if (seed.length !== nacl.sign.seedLength) {
    throw new Error("Stoppage signing seed must contain exactly 32 bytes");
  }
  const pair = nacl.sign.keyPair.fromSeed(seed);
  const keyHash = sha256(Array.from(pair.publicKey)).slice(2, 18);
  return {
    issuer,
    kid: `stp_${keyHash}`,
    publicKey: pair.publicKey,
    secretKey: pair.secretKey,
  };
}

export function loadPermitSigner(
  environment: NodeJS.ProcessEnv = process.env,
): PermitSigner {
  const encodedSeed = environment.STOPPAGE_PERMIT_SIGNING_SEED;
  if (encodedSeed) {
    return createPermitSigner(
      decodeBase64Url(encodedSeed),
      environment.STOPPAGE_PERMIT_ISSUER ?? STOPPAGE_PERMIT_ISSUER,
    );
  }
  const seedFile = environment.STOPPAGE_PERMIT_SIGNING_SEED_FILE;
  if (seedFile) {
    return createPermitSigner(
      readOwnerOnlySeedFile(resolve(seedFile)),
      environment.STOPPAGE_PERMIT_ISSUER ?? STOPPAGE_PERMIT_ISSUER,
    );
  }
  if (environment.NODE_ENV === "production") {
    throw new Error("STOPPAGE_PERMIT_SIGNING_SEED is required in production");
  }
  return createPermitSigner(developmentSeed);
}

export function loadRetiredPermitVerificationKeys(
  environment: NodeJS.ProcessEnv = process.env,
): PermitVerificationKey[] {
  const raw = environment.STOPPAGE_PERMIT_RETIRED_VERIFICATION_KEYS;
  if (!raw) return [];
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch (error) {
    throw new Error("STOPPAGE_PERMIT_RETIRED_VERIFICATION_KEYS must be JSON");
  }
  if (!Array.isArray(payload)) {
    throw new Error(
      "STOPPAGE_PERMIT_RETIRED_VERIFICATION_KEYS must be a JSON array",
    );
  }
  return payload.map((entry, index) => {
    if (
      !entry ||
      typeof entry !== "object" ||
      Object.keys(entry as Record<string, unknown>).length !== 2 ||
      !("kid" in entry) ||
      !("publicKey" in entry)
    ) {
      throw new Error(
        `STOPPAGE_PERMIT_RETIRED_VERIFICATION_KEYS[${index}] must include kid and publicKey`,
      );
    }
    const { kid, publicKey } = entry as {
      kid: unknown;
      publicKey: unknown;
    };
    if (typeof kid !== "string" || kid.length < 4) {
      throw new Error(
        `STOPPAGE_RETIRED_VERIFICATION_KEYS[${index}].kid must be a non-empty string`,
      );
    }
    if (typeof publicKey !== "string" || publicKey.length < 4) {
      throw new Error(
        `STOPPAGE_RETIRED_VERIFICATION_KEYS[${index}].publicKey must be a non-empty base64url string`,
      );
    }
    const decoded = decodeBase64Url(publicKey);
    if (decoded.length !== nacl.sign.publicKeyLength) {
      throw new Error(
        `STOPPAGE_RETIRED_VERIFICATION_KEYS[${index}].publicKey must decode to ${nacl.sign.publicKeyLength} bytes`,
      );
    }
    return {
      kid,
      alg: "Ed25519",
      use: "sig",
      publicKey,
      status: "RETIRED",
    } satisfies PermitVerificationKey;
  });
}

function readOwnerOnlySeedFile(path: string): Uint8Array {
  const descriptor = openSync(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile()) {
      throw new Error("Stoppage signing seed must be a regular file");
    }
    if ((metadata.mode & 0o777) !== 0o600) {
      throw new Error("Stoppage signing seed file permissions must be 0600");
    }
    if (
      typeof process.getuid === "function" &&
      metadata.uid !== process.getuid()
    ) {
      throw new Error("Stoppage signing seed file must be owned by this user");
    }
    return new Uint8Array(readFileSync(descriptor));
  } finally {
    closeSync(descriptor);
  }
}

export function publicKeySetFor(
  signer: PermitSigner,
  retiredKeys: readonly PermitVerificationKey[] = [],
): PermitVerificationKeySet {
  if (new Set(retiredKeys.map((key) => key.kid)).has(signer.kid)) {
    throw new Error("Retired key list must not include the active key");
  }
  return {
    version: 1,
    issuer: signer.issuer,
    keys: [
      {
        kid: signer.kid,
        alg: "Ed25519",
        use: "sig",
        publicKey: encodeBase64Url(signer.publicKey),
        status: "ACTIVE",
      },
      ...retiredKeys.map((key) => ({ ...key, status: "RETIRED" as const })),
    ],
  };
}

export function issueExecutionPermitV2(
  result: ExecutionGateResult,
  request: PermitV2RequestBinding,
  signer: PermitSigner,
  now = Date.now(),
): ExecutionGateResultV2 {
  if (!result.permit) {
    return {
      version: 2,
      command: result.command,
      decision: result.decision,
      reason: result.reason,
      evaluatedAt: now,
      sequence: result.sequence,
      permit: null,
    };
  }

  const v1 = result.permit.body;
  const body: ExecutionPermitV2Body = {
    version: 2,
    issuer: signer.issuer,
    kid: signer.kid,
    agentId: request.agentId,
    audience: request.audience,
    nonce: request.nonce,
    command: request.command,
    decision: v1.decision,
    reason: v1.reason,
    subjectHash: v1.subjectHash,
    market: v1.market,
    quoteHash: v1.quoteHash,
    configHash: v1.configHash,
    stateReceiptHash: v1.stateReceiptHash,
    reopenProofHash: v1.reopenProofHash,
    sequence: v1.sequence,
    issuedAt: now,
    expiresAt: now + STOPPAGE_PERMIT_TTL_MS,
  };
  const signature = nacl.sign.detached(signingBytes(body), signer.secretKey);
  return {
    version: 2,
    command: result.command,
    decision: result.decision,
    reason: result.reason,
    evaluatedAt: now,
    sequence: result.sequence,
    permit: {
      alg: "Ed25519",
      body,
      hash: sha256(body),
      signature: encodeBase64Url(signature),
    },
  };
}

export function inspectExecutionPermitV2({
  permit,
  request,
  keys,
  now,
  usedNonces,
  allowRetiredSigners,
}: PermitV2VerificationOptions): PermitV2VerificationResult {
  try {
    if (!validPermitShape(permit) || !validRequestShape(request)) {
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
        (candidate.status === "ACTIVE" ||
          (allowRetiredSigners && candidate.status === "RETIRED")),
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
    if (permit.hash !== sha256(permit.body)) {
      return blocked(
        "BLOCK_BINDING_INVALID",
        "The permit hash does not bind the signed body.",
      );
    }
    if (permit.body.audience !== request.audience) {
      return blocked(
        "BLOCK_AUDIENCE_MISMATCH",
        "The permit was issued for a different audience.",
      );
    }
    if (
      permit.body.agentId !== request.agentId ||
      permit.body.nonce !== request.nonce ||
      permit.body.command !== request.command ||
      permit.body.subjectHash !== request.subjectHash ||
      permit.body.market !== request.market ||
      permit.body.quoteHash !== request.quoteHash ||
      permit.body.sequence !== request.sequence
    ) {
      return blocked(
        "BLOCK_BINDING_INVALID",
        "The permit does not bind the exact intended venue action.",
      );
    }
    if (
      !Number.isInteger(now) ||
      now + STOPPAGE_PERMIT_MAX_CLOCK_SKEW_MS < permit.body.issuedAt ||
      permit.body.expiresAt !== permit.body.issuedAt + STOPPAGE_PERMIT_TTL_MS ||
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

export function nonceKey(
  body: Pick<
    ExecutionPermitV2Body,
    "issuer" | "agentId" | "audience" | "nonce"
  >,
): string {
  return `${body.issuer}:${body.agentId}:${body.audience}:${body.nonce}`;
}

function signingBytes(body: ExecutionPermitV2Body): Uint8Array {
  return new TextEncoder().encode(
    canonicalJson({ kind: "STOPPAGE_EXECUTION_PERMIT_V2", body }),
  );
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

function validRequestShape(request: PermitV2RequestBinding): boolean {
  return (
    validAgentId(request.agentId) &&
    validAudience(request.audience) &&
    validNonce(request.nonce) &&
    request.command === "PUBLISH_QUOTE" &&
    isHash(request.subjectHash) &&
    request.market === "1X2" &&
    isHash(request.quoteHash) &&
    Number.isInteger(request.sequence) &&
    request.sequence >= 1
  );
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

function blocked(
  decision: PermitV2BlockDecision,
  reason: string,
): PermitV2VerificationResult {
  return { valid: false, decision, reason };
}

function encodeBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function decodeBase64Url(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "base64url"));
}
