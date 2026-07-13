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
  const { checks } = body;
  if (body.version !== 1) {
    throw new Error("Reopen proof version is invalid");
  }
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
}

function isHash(value: string) {
  return /^0x[0-9a-f]{64}$/.test(value);
}
