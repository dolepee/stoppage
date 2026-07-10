import type {
  ConsensusQuote,
  MatchEvent,
  MatchEventType,
  ProbabilityVector,
  Selection,
} from "../domain/types.js";
import type { OddsPayload, ScorePayload } from "./types.js";

export interface FixtureParticipants {
  home: string;
  away: string;
}

export function normalize1x2Quote(
  payload: OddsPayload,
  participants: FixtureParticipants,
  receivedTs = Date.now(),
): ConsensusQuote | null {
  if (
    !payload.InRunning ||
    payload.Pct?.length !== 3 ||
    payload.PriceNames?.length !== 3
  ) {
    return null;
  }

  const indexes = resolveSelectionIndexes(payload.PriceNames, participants);
  if (!indexes) return null;

  const rawPercentages = payload.Pct.map((value) => Number(value));
  if (rawPercentages.some((value) => !Number.isFinite(value) || value < 0)) {
    return null;
  }
  const total = rawPercentages.reduce((sum, value) => sum + value, 0);
  if (total <= 0) return null;

  const probabilities: ProbabilityVector = {
    HOME: rawPercentages[indexes.HOME]! / total,
    DRAW: rawPercentages[indexes.DRAW]! / total,
    AWAY: rawPercentages[indexes.AWAY]! / total,
  };

  return {
    kind: "quote",
    fixtureId: payload.FixtureId,
    market: "1X2",
    messageId: payload.MessageId,
    sourceTs: payload.Ts,
    receivedTs,
    probabilities,
  };
}

export function normalizeMatchEvent(
  payload: ScorePayload,
  receivedTs = Date.now(),
): MatchEvent | null {
  const eventType = matchEventType(payload);
  if (!eventType) return null;

  return {
    kind: "match-event",
    fixtureId: payload.fixtureId,
    eventId: `score:${payload.fixtureId}:${payload.id}:${payload.seq}`,
    eventType,
    sourceTs: payload.ts,
    receivedTs,
    confirmed: payload.confirmed !== false,
  };
}

function resolveSelectionIndexes(
  priceNames: string[],
  participants: FixtureParticipants,
): Record<Selection, number> | null {
  const normalized = priceNames.map(normalizeLabel);
  const drawIndex = normalized.findIndex(
    (label) => label === "x" || label === "draw",
  );
  if (drawIndex < 0) return null;

  const homeIndex = findTeamIndex(normalized, participants.home, ["1", "home"]);
  const awayIndex = findTeamIndex(normalized, participants.away, ["2", "away"]);

  if (homeIndex >= 0 && awayIndex >= 0 && homeIndex !== awayIndex) {
    return { HOME: homeIndex, DRAW: drawIndex, AWAY: awayIndex };
  }

  const remaining = [0, 1, 2].filter((index) => index !== drawIndex);
  if (remaining.length !== 2) return null;
  return { HOME: remaining[0]!, DRAW: drawIndex, AWAY: remaining[1]! };
}

function findTeamIndex(
  normalizedNames: string[],
  team: string,
  aliases: string[],
) {
  const normalizedTeam = normalizeLabel(team);
  return normalizedNames.findIndex(
    (name) => name === normalizedTeam || aliases.includes(name),
  );
}

function normalizeLabel(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

function matchEventType(payload: ScorePayload): MatchEventType | null {
  const action = payload.action.toLowerCase().replace(/[^a-z]+/g, "_");
  const data = payload.dataSoccer ?? {};

  if (action.includes("goal") || data["Goal"] === true) return "GOAL";
  if (action.includes("red_card") || data["RedCard"] === true)
    return "RED_CARD";
  if (action.includes("penalty") || data["Penalty"] === true) return "PENALTY";
  if (action === "var" || action === "var_end" || data["VAR"] === true)
    return "VAR";
  return null;
}
