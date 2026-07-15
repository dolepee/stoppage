export type Selection = "HOME" | "DRAW" | "AWAY";
export type ProbabilityVector = Record<Selection, number>;
export type GovernorMode = "OPEN" | "SUSPENDED" | "REPRICED" | "FAILSAFE";

export interface DecisionReceipt {
  body: {
    action: string;
    trigger: string;
    fromMode: GovernorMode;
    toMode: GovernorMode;
    observedTs: number;
    sourceIds: string[];
    configHash: string;
  };
  hash: string;
}

export interface ReopenProof {
  body: {
    version: 1 | 2;
    kind: "CERTIFIED_REOPEN";
    fixtureId: number;
    market: "1X2";
    reopenReceiptHash: string;
    configHash: string;
    observedTs: number;
    checks: {
      oddsStreamHealthy: true;
      scoresStreamHealthy: true;
      unresolvedIncidentCount: 0;
      stableUpdatesObserved: number;
      stableUpdatesRequired: number;
      repriceAgeMs: number;
      reopenDelayMs: number;
      quotePresent: true;
      policyRevision?: 2;
      resolutionOutcome?: "CONFIRMED" | "DISCARDED" | "NOT_REQUIRED";
      resolutionSourceTs?: number | null;
      resolutionObservedTs?: number | null;
      firstPostResolutionQuoteSourceTs?: number | null;
      firstPostResolutionQuoteTs?: number | null;
      postResolutionQuoteCount?: number;
      freshQuoteRequired?: boolean;
      freshQuoteObserved?: boolean;
    };
  };
  hash: string;
}

export interface TimelineItem {
  id: string;
  at: number;
  kind: "INPUT" | "DECISION" | "AGENT";
  label: string;
  detail: string;
  mode?: GovernorMode;
  receiptHash?: string;
}

export interface RuntimeSnapshot {
  version: 2;
  scenarioId: string;
  scenarioLabel: string;
  dataMode: "SYNTHETIC" | "TXLINE_REPLAY";
  dataDescription: string;
  replayStatus: "IDLE" | "RUNNING" | "COMPLETE" | "STOPPED";
  replaySpeed: number;
  replayElapsedMs: number;
  match: {
    fixtureId: number;
    home: string;
    away: string;
    competition: string;
    kickoffTs: number;
  };
  mode: GovernorMode;
  currentProbability: ProbabilityVector | null;
  baselineProbability: ProbabilityVector | null;
  streamHealth: { odds: boolean; scores: boolean };
  configHash: string;
  timeline: TimelineItem[];
  receipts: DecisionReceipt[];
  reopenProofs: ReopenProof[];
  execution: {
    subjectHash: string;
    sequence: number;
    permitTtlMs: number;
    agent: {
      version: 1;
      name: "External market-maker";
      command: "PUBLISH_QUOTE";
      decision: "WAITING" | "BLOCK" | "ALLOW";
      decisionCode:
        | "BLOCK_UNRESOLVED_INCIDENT"
        | "BLOCK_INVALIDATED_BRANCH"
        | "BLOCK_STREAM_UNHEALTHY"
        | "BLOCK_QUOTE_STALE"
        | "BLOCK_PERMIT_EXPIRED"
        | "ALLOW_HEALTHY_QUOTE"
        | "ALLOW_CERTIFIED_REOPEN"
        | null;
      reason: string;
      result: "NO_QUOTE" | "QUOTE_BLOCKED" | "SIMULATED_QUOTE_PUBLISHED";
      requestedQuoteHash: string | null;
      permit: {
        body: {
          version: 1;
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
        };
        hash: string;
      } | null;
      permitVerified: boolean;
      attemptedAt: number | null;
      simulated: true;
    };
  };
  metrics: {
    suspensionReactionMs: number | null;
    staleQuoteSeconds: number | null;
    mispricingIntegral: number | null;
    maximumProbabilityDivergence: number | null;
    invalidatedReprices: number;
    failoverCount: number;
    protectedWindowSeconds: number;
    currentBranchDisplacement: number | null;
  };
  updatedAt: string;
}

export interface WorkerHealthSnapshot {
  available: boolean;
  configured: boolean;
  running?: boolean;
  statusFresh?: boolean;
  fixturesLoaded?: number;
  messages?: {
    odds: number;
    scores: number;
  };
  normalizedOdds?: number;
  normalizedEvents?: number;
  reconnects?: {
    odds: number;
    scores: number;
  };
  fixtureRefreshes?: number;
  fixtureRefreshFailures?: number;
  streamHealth?: {
    odds: boolean;
    scores: boolean;
  };
  lastMessageAgeMs?: {
    odds: number | null;
    scores: number | null;
  };
  updatedAt?: string;
}
