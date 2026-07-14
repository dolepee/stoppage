import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

import { sha256 } from "../domain/canonical.js";

export const PUBLIC_CLAIM_APPROVAL_PREFIX = "APPROVE STOPPAGE PUBLIC CLAIM";

export interface PublicLifecycleEvidence {
  action:
    | "SUSPEND"
    | "REPRICE"
    | "INVALIDATE_REPRICE"
    | "REOPEN"
    | "ENTER_FAILSAFE"
    | "RECOVER_TO_SUSPENDED";
  trigger:
    | "EVENT_BEFORE_REPRICE"
    | "UNBACKED_MOVE"
    | "EVENT_CONFIRMED_MOVE"
    | "RESOLUTION_CONFIRMED"
    | "RESOLUTION_DISCARDED"
    | "VOLATILITY_SPIKE"
    | "STREAM_UNHEALTHY";
  fromMode: "OPEN" | "SUSPENDED" | "REPRICED" | "FAILSAFE";
  toMode: "OPEN" | "SUSPENDED" | "REPRICED" | "FAILSAFE";
  elapsedMs: number;
  receiptHash: string;
  configHash: string;
}

export interface PublicLifecycleCandidate {
  version: 2;
  status: "AWAITING_HUMAN_APPROVAL";
  evidenceType: "DERIVED_LIFECYCLE_EVIDENCE";
  network: "solana-mainnet";
  policyRevision: 2;
  dataBoundary: string;
  lifecycleDurationMs: number;
  maximumProbabilityMove: number;
  preResolutionRepricesInvalidated: number;
  configHash: string;
  decisions: PublicLifecycleEvidence[];
  txlineValidation: {
    transactionSignature: string;
    explorer: string;
  };
}

export interface PrivateHoldoutAggregate {
  fixtures: number;
  completeProtectedWindows: number;
  staleQuoteSeconds: number;
  mispricingIntegral: number;
  eventLedProtectedWindows: number;
  oddsLedProtectedWindows: number;
  confirmedOddsLedProtectedWindows: number;
  unconfirmedOddsLedProtectedWindows: number;
  unconfirmedOddsLedSuspensionRate: number | null;
  failsafeProtectedWindows: number;
  provisionalEventProtectedWindows: number;
  preResolutionRepricesInvalidated: number;
  postResolutionCertifiedReopens: number;
  confirmedResolutionCertifiedReopens: number;
  discardedResolutionCertifiedReopens: number;
}

export interface PrivateHoldoutReport {
  version: number;
  status: "AWAITING_PUBLIC_CLAIM_APPROVAL";
  network: "solana-mainnet";
  approvedConfigHash: string;
  evaluatedAt: string;
  fixtures: Array<Record<string, unknown>>;
  aggregate: PrivateHoldoutAggregate;
}

export interface PublicClaimResponse {
  version: 3;
  status: "AVAILABLE";
  network: "solana-mainnet";
  approvedConfigHash: string;
  candidateHash: string;
  evaluatedAt: string;
  approvedAt: string;
  approval: {
    statement: string;
  };
  dataBoundary: string;
  holdout: PrivateHoldoutAggregate & {
    definitions: {
      unconfirmedOddsLedSuspensionRate: string;
      provisionalEventProtectedWindows: string;
      preResolutionRepricesInvalidated: string;
      postResolutionCertifiedReopens: string;
    };
  };
  lifecycleEvidence: {
    evidenceType: "DERIVED_LIFECYCLE_EVIDENCE";
    policyRevision: 2;
    lifecycleDurationMs: number;
    maximumProbabilityMove: number;
    preResolutionRepricesInvalidated: number;
    txlineValidation: {
      transactionSignature: string;
      explorer: string;
    };
    decisions: Array<{
      action: PublicLifecycleEvidence["action"];
      trigger: PublicLifecycleEvidence["trigger"];
      fromMode: PublicLifecycleEvidence["fromMode"];
      toMode: PublicLifecycleEvidence["toMode"];
      elapsedMs: number;
      receiptHash: string;
    }>;
  };
}

