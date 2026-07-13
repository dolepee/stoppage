import { sha256 } from "../domain/canonical.js";
import { assertProbabilityVector } from "../domain/probability.js";
import { verifyReopenProof } from "../domain/reopen-proof.js";
import type { ConsensusQuote } from "../domain/types.js";
import type {
  ExecutionGateConfig,
  ExecutionGateContext,
  ExecutionGateDecision,
  ExecutionGateRequest,
  ExecutionGateResult,
  ExecutionPermit,
  PermitVerificationResult,
} from "./types.js";

export const DEFAULT_EXECUTION_GATE_CONFIG: ExecutionGateConfig = {
  permitTtlMs: 5_000,
};

const reasons: Record<ExecutionGateDecision, string> = {
  BLOCK_UNRESOLVED_INCIDENT:
    "A provisional match incident is unresolved; the agent must remain closed.",
  BLOCK_INVALIDATED_BRANCH:
    "The proposed quote belongs to a branch that cannot be released without the current Certified Reopen proof.",
  BLOCK_STREAM_UNHEALTHY:
    "A required TxLINE stream is unhealthy; execution fails closed.",
  BLOCK_QUOTE_STALE:
    "The proposed quote is not the governor's exact current quote.",
  BLOCK_PERMIT_EXPIRED:
    "The permit is expired or no longer matches the current execution sequence.",
  ALLOW_HEALTHY_QUOTE:
    "Both TxLINE streams are healthy and the pre-incident quote is current.",
  ALLOW_CERTIFIED_REOPEN:
    "Fresh post-resolution consensus and the exact Certified Reopen proof authorize this quote.",
};

export function hashExecutionSubject(value: unknown): string {
  return sha256({ kind: "STOPPAGE_EXECUTION_SUBJECT", version: 1, value });
}

export function hashQuote(
  quote: Pick<ConsensusQuote, "market" | "probabilities">,
): string {
  assertProbabilityVector(quote.probabilities);
  return sha256({
    kind: "STOPPAGE_1X2_QUOTE",
    version: 1,
    market: quote.market,
    probabilities: quote.probabilities,
  });
}

export function evaluateExecutionGate(
  request: ExecutionGateRequest,
  context: ExecutionGateContext,
  config: ExecutionGateConfig = DEFAULT_EXECUTION_GATE_CONFIG,
): ExecutionGateResult {
  validateConfig(config);
  validateContext(context);

  if (!context.state.streamHealth.odds || !context.state.streamHealth.scores) {
    return blocked("BLOCK_STREAM_UNHEALTHY", context);
  }

  const currentQuoteHash = context.state.quote
    ? hashQuote(context.state.quote)
    : null;
  if (
    request.version !== 1 ||
    request.command !== "PUBLISH_QUOTE" ||
    request.subjectHash !== context.subjectHash ||
    request.market !== context.state.market ||
    !isHash(request.quoteHash) ||
    request.quoteHash !== currentQuoteHash
  ) {
    return blocked("BLOCK_QUOTE_STALE", context);
  }

  if (context.state.mode === "FAILSAFE") {
    return blocked("BLOCK_STREAM_UNHEALTHY", context);
  }

  if (context.state.mode !== "OPEN") {
    return blocked(
      context.state.pendingUnconfirmedIncidentIds.length > 0
        ? "BLOCK_UNRESOLVED_INCIDENT"
        : "BLOCK_INVALIDATED_BRANCH",
      context,
    );
  }

  const latestReceipt = context.state.receipts.at(-1) ?? null;
  const reopenProof =
    latestReceipt?.body.action === "REOPEN"
      ? (context.reopenProofs.find(
          (proof) => proof.body.reopenReceiptHash === latestReceipt.hash,
        ) ?? null)
      : null;

  if (latestReceipt?.body.action === "REOPEN") {
    if (!reopenProof || !verifyReopenProof(reopenProof, latestReceipt)) {
      return blocked("BLOCK_INVALIDATED_BRANCH", context);
    }
    return allowed(
      "ALLOW_CERTIFIED_REOPEN",
      request,
      context,
      config,
      latestReceipt.hash,
      reopenProof.hash,
    );
  }

  return allowed(
    "ALLOW_HEALTHY_QUOTE",
    request,
    context,
    config,
    latestReceipt?.hash ?? null,
    null,
  );
}

export function verifyExecutionPermit(
  permit: ExecutionPermit,
  context: ExecutionGateContext,
  now: number,
  config: ExecutionGateConfig = DEFAULT_EXECUTION_GATE_CONFIG,
): boolean {
  return inspectExecutionPermit(permit, context, now, config).valid;
}

