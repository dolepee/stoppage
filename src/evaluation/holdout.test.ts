import { describe, expect, it } from "vitest";

import { DEFAULT_GOVERNOR_CONFIG } from "../domain/governor.js";
import type {
  ConsensusQuote,
  GovernorInput,
  MatchEvent,
  ProbabilityVector,
} from "../domain/types.js";
import { publicJudgeScenario } from "../replay/public-scenario.js";
import { evaluateHoldout } from "./holdout.js";

describe("evaluateHoldout", () => {
  it("measures protected windows without money units or future inputs", () => {
    const evaluation = evaluateHoldout(
      publicJudgeScenario.steps.map((step) => step.input),
      DEFAULT_GOVERNOR_CONFIG,
    );

    expect(evaluation.sample.completeProtectedWindows).toBe(1);
    expect(evaluation.sample.incompleteProtectedWindow).toBe(false);
    expect(evaluation.metrics.staleQuoteSeconds).toBeCloseTo(20.56);
    expect(evaluation.metrics.eventLedProtectedWindows).toBe(1);
    expect(evaluation.metrics.oddsLedProtectedWindows).toBe(0);
    expect(evaluation.metrics.unconfirmedOddsLedSuspensionRate).toBeNull();
    expect(evaluation.metrics).toMatchObject({
      preResolutionRepricesInvalidated: 1,
      postResolutionCertifiedReopens: 1,
      confirmedResolutionCertifiedReopens: 0,
      discardedResolutionCertifiedReopens: 1,
    });
    expect(evaluation.windows[0]).toMatchObject({
      initialTrigger: "EVENT_BEFORE_REPRICE",
      finalTrigger: "EVENT_BEFORE_REPRICE",
      reopenLatencyMs: 20_560,
    });
    expect(evaluation.windows[0]?.staleQuoteSeconds).toBeCloseTo(20.56);
  });

  it("labels an odds-led window unconfirmed when no event supports it", () => {
    const evaluation = evaluateHoldout(
      oddsLedLifecycle(false),
      DEFAULT_GOVERNOR_CONFIG,
    );

    expect(evaluation.metrics).toMatchObject({
      eventLedProtectedWindows: 0,
      oddsLedProtectedWindows: 1,
      confirmedOddsLedProtectedWindows: 0,
      unconfirmedOddsLedProtectedWindows: 1,
      unconfirmedOddsLedSuspensionRate: 1,
      preResolutionRepricesInvalidated: 0,
      postResolutionCertifiedReopens: 0,
    });
    expect(evaluation.windows[0]).toMatchObject({
      initialTrigger: "UNBACKED_MOVE",
      finalTrigger: "UNBACKED_MOVE",
    });
  });

  it("records later event support for an odds-led window", () => {
    const evaluation = evaluateHoldout(
      oddsLedLifecycle(true),
      DEFAULT_GOVERNOR_CONFIG,
    );

    expect(evaluation.metrics).toMatchObject({
      eventLedProtectedWindows: 0,
      oddsLedProtectedWindows: 1,
      confirmedOddsLedProtectedWindows: 1,
      unconfirmedOddsLedProtectedWindows: 0,
      unconfirmedOddsLedSuspensionRate: 0,
      preResolutionRepricesInvalidated: 0,
      postResolutionCertifiedReopens: 1,
      confirmedResolutionCertifiedReopens: 1,
      discardedResolutionCertifiedReopens: 0,
    });
    expect(evaluation.windows[0]).toMatchObject({
      initialTrigger: "UNBACKED_MOVE",
      finalTrigger: "EVENT_CONFIRMED_MOVE",
    });
  });
});

function oddsLedLifecycle(withSupportingEvent: boolean): GovernorInput[] {
  const inputs: GovernorInput[] = [
    quote("q0", 1_000, vector(0.4, 0.3, 0.3)),
    quote("q1", 2_000, vector(0.48, 0.27, 0.25)),
  ];
  if (withSupportingEvent) inputs.push(event("goal-1", 2_100));
  inputs.push(
    quote("q2", 2_500, vector(0.482, 0.269, 0.249)),
    quote("q3", 2_700, vector(0.483, 0.268, 0.249)),
    quote("q4", 2_900, vector(0.484, 0.267, 0.249)),
    { kind: "tick", observedTs: 8_000 },
  );
  return inputs;
}

function quote(
  messageId: string,
  timestamp: number,
  probabilities: ProbabilityVector,
): ConsensusQuote {
  return {
    kind: "quote",
    fixtureId: 42,
    market: "1X2",
    messageId,
    sourceTs: timestamp,
    receivedTs: timestamp,
    probabilities,
  };
}

function event(incidentId: string, timestamp: number): MatchEvent {
  return {
    kind: "match-event",
    fixtureId: 42,
    eventId: `${incidentId}:${timestamp}`,
    incidentId,
    eventType: "GOAL",
    sourceTs: timestamp,
    receivedTs: timestamp,
    confirmed: true,
  };
}

function vector(home: number, draw: number, away: number): ProbabilityVector {
  return { HOME: home, DRAW: draw, AWAY: away };
}