export interface PublicClaimCandidate {
  candidateHash: string;
  requiredApproval: string;
  payload: Omit<
    PublicClaimResponse,
    "approvedAt" | "approval" | "candidateHash"
  >;
}

export async function loadLatestPublicClaim(
  dataRoot = "data/public",
  approvedConfigHash?: string,
): Promise<PublicClaimResponse | null> {
  const claim = (await safeParseJson(
    resolve(dataRoot, "public-claim.json"),
  )) as PublicClaimResponse | null;
  if (!claim || !isApprovedPublicClaim(claim)) return null;
  if (
    approvedConfigHash &&
    claim.approvedConfigHash.toLowerCase() !== approvedConfigHash.toLowerCase()
  ) {
    return null;
  }
  return claim;
}

export async function loadLatestPrivateEvidence(
  dataRoot: string,
  approvedConfigHash: string,
) {
  const root = resolve(dataRoot);
  const [holdout, lifecycle] = await Promise.all([
    findLatestHoldout(root, approvedConfigHash),
    findLatestLifecycleEvidence(root, approvedConfigHash),
  ]);
  if (!holdout || !lifecycle) return null;
  return { holdout, lifecycle };
}

export function buildApprovedPublicClaim({
  holdout,
  lifecycle,
  approvalStatement,
  approvedAt,
}: {
  holdout: PrivateHoldoutReport;
  lifecycle: PublicLifecycleCandidate;
  approvalStatement: string;
  approvedAt: string;
}): PublicClaimResponse {
  const candidate = buildPublicClaimCandidate({ holdout, lifecycle });
  if (approvalStatement !== candidate.requiredApproval) {
    throw new Error(
      `Human approval must exactly equal: ${candidate.requiredApproval}`,
    );
  }
  if (!Number.isFinite(Date.parse(approvedAt))) {
    throw new Error("approvedAt must be a valid timestamp");
  }

  return {
    ...candidate.payload,
    candidateHash: candidate.candidateHash,
    approvedAt,
    approval: { statement: approvalStatement },
  };
}

export function buildPublicClaimCandidate({
  holdout,
  lifecycle,
}: {
  holdout: PrivateHoldoutReport;
  lifecycle: PublicLifecycleCandidate;
}): PublicClaimCandidate {
  if (holdout.approvedConfigHash !== lifecycle.configHash) {
    throw new Error("Holdout and lifecycle config hashes do not match");
  }
  assertAggregate(holdout.aggregate);
  assertLifecycleCandidate(lifecycle);

  const payload: PublicClaimCandidate["payload"] = {
    version: 3,
    status: "AVAILABLE",
    network: holdout.network,
    approvedConfigHash: holdout.approvedConfigHash,
    evaluatedAt: holdout.evaluatedAt,
    dataBoundary: lifecycle.dataBoundary,
    holdout: {
      ...holdout.aggregate,
      definitions: {
        unconfirmedOddsLedSuspensionRate:
          "Odds-led protected windows that remained UNBACKED_MOVE through repricing divided by all odds-led protected windows; null when no odds-led window was observed.",
        provisionalEventProtectedWindows:
          "Event-led windows entered from a provisional TxLINE event. Reopening still required later confirmation or explicit discard.",
        preResolutionRepricesInvalidated:
          "Candidate reprices formed before incident confirmation or discard and explicitly invalidated at that resolution boundary.",
        postResolutionCertifiedReopens:
          "Reopens certified only after a full stable quote sequence observed after the latest incident resolution.",
      },
    },
    lifecycleEvidence: {
      evidenceType: lifecycle.evidenceType,
      policyRevision: lifecycle.policyRevision,
      lifecycleDurationMs: lifecycle.lifecycleDurationMs,
      maximumProbabilityMove: lifecycle.maximumProbabilityMove,
      preResolutionRepricesInvalidated:
        lifecycle.preResolutionRepricesInvalidated,
      txlineValidation: lifecycle.txlineValidation,
      decisions: lifecycle.decisions.map((decision) => ({
        action: decision.action,
        trigger: decision.trigger,
        fromMode: decision.fromMode,
        toMode: decision.toMode,
        elapsedMs: decision.elapsedMs,
        receiptHash: decision.receiptHash,
      })),
    },
  };
  const candidateHash = sha256(payload);
  return {
    candidateHash,
    requiredApproval: `${PUBLIC_CLAIM_APPROVAL_PREFIX} ${holdout.approvedConfigHash} ${candidateHash}`,
    payload,
  };
}

