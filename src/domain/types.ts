export type FixtureId = number;
export type Market = "1X2";
export type Selection = "HOME" | "DRAW" | "AWAY";
export type ProbabilityVector = Record<Selection, number>;

export type GovernorMode = "OPEN" | "SUSPENDED" | "REPRICED" | "FAILSAFE";

export type TriggerCode =
  | "EVENT_BEFORE_REPRICE"
  | "UNBACKED_MOVE"
  | "EVENT_CONFIRMED_MOVE"
  | "VOLATILITY_SPIKE"
  | "STREAM_UNHEALTHY";

export type DecisionAction =
  "SUSPEND" | "REPRICE" | "REOPEN" | "ENTER_FAILSAFE" | "RECOVER_TO_SUSPENDED";

export type MatchEventType = "GOAL" | "RED_CARD" | "PENALTY" | "VAR";
export type StreamName = "odds" | "scores";

export interface ConsensusQuote {
  kind: "quote";
  fixtureId: FixtureId;
  market: Market;
  messageId: string;
  sourceTs: number;
  receivedTs: number;
  probabilities: ProbabilityVector;
}

export interface MatchEvent {
  kind: "match-event";
  fixtureId: FixtureId;
  eventId: string;
  incidentId: string;
  eventType: MatchEventType;
  sourceTs: number;
  receivedTs: number;
  confirmed: boolean;
}

export interface EventResolution {
  kind: "event-resolution";
  fixtureId: FixtureId;
  resolutionId: string;
  incidentId: string;
  resolution: "DISCARDED";
  sourceTs: number;
  receivedTs: number;
}

export interface StreamHealth {
  kind: "stream-health";
  stream: StreamName;
  healthy: boolean;
  observedTs: number;
  reason?: string;
}

export interface ClockTick {
  kind: "tick";
  observedTs: number;
}

export type GovernorInput =
  ConsensusQuote | MatchEvent | EventResolution | StreamHealth | ClockTick;

export interface GovernorConfig {
  sharpMoveThreshold: number;
  stabilityEpsilon: number;
  stableUpdatesRequired: number;
  reopenDelayMs: number;
  eventConfirmationWindowMs: number;
  recoveryStableMs: number;
}

export interface DecisionReceiptBody {
  version: 1;
  fixtureId: FixtureId;
  market: Market;
  action: DecisionAction;
  trigger: TriggerCode;
  fromMode: GovernorMode;
  toMode: GovernorMode;
  observedTs: number;
  sourceIds: string[];
  quote?: ProbabilityVector;
  configHash: string;
}

export interface DecisionReceipt {
  body: DecisionReceiptBody;
  hash: string;
}

export interface ReopenProofBody {
  version: 1;
  kind: "CERTIFIED_REOPEN";
  fixtureId: FixtureId;
  market: Market;
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
}

export interface ReopenProof {
  body: ReopenProofBody;
  hash: string;
}

export interface FixtureGovernorState {
  fixtureId: FixtureId;
  market: Market;
  mode: GovernorMode;
  quote: ConsensusQuote | null;
  preTriggerQuote: ConsensusQuote | null;
  candidateQuote: ConsensusQuote | null;
  stableUpdateCount: number;
  suspendedAt: number | null;
  repricedAt: number | null;
  lastHighImpactEvent: MatchEvent | null;
  seenEventIncidentIds: string[];
  pendingUnconfirmedIncidentIds: string[];
  pendingTrigger: TriggerCode | null;
  pendingSourceIds: string[];
  streamHealth: Record<StreamName, boolean>;
  bothStreamsHealthySince: number | null;
  receipts: DecisionReceipt[];
}
