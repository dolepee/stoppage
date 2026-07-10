import { describe, expect, it } from "vitest";

import { QuoteGovernor } from "./governor.js";
import type {
  ConsensusQuote,
  GovernorConfig,
  MatchEvent,
  ProbabilityVector,
} from "./types.js";

const config: GovernorConfig = {
  sharpMoveThreshold: 0.04,
  stabilityEpsilon: 0.01,
  stableUpdatesRequired: 3,
  reopenDelayMs: 1_000,
  eventConfirmationWindowMs: 30_000,
  recoveryStableMs: 1_000,
};

describe("QuoteGovernor", () => {
  it("suspends, reprices, and reopens after an event-first move", () => {
    const governor = new QuoteGovernor(config);
    governor.process(quote("q0", 1_000, probabilities(0.4, 0.3, 0.3)));

    const suspended = governor.process(event("goal-1", 2_000));
    expect(suspended.map((receipt) => receipt.body.action)).toEqual([
      "SUSPEND",
    ]);
    expect(governor.getState(42).mode).toBe("SUSPENDED");

    governor.process(quote("q1", 2_500, probabilities(0.54, 0.25, 0.21)));
    governor.process(quote("q2", 2_700, probabilities(0.545, 0.247, 0.208)));
    const repriced = governor.process(
      quote("q3", 2_900, probabilities(0.548, 0.245, 0.207)),
    );
    expect(repriced.map((receipt) => receipt.body.action)).toEqual(["REPRICE"]);
    expect(governor.getState(42).mode).toBe("REPRICED");

    const reopened = governor.process({ kind: "tick", observedTs: 3_900 });
    expect(reopened.map((receipt) => receipt.body.action)).toEqual(["REOPEN"]);
    expect(governor.getState(42).mode).toBe("OPEN");
  });

  it("suspends a sharp move before an event and records later confirmation", () => {
    const governor = new QuoteGovernor(config);
    governor.process(quote("q0", 1_000, probabilities(0.4, 0.3, 0.3)));

    const suspended = governor.process(
      quote("q1", 2_000, probabilities(0.48, 0.27, 0.25)),
    );
    expect(suspended[0]?.body.trigger).toBe("UNBACKED_MOVE");

    governor.process(event("goal-1", 2_100));
    expect(governor.getState(42).pendingTrigger).toBe("EVENT_CONFIRMED_MOVE");
  });

  it("enters failsafe and requires a stable recovery window", () => {
    const governor = new QuoteGovernor(config);
    governor.process(quote("q0", 1_000, probabilities(0.4, 0.3, 0.3)));

    const failed = governor.process({
      kind: "stream-health",
      stream: "scores",
      healthy: false,
      observedTs: 2_000,
      reason: "heartbeat-timeout",
    });
    expect(failed[0]?.body.action).toBe("ENTER_FAILSAFE");

    governor.process({
      kind: "stream-health",
      stream: "scores",
      healthy: true,
      observedTs: 3_000,
    });
    expect(governor.process({ kind: "tick", observedTs: 3_999 })).toEqual([]);
    const recovered = governor.process({ kind: "tick", observedTs: 4_000 });
    expect(recovered[0]?.body.action).toBe("RECOVER_TO_SUSPENDED");
  });

  it("produces byte-identical hashes for identical inputs", () => {
    const first = runLifecycle();
    const second = runLifecycle();
    expect(first).toEqual(second);
  });

  it("waits for event confirmation after repricing before reopening", () => {
    const governor = new QuoteGovernor(config);
    governor.process(quote("q0", 1_000, probabilities(0.4, 0.3, 0.3)));
    governor.process(event("goal-1", 2_000, false));
    governor.process(quote("q1", 2_500, probabilities(0.54, 0.25, 0.21)));
    governor.process(quote("q2", 2_700, probabilities(0.545, 0.247, 0.208)));
    governor.process(quote("q3", 2_900, probabilities(0.548, 0.245, 0.207)));

    expect(governor.process({ kind: "tick", observedTs: 4_000 })).toEqual([]);
    const reopened = governor.process(event("goal-1", 4_100, true));
    expect(reopened.map((receipt) => receipt.body.action)).toEqual(["REOPEN"]);
    expect(governor.process(event("goal-1", 4_200, true))).toEqual([]);
  });

  it("allows a discarded incident to resolve the confirmation hold", () => {
    const governor = new QuoteGovernor(config);
    governor.process(quote("q0", 1_000, probabilities(0.4, 0.3, 0.3)));
    governor.process(event("goal-1", 2_000, false));
    governor.process(quote("q1", 2_500, probabilities(0.4, 0.3, 0.3)));
    governor.process(quote("q2", 2_700, probabilities(0.401, 0.299, 0.3)));
    governor.process(quote("q3", 2_900, probabilities(0.402, 0.298, 0.3)));

    const reopened = governor.process({
      kind: "event-resolution",
      fixtureId: 42,
      resolutionId: "discard-goal-1",
      incidentId: "goal-1",
      resolution: "DISCARDED",
      sourceTs: 4_000,
      receivedTs: 4_000,
    });
    expect(reopened.map((receipt) => receipt.body.action)).toEqual(["REOPEN"]);
  });

  it("ignores a discard record unrelated to an active incident", () => {
    const governor = new QuoteGovernor(config);
    governor.process(quote("q0", 1_000, probabilities(0.4, 0.3, 0.3)));
    governor.process(event("goal-1", 2_000, false));
    governor.process(quote("q1", 2_500, probabilities(0.4, 0.3, 0.3)));
    governor.process(quote("q2", 2_700, probabilities(0.401, 0.299, 0.3)));
    governor.process(quote("q3", 2_900, probabilities(0.402, 0.298, 0.3)));

    const ignored = governor.process({
      kind: "event-resolution",
      fixtureId: 42,
      resolutionId: "discard-unrelated",
      incidentId: "unrelated",
      resolution: "DISCARDED",
      sourceTs: 4_000,
      receivedTs: 4_000,
    });

    expect(ignored).toEqual([]);
    expect(governor.getState(42).pendingUnconfirmedIncidentIds).toEqual([
      "goal-1",
    ]);
  });

  it("suspends a repriced market again when a new incident arrives", () => {
    const governor = new QuoteGovernor(config);
    governor.process(quote("q0", 1_000, probabilities(0.4, 0.3, 0.3)));
    governor.process(event("goal-1", 2_000));
    governor.process(quote("q1", 2_500, probabilities(0.54, 0.25, 0.21)));
    governor.process(quote("q2", 2_700, probabilities(0.545, 0.247, 0.208)));
    governor.process(quote("q3", 2_900, probabilities(0.548, 0.245, 0.207)));
    expect(governor.getState(42).mode).toBe("REPRICED");

    const suspended = governor.process(event("red-card-2", 3_100, false));
    expect(suspended.map((receipt) => receipt.body.action)).toEqual([
      "SUSPEND",
    ]);
    expect(suspended[0]?.body.fromMode).toBe("REPRICED");
    expect(governor.getState(42).mode).toBe("SUSPENDED");
  });

  it("applies stream health observed before a fixture is created", () => {
    const governor = new QuoteGovernor(config);
    governor.process({
      kind: "stream-health",
      stream: "scores",
      healthy: false,
      observedTs: 500,
      reason: "stream-not-open",
    });

    governor.process(quote("q0", 1_000, probabilities(0.4, 0.3, 0.3)));

    expect(governor.getState(42)).toMatchObject({
      mode: "FAILSAFE",
      streamHealth: { odds: true, scores: false },
      pendingTrigger: "STREAM_UNHEALTHY",
    });
  });

  it("keeps an already-updated quote open when an older event arrives", () => {
    const governor = new QuoteGovernor(config);
    governor.process(quote("q0", 2_500, probabilities(0.5, 0.25, 0.25)));

    const receipts = governor.process(event("goal-1", 2_000, false, 3_000));

    expect(receipts).toEqual([]);
    expect(governor.getState(42)).toMatchObject({
      mode: "OPEN",
      pendingUnconfirmedIncidentIds: [],
    });
  });

  it("restarts the recovery window when either stream degrades again", () => {
    const governor = new QuoteGovernor(config);
    governor.process(quote("q0", 1_000, probabilities(0.4, 0.3, 0.3)));
    governor.process({
      kind: "stream-health",
      stream: "scores",
      healthy: false,
      observedTs: 2_000,
    });
    governor.process({
      kind: "stream-health",
      stream: "scores",
      healthy: true,
      observedTs: 3_000,
    });
    governor.process({
      kind: "stream-health",
      stream: "odds",
      healthy: false,
      observedTs: 3_600,
    });
    governor.process({
      kind: "stream-health",
      stream: "odds",
      healthy: true,
      observedTs: 4_000,
    });

    expect(governor.process({ kind: "tick", observedTs: 4_999 })).toEqual([]);
    expect(
      governor
        .process({ kind: "tick", observedTs: 5_000 })
        .map((receipt) => receipt.body.action),
    ).toEqual(["RECOVER_TO_SUSPENDED"]);
  });

  it("resets stability observations when a new incident arrives", () => {
    const governor = new QuoteGovernor(config);
    governor.process(quote("q0", 1_000, probabilities(0.4, 0.3, 0.3)));
    governor.process(event("goal-1", 2_000));
    governor.process(quote("q1", 2_400, probabilities(0.54, 0.25, 0.21)));
    governor.process(quote("q2", 2_600, probabilities(0.545, 0.247, 0.208)));

    expect(governor.getState(42).stableUpdateCount).toBe(2);
    expect(governor.process(event("red-card-2", 2_800))).toEqual([]);
    expect(governor.getState(42).stableUpdateCount).toBe(0);
    expect(
      governor.process(quote("q3", 2_900, probabilities(0.546, 0.246, 0.208))),
    ).toEqual([]);
    expect(governor.getState(42).stableUpdateCount).toBe(1);
  });
});