function isApprovedPublicClaim(value: PublicClaimResponse) {
  if (
    value.version !== 3 ||
    value.status !== "AVAILABLE" ||
    value.network !== "solana-mainnet" ||
    !/^0x[0-9a-f]{64}$/.test(value.approvedConfigHash) ||
    !Number.isFinite(Date.parse(value.evaluatedAt)) ||
    !Number.isFinite(Date.parse(value.approvedAt))
  ) {
    return false;
  }
  const expectedApproval = `${PUBLIC_CLAIM_APPROVAL_PREFIX} ${value.approvedConfigHash} ${value.candidateHash}`;
  if (value.approval?.statement !== expectedApproval) return false;
  if (value.candidateHash !== sha256(publicClaimPayload(value))) {
    return false;
  }
  try {
    assertAggregate(value.holdout);
    assertLifecycleCandidate({
      version: 2,
      status: "AWAITING_HUMAN_APPROVAL",
      evidenceType: value.lifecycleEvidence.evidenceType,
      network: value.network,
      policyRevision: value.lifecycleEvidence.policyRevision,
      dataBoundary: value.dataBoundary,
      lifecycleDurationMs: value.lifecycleEvidence.lifecycleDurationMs,
      maximumProbabilityMove: value.lifecycleEvidence.maximumProbabilityMove,
      preResolutionRepricesInvalidated:
        value.lifecycleEvidence.preResolutionRepricesInvalidated,
      configHash: value.approvedConfigHash,
      decisions: value.lifecycleEvidence.decisions.map((decision) => ({
        ...decision,
        configHash: value.approvedConfigHash,
      })),
      txlineValidation: value.lifecycleEvidence.txlineValidation,
    });
  } catch {
    return false;
  }
  return true;
}

async function findLatestHoldout(
  dataRoot: string,
  approvedConfigHash: string,
): Promise<PrivateHoldoutReport | null> {
  const files = await listJsonFiles(dataRoot, "holdout-");
  for (const file of files) {
    const report = (await safeParseJson(
      resolve(dataRoot, file),
    )) as PrivateHoldoutReport | null;
    if (
      report?.status !== "AWAITING_PUBLIC_CLAIM_APPROVAL" ||
      report.approvedConfigHash !== approvedConfigHash
    ) {
      continue;
    }
    try {
      assertAggregate(report.aggregate);
      return report;
    } catch {
      continue;
    }
  }
  return null;
}

async function findLatestLifecycleEvidence(
  dataRoot: string,
  approvedConfigHash: string,
): Promise<PublicLifecycleCandidate | null> {
  const files = await listJsonFiles(dataRoot, "public-evidence-candidate-");
  let strongest: PublicLifecycleCandidate | null = null;
  for (const file of files) {
    const candidate = (await safeParseJson(
      resolve(dataRoot, file),
    )) as PublicLifecycleCandidate | null;
    try {
      if (
        candidate?.status !== "AWAITING_HUMAN_APPROVAL" ||
        candidate.configHash !== approvedConfigHash
      ) {
        continue;
      }
      assertLifecycleCandidate(candidate);
      if (
        !strongest ||
        candidate.maximumProbabilityMove > strongest.maximumProbabilityMove
      ) {
        strongest = candidate;
      }
    } catch {
      continue;
    }
  }
  return strongest;
}

function publicClaimPayload(
  value: PublicClaimResponse,
): PublicClaimCandidate["payload"] {
  return {
    version: value.version,
    status: value.status,
    network: value.network,
    approvedConfigHash: value.approvedConfigHash,
    evaluatedAt: value.evaluatedAt,
    dataBoundary: value.dataBoundary,
    holdout: value.holdout,
    lifecycleEvidence: value.lifecycleEvidence,
  };
}

