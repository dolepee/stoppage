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
    version: 1;
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
    };
  };
  hash: string;
}

export interface TimelineItem {
  id: string;
  at: number;
  kind: "INPUT" | "DECISION";
  label: string;
  detail: string;
  mode?: GovernorMode;
  receiptHash?: string;
}

export interface RuntimeSnapshot {
  version: 1;
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
  metrics: {
    suspensionReactionMs: number | null;
    staleQuoteSeconds: number | null;
    mispricingIntegral: number | null;
    maximumProbabilityDivergence: number | null;
    failoverCount: number;
  };
  updatedAt: string;
}
