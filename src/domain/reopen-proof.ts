import { sha256 } from "./canonical.js";
import type { DecisionReceipt, ReopenProof, ReopenProofBody } from "./types.js";

export function createReopenProof(body: ReopenProofBody): ReopenProof {
  assertSatisfiedChecks(body);
  return { body, hash: sha256(body) };
}

export function verifyReopenProof(
  proof: ReopenProof,
  receipt: DecisionReceipt,
): boolean {
  try {
    assertSatisfiedChecks(proof.body);
  } catch {
    return false;
  }

  return (
    proof.hash === sha256(proof.body) &&
    receipt.hash === sha256(receipt.body) &&
    receipt.body.action === "REOPEN" &&
    receipt.body.toMode === "OPEN" &&
    proof.body.reopenReceiptHash === receipt.hash &&
    proof.body.fixtureId === receipt.body.fixtureId &&
    proof.body.market === receipt.body.market &&
    proof.body.configHash === receipt.body.configHash &&
    proof.body.observedTs === receipt.body.observedTs
  );
}

function assertSatisfiedChecks(body: ReopenProofBody) {
  if (body.version !== 1 && body.version !== 2) {
    throw new Error("Reopen proof version is invalid");
  }
  const checks = body.checks;
  if (body.kind !== "CERTIFIED_REOPEN") {
    throw new Error("Reopen proof kind is invalid");
  }
  if (!Number.isInteger(body.fixtureId) || body.fixtureId <= 0) {
    throw new Error("Reopen proof fixture is invalid");
  }
  if (body.market !== "1X2") {
    throw new Error("Reopen proof market is invalid");
  }
  if (
    !isHash(body.reopenReceiptHash) ||
    !isHash(body.configHash) ||
    !Number.isInteger(body.observedTs) ||
    body.observedTs < 0
  ) {
    throw new Error("Reopen proof binding is invalid");
  }
  if (!checks.oddsStreamHealthy || !checks.scoresStreamHealthy) {
    throw new Error("Both TxLINE streams must be healthy before reopening");
  }
  if (checks.unresolvedIncidentCount !== 0) {
    throw new Error("All incidents must be resolved before reopening");
  }
  if (
    !Number.isInteger(checks.stableUpdatesObserved) ||
    !Number.isInteger(checks.stableUpdatesRequired) ||
    checks.stableUpdatesRequired < 2 ||
    checks.stableUpdatesObserved < checks.stableUpdatesRequired
  ) {
    throw new Error("The stable quote requirement is not satisfied");
  }
  if (
    !Number.isInteger(checks.repriceAgeMs) ||
    !Number.isInteger(checks.reopenDelayMs) ||
    checks.reopenDelayMs < 0 ||
    checks.repriceAgeMs < checks.reopenDelayMs
  ) {
    throw new Error("The reopen delay is not satisfied");
  }
  if (!checks.quotePresent) {
    throw new Error("A repriced quote is required before reopening");
  }
  if (body.version === 2) {
    const resolutionChecks = body.checks;
    if (resolutionChecks.policyRevision !== 2) {
      throw new Error("Resolution-aware policy revision is invalid");
    }
    if (
      resolutionChecks.resolutionOutcome !== "NOT_REQUIRED" &&
      resolutionChecks.resolutionOutcome !== "CONFIRMED" &&
      resolutionChecks.resolutionOutcome !== "DISCARDED"
    ) {
      throw new Error("Incident resolution outcome is invalid");
    }
    if (
      !Number.isInteger(resolutionChecks.postResolutionQuoteCount) ||
      resolutionChecks.postResolutionQuoteCount < 0
    ) {
      throw new Error("Post-resolution quote count is invalid");
    }
    if (resolutionChecks.freshQuoteRequired) {
      if (
        resolutionChecks.resolutionOutcome === "NOT_REQUIRED" ||
        resolutionChecks.resolutionSourceTs === null ||
        resolutionChecks.resolutionObservedTs === null ||
        resolutionChecks.firstPostResolutionQuoteSourceTs === null ||
        resolutionChecks.firstPostResolutionQuoteTs === null ||
        !Number.isInteger(resolutionChecks.resolutionSourceTs) ||
        !Number.isInteger(resolutionChecks.resolutionObservedTs) ||
        !Number.isInteger(resolutionChecks.firstPostResolutionQuoteSourceTs) ||
        !Number.isInteger(resolutionChecks.firstPostResolutionQuoteTs) ||
        resolutionChecks.firstPostResolutionQuoteSourceTs <=
          resolutionChecks.resolutionSourceTs ||
        resolutionChecks.firstPostResolutionQuoteTs <=
          resolutionChecks.resolutionObservedTs ||
        resolutionChecks.postResolutionQuoteCount <
          resolutionChecks.stableUpdatesRequired ||
        !resolutionChecks.freshQuoteObserved
      ) {
        throw new Error("Fresh post-resolution consensus is not satisfied");
      }
    } else if (!resolutionChecks.freshQuoteObserved) {
      throw new Error("Fresh quote check must pass when no resolution applies");
    }
  }
}

function isHash(value: string) {
  return /^0x[0-9a-f]{64}$/.test(value);
}