function runLifecycle() {
  const governor = new QuoteGovernor(config);
  governor.process(quote("q0", 1_000, probabilities(0.4, 0.3, 0.3)));
  governor.process(event("goal-1", 2_000));
  governor.process(quote("q1", 2_500, probabilities(0.54, 0.25, 0.21)));
  governor.process(quote("q2", 2_700, probabilities(0.545, 0.247, 0.208)));
  governor.process(quote("q3", 2_900, probabilities(0.548, 0.245, 0.207)));
  governor.process({ kind: "tick", observedTs: 3_900 });
  return governor.getState(42).receipts.map((receipt) => receipt.hash);
}

function quote(
  messageId: string,
  timestamp: number,
  vector: ProbabilityVector,
): ConsensusQuote {
  return {
    kind: "quote",
    fixtureId: 42,
    market: "1X2",
    messageId,
    sourceTs: timestamp,
    receivedTs: timestamp,
    probabilities: vector,
  };
}

function event(
  eventId: string,
  timestamp: number,
  confirmed = true,
  receivedTimestamp = timestamp,
): MatchEvent {
  return {
    kind: "match-event",
    fixtureId: 42,
    eventId: `${eventId}:${timestamp}`,
    incidentId: eventId,
    eventType: "GOAL",
    sourceTs: timestamp,
    receivedTs: receivedTimestamp,
    confirmed,
  };
}

function probabilities(
  home: number,
  draw: number,
  away: number,
): ProbabilityVector {
  return { HOME: home, DRAW: draw, AWAY: away };
}
