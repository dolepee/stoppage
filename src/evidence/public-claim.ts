import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

import { sha256 } from "../domain/canonical.js";

export const PUBLIC_CLAIM_APPROVAL_PREFIX = "APPROVE STOPPAGE PUBLIC CLAIM";

export interface PublicLifecycleEvidence {
  action:
    | "SUSPEND"
    | "REPRICE"
    | "REOPEN"
    | "ENTER_FAILSAFE"
    | "RECOVER_TO_SUSPENDED";
  trigger:
    | "EVENT_BEFORE_REPRICE"
    | "UNBACKED_MOVE"
    | "EVENT_CONFIRMED_MOVE"
    | "VOLATILITY_SPIKE"
    | "STREAM_UNHEALTHY";
  fromMode: "OPEN" | "SUSPENDED" | "REPRICED" | "FAILSAFE";
  toMode: "OPEN" | "SUSPENDED" | "REPRICED" | "FAILSAFE";
  elapsedMs: number;
  receiptHash: string;
  configHash: string;
}

export interface PublicLifecycleCandidate {
  status: "AWAITING_HUMAN_APPROVAL";
  evidenceType: "DERIVED_LIFECYCLE_EVIDENCE";
  network: "solana-mainnet";
  dataBoundary: string;
  lifecycleDurationMs: number;
  maximumProbabilityMove: number;
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
  version: 2;
  status: "AVAILABLE";
  network: "solana-mainnet";
  approvedConfigHash: string;
  candidateHash?: string;
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
    };
  };
  lifecycleEvidence: {
    evidenceType: "DERIVED_LIFECYCLE_EVIDENCE";
    lifecycleDurationMs: number;
    maximumProbabilityMove: number;
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
    version: 2,
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
      },
    },
    lifecycleEvidence: {
      evidenceType: lifecycle.evidenceType,
      lifecycleDurationMs: lifecycle.lifecycleDurationMs,
      maximumProbabilityMove: lifecycle.maximumProbabilityMove,
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
    value.version !== 2 ||
    value.status !== "AVAILABLE" ||
    value.network !== "solana-mainnet" ||
    !/^0x[0-9a-f]{64}$/.test(value.approvedConfigHash) ||
    !Number.isFinite(Date.parse(value.evaluatedAt)) ||
    !Number.isFinite(Date.parse(value.approvedAt))
  ) {
    return false;
  }
  const expectedApproval = value.candidateHash
    ? `${PUBLIC_CLAIM_APPROVAL_PREFIX} ${value.approvedConfigHash} ${value.candidateHash}`
    : `${PUBLIC_CLAIM_APPROVAL_PREFIX} ${value.approvedConfigHash}`;
  if (value.approval?.statement !== expectedApproval) return false;
  if (
    value.candidateHash &&
    value.candidateHash !== sha256(publicClaimPayload(value))
  ) {
    return false;
  }
  try {
    assertAggregate(value.holdout);
  } catch {
    return false;
  }
  return Boolean(
    value.lifecycleEvidence?.decisions?.length &&
    value.lifecycleEvidence.txlineValidation?.transactionSignature,
  );
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
    value.network !== "solana-mainnet" ||
    value.evidenceType !== "DERIVED_LIFECYCLE_EVIDENCE" ||
    !Number.isFinite(value.lifecycleDurationMs) ||
    value.lifecycleDurationMs <= 0 ||
    !Number.isFinite(value.maximumProbabilityMove) ||
    value.maximumProbabilityMove < 0 ||
    value.maximumProbabilityMove > 1 ||
    !/^0x[0-9a-f]{64}$/.test(value.configHash)
  ) {
    throw new Error("Invalid lifecycle evidence metadata");
  }
  const actions = value.decisions.map((decision) => decision.action);
  if (actions.join(",") !== "SUSPEND,REPRICE,REOPEN") {
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
