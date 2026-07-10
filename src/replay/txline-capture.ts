import type { GovernorInput } from "../domain/types.js";
import {
  normalize1x2Quote,
  normalizeEventResolution,
  normalizeMatchEvent,
} from "../txline/normalize.js";
import { oddsPayloadSchema, scorePayloadSchema } from "../txline/types.js";

export interface PrivateTxLineCapture {
  fixtureId: number;
  scores: unknown[];
  odds: unknown[];
}

export function buildReplayInputs(capture: PrivateTxLineCapture) {
  const scores = capture.scores.map((score) => scorePayloadSchema.parse(score));
  const odds = capture.odds.map((quote) => oddsPayloadSchema.parse(quote));
  const participant1IsHome =
    (scores[0] as Record<string, unknown> | undefined)?.[
      "Participant1IsHome"
    ] !== false;
  const participants = participant1IsHome
    ? { home: "part1", away: "part2" }
    : { home: "part2", away: "part1" };

  const quoteIds = new Set<string>();
  const quotes = odds
    .filter(
      (quote) =>
        quote.SuperOddsType === "1X2_PARTICIPANT_RESULT" &&
        quote.InRunning &&
        quote.MarketPeriod == null,
    )
    .filter((quote) => {
      if (quoteIds.has(quote.MessageId)) return false;
      quoteIds.add(quote.MessageId);
      return true;
    })
    .map((quote) => normalize1x2Quote(quote, participants, quote.Ts))
    .filter((quote) => quote !== null);
  const events = scores
    .map((score) => normalizeMatchEvent(score, score.ts))
    .filter((event) => event !== null);
  const resolutions = scores
    .map((score) => normalizeEventResolution(score, score.ts))
    .filter((resolution) => resolution !== null);
  const inputs: GovernorInput[] = [...quotes, ...events, ...resolutions].sort(
    (left, right) => {
      const timeDifference = inputTimestamp(left) - inputTimestamp(right);
      if (timeDifference !== 0) return timeDifference;
      if (left.kind === right.kind) return 0;
      return left.kind === "match-event" ? -1 : 1;
    },
  );

  return { scores, odds, quotes, events, resolutions, inputs };
}

export function inputTimestamp(input: GovernorInput) {
  return input.kind === "quote" ||
    input.kind === "match-event" ||
    input.kind === "event-resolution"
    ? input.receivedTs
    : input.observedTs;
}
