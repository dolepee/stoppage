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
  metrics: {
    suspensionReactionMs: number | null;
    staleQuoteSeconds: number | null;
    mispricingIntegral: number | null;
    maximumProbabilityDivergence: number | null;
    failoverCount: number;
  };
  updatedAt: string;
}
