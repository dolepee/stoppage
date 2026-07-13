import type {
  ConsensusQuote,
  EventResolution,
  MatchEvent,
  ProbabilityVector,
} from "../domain/types.js";
import type { ReplayScenario } from "./types.js";

const baseTs = Date.UTC(2026, 6, 10, 18, 0, 0);
const fixtureId = 9_000_001;

export const publicJudgeScenario: ReplayScenario = {
  id: "synthetic-var-overturn-v2",
  label: "VAR branch invalidation",
  dataMode: "SYNTHETIC",
  description:
    "A deterministic normalized fixture for judge-mode testing. It contains no TxLINE raw data.",
  match: {
    fixtureId,
    home: "Northbridge",
    away: "Eastport",
    competition: "Stoppage systems test",
    kickoffTs: baseTs - 68 * 60_000,
  },
  initialProbability: vector(0.45, 0.28, 0.27),
  steps: [
    {
      atMs: 0,
      label: "Opening 1X2 consensus",
      input: quote("synthetic-q0", 0, 80, vector(0.45, 0.28, 0.27)),
    },
    {
      atMs: 4_000,
      label: "Provisional home goal",
      input: matchEvent("synthetic-goal-1", 4_000, 4_240, false),
    },
    {
      atMs: 7_800,
      label: "Consensus begins repricing",
      input: quote("synthetic-q1", 7_600, 7_800, vector(0.57, 0.24, 0.19)),
    },
    {
      atMs: 8_800,
      label: "Consensus update 2/3",
      input: quote("synthetic-q2", 8_600, 8_800, vector(0.574, 0.237, 0.189)),
    },
    {
      atMs: 9_800,
      label: "Consensus stable 3/3",
      input: quote("synthetic-q3", 9_600, 9_800, vector(0.576, 0.235, 0.189)),
    },
    {
      atMs: 14_800,
      label: "Reopen vetoed · incident unresolved",
      input: { kind: "tick", observedTs: baseTs + 14_800 },
    },
    {
      atMs: 16_000,
      label: "VAR overturns the goal",
      input: discarded("synthetic-goal-1", 15_800, 16_000),
    },
    {
      atMs: 16_800,
      label: "Late provisional quote rejected",
      input: quote(
        "synthetic-stale-goal-branch",
        15_700,
        16_800,
        vector(0.577, 0.234, 0.189),
      ),
    },
    {
      atMs: 17_800,
      label: "Reverted branch consensus 1/3",
      input: quote("synthetic-q4", 17_600, 17_800, vector(0.46, 0.28, 0.26)),
    },
    {
      atMs: 18_800,
      label: "Reverted branch consensus 2/3",
      input: quote("synthetic-q5", 18_600, 18_800, vector(0.457, 0.282, 0.261)),
    },
    {
      atMs: 19_800,
      label: "Fresh post-VAR consensus 3/3",
      input: quote("synthetic-q6", 19_600, 19_800, vector(0.456, 0.282, 0.262)),
    },
    {
      atMs: 24_800,
      label: "Resolution-aware reopen certified",
      input: { kind: "tick", observedTs: baseTs + 24_800 },
    },
  ],
};

function quote(
  messageId: string,
  sourceOffset: number,
  receivedOffset: number,
  probabilities: ProbabilityVector,
): ConsensusQuote {
  return {
    kind: "quote",
    fixtureId,
    market: "1X2",
    messageId,
    sourceTs: baseTs + sourceOffset,
    receivedTs: baseTs + receivedOffset,
    probabilities,
  };
}

function matchEvent(
  eventId: string,
  sourceOffset: number,
  receivedOffset: number,
  confirmed = true,
): MatchEvent {
  return {
    kind: "match-event",
    fixtureId,
    eventId,
    incidentId: eventId,
    eventType: "GOAL",
    sourceTs: baseTs + sourceOffset,
    receivedTs: baseTs + receivedOffset,
    confirmed,
  };
}

function discarded(
  incidentId: string,
  sourceOffset: number,
  receivedOffset: number,
): EventResolution {
  return {
    kind: "event-resolution",
    fixtureId,
    resolutionId: `discard-${incidentId}`,
    incidentId,
    resolution: "DISCARDED",
    sourceTs: baseTs + sourceOffset,
    receivedTs: baseTs + receivedOffset,
  };
}

function vector(home: number, draw: number, away: number): ProbabilityVector {
  return { HOME: home, DRAW: draw, AWAY: away };
}
