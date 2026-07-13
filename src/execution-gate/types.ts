import type {
  FixtureGovernorState,
  Market,
  ReopenProof,
} from "../domain/types.js";

export type ExecutionGateDecision =
  | "BLOCK_UNRESOLVED_INCIDENT"
  | "BLOCK_INVALIDATED_BRANCH"
  | "BLOCK_STREAM_UNHEALTHY"
  | "BLOCK_QUOTE_STALE"
  | "BLOCK_PERMIT_EXPIRED"
  | "ALLOW_HEALTHY_QUOTE"
  | "ALLOW_CERTIFIED_REOPEN";

export interface ExecutionGateConfig {
  permitTtlMs: number;
}

export interface ExecutionGateRequest {
  version: 1;
  command: "PUBLISH_QUOTE";
  subjectHash: string;
  market: Market;
  quoteHash: string;
}

export interface ExecutionGateContext {
  subjectHash: string;
  configHash: string;
  sequence: number;
  observedTs: number;
  state: Readonly<FixtureGovernorState>;
  reopenProofs: readonly ReopenProof[];
}

export interface ExecutionPermitBody {
  version: 1;
  decision: "ALLOW_HEALTHY_QUOTE" | "ALLOW_CERTIFIED_REOPEN";
  reason: string;
  subjectHash: string;
  market: Market;
  quoteHash: string;
  configHash: string;
  stateReceiptHash: string | null;
  reopenProofHash: string | null;
  sequence: number;
  issuedAt: number;
  expiresAt: number;
}

export interface ExecutionPermit {
  body: ExecutionPermitBody;
  hash: string;
}

export interface ExecutionGateResult {
  version: 1;
  command: "PUBLISH_QUOTE";
  decision: ExecutionGateDecision;
  reason: string;
  evaluatedAt: number;
  sequence: number;
  permit: ExecutionPermit | null;
}

export interface PermitVerificationResult {
  valid: boolean;
  decision: ExecutionGateDecision;
  reason: string;
}
