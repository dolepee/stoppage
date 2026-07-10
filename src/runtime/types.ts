import type {
  DecisionReceipt,
  GovernorMode,
  ProbabilityVector,
  StreamName,
} from "../domain/types.js";
import type { ReplayMatch } from "../replay/types.js";

export interface TimelineItem {
  id: string;
  at: number;
  kind: "INPUT" | "DECISION";
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
  failoverCount: number;
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
  match: ReplayMatch;
  mode: GovernorMode;
  currentProbability: ProbabilityVector | null;
  baselineProbability: ProbabilityVector | null;
  streamHealth: Record<StreamName, boolean>;
  configHash: string;
  timeline: TimelineItem[];
  receipts: DecisionReceipt[];
  metrics: RuntimeMetrics;
  updatedAt: string;
}