async function listJsonFiles(dataRoot: string, prefix: string) {
  const files = await readdir(dataRoot).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  });
  return files
    .filter((name) => name.startsWith(prefix) && name.endsWith(".json"))
    .sort()
    .reverse();
}

function assertAggregate(value: PrivateHoldoutAggregate) {
  for (const field of [
    "fixtures",
    "completeProtectedWindows",
    "staleQuoteSeconds",
    "mispricingIntegral",
    "eventLedProtectedWindows",
    "oddsLedProtectedWindows",
    "confirmedOddsLedProtectedWindows",
    "unconfirmedOddsLedProtectedWindows",
    "failsafeProtectedWindows",
    "provisionalEventProtectedWindows",
    "preResolutionRepricesInvalidated",
    "postResolutionCertifiedReopens",
    "confirmedResolutionCertifiedReopens",
    "discardedResolutionCertifiedReopens",
  ] as const) {
    if (!Number.isFinite(value?.[field]) || value[field] < 0) {
      throw new Error(`Invalid holdout aggregate field: ${field}`);
    }
  }
  const rate = value.unconfirmedOddsLedSuspensionRate;
  if (rate !== null && (!Number.isFinite(rate) || rate < 0 || rate > 1)) {
    throw new Error("Invalid unconfirmed odds-led suspension rate");
  }
}

function assertLifecycleCandidate(value: PublicLifecycleCandidate) {
  if (
    value.version !== 2 ||
    value.network !== "solana-mainnet" ||
    value.evidenceType !== "DERIVED_LIFECYCLE_EVIDENCE" ||
    value.policyRevision !== 2 ||
    !Number.isFinite(value.lifecycleDurationMs) ||
    value.lifecycleDurationMs <= 0 ||
    !Number.isFinite(value.maximumProbabilityMove) ||
    value.maximumProbabilityMove < 0 ||
    value.maximumProbabilityMove > 1 ||
    !Number.isInteger(value.preResolutionRepricesInvalidated) ||
    value.preResolutionRepricesInvalidated < 1 ||
    !/^0x[0-9a-f]{64}$/.test(value.configHash)
  ) {
    throw new Error("Invalid lifecycle evidence metadata");
  }
  const actions = value.decisions.map((decision) => decision.action);
  const invalidationIndex = actions.indexOf("INVALIDATE_REPRICE");
  const finalRepriceIndex = actions.lastIndexOf("REPRICE");
  if (
    actions[0] !== "SUSPEND" ||
    actions[actions.length - 1] !== "REOPEN" ||
    invalidationIndex <= 0 ||
    !actions.slice(0, invalidationIndex).includes("REPRICE") ||
    finalRepriceIndex <= invalidationIndex ||
    actions.filter((action) => action === "INVALIDATE_REPRICE").length !==
      value.preResolutionRepricesInvalidated
  ) {
    throw new Error("Lifecycle evidence must contain a complete decision path");
  }
  if (
    value.decisions.some(
      (decision) =>
        decision.configHash !== value.configHash ||
        !/^0x[0-9a-f]{64}$/.test(decision.receiptHash) ||
        !Number.isFinite(decision.elapsedMs) ||
        decision.elapsedMs < 0,
    )
  ) {
    throw new Error("Invalid lifecycle decision evidence");
  }
  if (
    value.decisions.some(
      (decision, index) =>
        index > 0 && decision.elapsedMs < value.decisions[index - 1]!.elapsedMs,
    ) ||
    value.decisions[value.decisions.length - 1]?.elapsedMs !==
      value.lifecycleDurationMs
  ) {
    throw new Error("Lifecycle decision timing is inconsistent");
  }
  const signature = value.txlineValidation?.transactionSignature;
  if (
    !/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(signature) ||
    value.txlineValidation.explorer !== `https://solscan.io/tx/${signature}`
  ) {
    throw new Error("Invalid TxLINE validation evidence");
  }
}

async function safeParseJson(path: string) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}
