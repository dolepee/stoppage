import type {
  ConsensusQuote,
  MatchEvent,
  ProbabilityVector,
  StreamHealth,
} from "../domain/types.js";
import type { ReplayScenario } from "./types.js";

const baseTs = Date.UTC(2026, 6, 10, 18, 0, 0);
const fixtureId = 9_000_001;

export const publicJudgeScenario: ReplayScenario = {
  id: "synthetic-event-first-v1",
  label: "Event-first quote protection",
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
      label: "Home goal confirmed",
      input: matchEvent("synthetic-goal-1", 4_000, 4_240),
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
      label: "Reopen delay passed",
      input: { kind: "tick", observedTs: baseTs + 14_800 },
    },
    {
      atMs: 17_800,
      label: "Scores heartbeat timeout drill",
      input: health("scores", false, 17_800, "heartbeat-timeout"),
    },
    {
      atMs: 19_800,
      label: "Scores stream restored",
      input: health("scores", true, 19_800),
    },
    {
      atMs: 24_800,
      label: "Recovery window passed",
      input: { kind: "tick", observedTs: baseTs + 24_800 },
    },
    {
      atMs: 25_800,
      label: "Recovery consensus 1/3",
      input: quote("synthetic-q4", 25_600, 25_800, vector(0.576, 0.235, 0.189)),
    },
    {
      atMs: 26_800,
      label: "Recovery consensus 2/3",
      input: quote("synthetic-q5", 26_600, 26_800, vector(0.578, 0.234, 0.188)),
    },
    {
      atMs: 27_800,
      label: "Recovery consensus stable",
      input: quote("synthetic-q6", 27_600, 27_800, vector(0.577, 0.234, 0.189)),
    },
    {
      atMs: 32_800,
      label: "Fail-safe recovery complete",
      input: { kind: "tick", observedTs: baseTs + 32_800 },
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
): MatchEvent {
  return {
    kind: "match-event",
    fixtureId,
    eventId,
    eventType: "GOAL",
    sourceTs: baseTs + sourceOffset,
    receivedTs: baseTs + receivedOffset,
    confirmed: true,
  };
}

function health(
  stream: "odds" | "scores",
  healthy: boolean,
  offset: number,
  reason?: string,
): StreamHealth {
  return {
    kind: "stream-health",
    stream,
    healthy,
    observedTs: baseTs + offset,
    ...(reason ? { reason } : {}),
  };
}

function vector(home: number, draw: number, away: number): ProbabilityVector {
  return { HOME: home, DRAW: draw, AWAY: away };
}