export function inspectExecutionPermit(
  permit: ExecutionPermit,
  context: ExecutionGateContext,
  now: number,
  config: ExecutionGateConfig = DEFAULT_EXECUTION_GATE_CONFIG,
): PermitVerificationResult {
  try {
    validateConfig(config);
    validateContext(context);
  } catch (error) {
    return invalid("BLOCK_PERMIT_EXPIRED", (error as Error).message);
  }

  if (
    permit.hash !== sha256(permit.body) ||
    permit.body.version !== 1 ||
    !isHash(permit.hash) ||
    !isHash(permit.body.subjectHash) ||
    !isHash(permit.body.quoteHash) ||
    !isHash(permit.body.configHash) ||
    (permit.body.stateReceiptHash !== null &&
      !isHash(permit.body.stateReceiptHash)) ||
    (permit.body.reopenProofHash !== null &&
      !isHash(permit.body.reopenProofHash))
  ) {
    return invalid(
      "BLOCK_INVALIDATED_BRANCH",
      "The permit body or canonical hash is invalid.",
    );
  }

  if (
    !Number.isInteger(now) ||
    now < permit.body.issuedAt ||
    permit.body.expiresAt !== permit.body.issuedAt + config.permitTtlMs ||
    now >= permit.body.expiresAt ||
    permit.body.sequence !== context.sequence
  ) {
    return invalid("BLOCK_PERMIT_EXPIRED", reasons.BLOCK_PERMIT_EXPIRED);
  }

  const currentQuoteHash = context.state.quote
    ? hashQuote(context.state.quote)
    : null;
  const latestReceipt = context.state.receipts.at(-1) ?? null;
  if (
    context.state.mode !== "OPEN" ||
    !context.state.streamHealth.odds ||
    !context.state.streamHealth.scores ||
    permit.body.subjectHash !== context.subjectHash ||
    permit.body.market !== context.state.market ||
    permit.body.quoteHash !== currentQuoteHash ||
    permit.body.configHash !== context.configHash ||
    permit.body.stateReceiptHash !== (latestReceipt?.hash ?? null)
  ) {
    return invalid(
      "BLOCK_INVALIDATED_BRANCH",
      "The permit no longer matches the current governor state.",
    );
  }

  if (permit.body.decision === "ALLOW_CERTIFIED_REOPEN") {
    const proof = context.reopenProofs.find(
      (candidate) => candidate.hash === permit.body.reopenProofHash,
    );
    if (
      latestReceipt?.body.action !== "REOPEN" ||
      !proof ||
      !verifyReopenProof(proof, latestReceipt)
    ) {
      return invalid(
        "BLOCK_INVALIDATED_BRANCH",
        "The permit is not bound to the exact current Certified Reopen proof.",
      );
    }
  } else if (
    permit.body.decision !== "ALLOW_HEALTHY_QUOTE" ||
    permit.body.reopenProofHash !== null ||
    latestReceipt?.body.action === "REOPEN"
  ) {
    return invalid(
      "BLOCK_INVALIDATED_BRANCH",
      "The permit decision does not match the current release path.",
    );
  }

  return {
    valid: true,
    decision: permit.body.decision,
    reason: permit.body.reason,
  };
}

function blocked(
  decision: Exclude<ExecutionGateDecision, `ALLOW_${string}`>,
  context: ExecutionGateContext,
): ExecutionGateResult {
  return {
    version: 1,
    command: "PUBLISH_QUOTE",
    decision,
    reason: reasons[decision],
    evaluatedAt: context.observedTs,
    sequence: context.sequence,
    permit: null,
  };
}

function allowed(
  decision: "ALLOW_HEALTHY_QUOTE" | "ALLOW_CERTIFIED_REOPEN",
  request: ExecutionGateRequest,
  context: ExecutionGateContext,
  config: ExecutionGateConfig,
  stateReceiptHash: string | null,
  reopenProofHash: string | null,
): ExecutionGateResult {
  const body = {
    version: 1 as const,
    decision,
    reason: reasons[decision],
    subjectHash: request.subjectHash,
    market: request.market,
    quoteHash: request.quoteHash,
    configHash: context.configHash,
    stateReceiptHash,
    reopenProofHash,
    sequence: context.sequence,
    issuedAt: context.observedTs,
    expiresAt: context.observedTs + config.permitTtlMs,
  };
  return {
    version: 1,
    command: "PUBLISH_QUOTE",
    decision,
    reason: reasons[decision],
    evaluatedAt: context.observedTs,
    sequence: context.sequence,
    permit: { body, hash: sha256(body) },
  };
}

function invalid(
  decision: ExecutionGateDecision,
  reason: string,
): PermitVerificationResult {
  return { valid: false, decision, reason };
}

function validateConfig(config: ExecutionGateConfig) {
  if (!Number.isInteger(config.permitTtlMs) || config.permitTtlMs < 250) {
    throw new Error("permitTtlMs must be an integer of at least 250ms");
  }
}

function validateContext(context: ExecutionGateContext) {
  if (
    !isHash(context.subjectHash) ||
    !isHash(context.configHash) ||
    !Number.isInteger(context.sequence) ||
    context.sequence < 0 ||
    !Number.isInteger(context.observedTs) ||
    context.observedTs < 0
  ) {
    throw new Error("Execution gate context is invalid");
  }
}

function isHash(value: string): boolean {
  return /^0x[0-9a-f]{64}$/.test(value);
}
