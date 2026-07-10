import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

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
  status: "AWAITING_HUMAN_APPROVAL" | string;
  evidenceType: "DERIVED_LIFECYCLE_EVIDENCE";
  network: "solana-mainnet" | string;
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
  eventSuspensions: number;
  unconfirmedEventSuspensions: number;
  unconfirmedSuspensionRate?: number | null;
}

export interface PrivateHoldoutReport {
  version: number;
  status:
    "AWAITING_PUBLIC_CLAIM_APPROVAL" | "PRIVATE_HOLDOUT_AVAILABLE" | string;
  network: "solana-mainnet" | string;
  approvedConfigHash: string;
  evaluatedAt: string;
  fixtures: Array<Record<string, unknown>>;
  aggregate: PrivateHoldoutAggregate;
}

export interface PublicClaimResponse {
  version: 1;
  status: "AVAILABLE";
  network: "solana-mainnet" | string;
  approvedConfigHash: string;
  evaluatedAt: string;
  approvedAt: string;
  dataBoundary: string;
  holdout: {
    fixtures: number;
    completeProtectedWindows: number;
    staleQuoteSeconds: number;
    mispricingIntegral: number;
    eventSuspensions: number;
    unconfirmedEventSuspensions: number;
    unconfirmedSuspensionRate: number | null;
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

export async function loadLatestPublicClaim(
  dataRoot = "data/private",
  approvedConfigHash?: string,
): Promise<PublicClaimResponse | null> {
  const root = resolve(dataRoot);
  const [latestHoldout, latestCandidate] = await Promise.all([
    findLatestHoldout(root, approvedConfigHash),
    findLatestLifecycleEvidence(root, approvedConfigHash),
  ]);

  if (!latestHoldout || !latestCandidate) return null;

  return {
    version: 1,
    status: "AVAILABLE",
    network: latestHoldout.network,
    approvedConfigHash: latestHoldout.approvedConfigHash,
    evaluatedAt: latestHoldout.evaluatedAt,
    approvedAt: new Date().toISOString(),
    dataBoundary: latestCandidate.dataBoundary,
    holdout: {
      fixtures: latestHoldout.aggregate.fixtures,
      completeProtectedWindows:
        latestHoldout.aggregate.completeProtectedWindows,
      staleQuoteSeconds: latestHoldout.aggregate.staleQuoteSeconds,
      mispricingIntegral: latestHoldout.aggregate.mispricingIntegral,
      eventSuspensions: latestHoldout.aggregate.eventSuspensions,
      unconfirmedEventSuspensions:
        latestHoldout.aggregate.unconfirmedEventSuspensions,
      unconfirmedSuspensionRate:
        latestHoldout.aggregate.unconfirmedSuspensionRate ?? null,
    },
    lifecycleEvidence: {
      evidenceType: latestCandidate.evidenceType,
      lifecycleDurationMs: latestCandidate.lifecycleDurationMs,
      maximumProbabilityMove: latestCandidate.maximumProbabilityMove,
      txlineValidation: latestCandidate.txlineValidation,
      decisions: latestCandidate.decisions.map((decision) => ({
        action: decision.action,
        trigger: decision.trigger,
        fromMode: decision.fromMode,
        toMode: decision.toMode,
        elapsedMs: decision.elapsedMs,
        receiptHash: decision.receiptHash,
      })),
    },
  };
}

async function findLatestHoldout(
  dataRoot: string,
  approvedConfigHash?: string,
): Promise<PrivateHoldoutReport | null> {
  const files = await readdir(dataRoot).catch((error) => {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return [];
    }
    throw error;
  });
  const candidates = files.filter(
    (name) => name.startsWith("holdout-") && name.endsWith(".json"),
  );

  for (const file of candidates.sort().reverse()) {
    const report = (await safeParseJson(
      resolve(dataRoot, file),
      file,
    )) as PrivateHoldoutReport | null;
    if (!report) continue;

    if (
      report.status !== "AWAITING_PUBLIC_CLAIM_APPROVAL" ||
      !report.approvedConfigHash
    )
      continue;
    if (
      approvedConfigHash &&
      report.approvedConfigHash !== approvedConfigHash
    ) {
      continue;
    }
    if (
      typeof report.aggregate?.fixtures !== "number" ||
      !Number.isFinite(report.aggregate.fixtures)
    ) {
      continue;
    }
    return report;
  }

  return null;
}

async function findLatestLifecycleEvidence(
  dataRoot: string,
  approvedConfigHash?: string,
): Promise<PublicLifecycleCandidate | null> {
  const files = await readdir(dataRoot).catch((error) => {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return [];
    }
    throw error;
  });
  const candidates = files
    .filter(
      (name) =>
        name.startsWith("public-evidence-candidate-") && name.endsWith(".json"),
    )
    .sort()
    .reverse();

  for (const file of candidates) {
    const candidate = (await safeParseJson(
      resolve(dataRoot, file),
      file,
    )) as PublicLifecycleCandidate | null;
    if (!candidate) continue;

    if (
      candidate.status !== "AWAITING_HUMAN_APPROVAL" &&
      candidate.status !== "APPROVED" &&
      candidate.status !== "AVAILABLE"
    ) {
      continue;
    }
    if (approvedConfigHash && candidate.configHash !== approvedConfigHash) {
      continue;
    }
    if (candidate.decisions?.length) {
      return candidate;
    }
  }

  return null;
}

async function safeParseJson(path: string, label: string) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    console.warn(`Skipping unreadable public claim file: ${label}`);
    return null;
  }
}
