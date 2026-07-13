import type {
  DecisionReceipt,
  GovernorMode,
  ProbabilityVector,
  ReopenProof,
  StreamName,
} from "../domain/types.js";
import type { ReferenceAgentSnapshot } from "../execution-gate/reference-agent.js";
import type { ReplayMatch } from "../replay/types.js";

export interface TimelineItem {
  id: string;
  at: number;
  kind: "INPUT" | "DECISION" | "AGENT";
  label: string;
  detail: string;
  mode?: GovernorMode;
  receiptHash?: string;
}

export interface RuntimeMetrics {
  suspensionReactionMs: number | null;
  staleQuoteSeconds: number | null;
  mispricingIntegral: number | null;
  maximumProbabilityDivergence: number | null;
  invalidatedReprices: number;
  failoverCount: number;
  protectedWindowSeconds: number;
  currentBranchDisplacement: number | null;
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
  match: ReplayMatch;
  mode: GovernorMode;
  currentProbability: ProbabilityVector | null;
  baselineProbability: ProbabilityVector | null;
  streamHealth: Record<StreamName, boolean>;
  configHash: string;
  timeline: TimelineItem[];
  receipts: DecisionReceipt[];
  reopenProofs: ReopenProof[];
  execution: {
    subjectHash: string;
    sequence: number;
    permitTtlMs: number;
    agent: ReferenceAgentSnapshot;
  };
  metrics: RuntimeMetrics;
  updatedAt: string;
}
