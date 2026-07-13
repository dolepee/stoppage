import { describe, expect, it } from "vitest";

import { sha256 } from "./canonical.js";
import { QuoteGovernor } from "./governor.js";
import { verifyReopenProof } from "./reopen-proof.js";
import type {
  ConsensusQuote,
  DecisionReceipt,
  GovernorConfig,
  ProbabilityVector,
  ReopenProof,
} from "./types.js";

const config: GovernorConfig = {
  sharpMoveThreshold: 0.04,
  stabilityEpsilon: 0.01,
  stableUpdatesRequired: 3,
  reopenDelayMs: 1_000,
  eventConfirmationWindowMs: 30_000,
  recoveryStableMs: 1_000,
  postResolutionFreshQuotesRequired: true,
};

describe("Certified Reopen", () => {
  it("binds every satisfied reopen gate to the exact decision receipt", () => {
    const governor = completedLifecycle();
    const state = governor.getState(42);
    const receipt = state.receipts.at(-1)!;
    const proof = governor.getReopenProofs(42).at(-1)!;

    expect(receipt.body.action).toBe("REOPEN");
    expect(proof.body).toMatchObject({
      kind: "CERTIFIED_REOPEN",
      reopenReceiptHash: receipt.hash,
      configHash: governor.configHash,
      checks: {
        oddsStreamHealthy: true,
        scoresStreamHealthy: true,
        unresolvedIncidentCount: 0,
        stableUpdatesObserved: 3,
        stableUpdatesRequired: 3,
        repriceAgeMs: 1_000,
        reopenDelayMs: 1_000,
        quotePresent: true,
        policyRevision: 2,
        resolutionOutcome: "CONFIRMED",
        resolutionSourceTs: 2_000,
        firstPostResolutionQuoteSourceTs: 2_500,
        postResolutionQuoteCount: 3,
        freshQuoteRequired: true,
        freshQuoteObserved: true,
      },
    });
    expect(verifyReopenProof(proof, receipt)).toBe(true);
  });

  it("does not certify suspend or reprice decisions", () => {
    const governor = new QuoteGovernor(config);
    governor.process(quote("q0", 1_000, probabilities(0.4, 0.3, 0.3)));
    governor.process(event(2_000));
    governor.process(quote("q1", 2_500, probabilities(0.54, 0.25, 0.21)));
    governor.process(quote("q2", 2_700, probabilities(0.545, 0.247, 0.208)));
    governor.process(quote("q3", 2_900, probabilities(0.548, 0.245, 0.207)));

    expect(governor.getState(42).mode).toBe("REPRICED");
    expect(governor.getReopenProofs(42)).toEqual([]);
  });

  it("rejects a modified proof or a different reopen receipt", () => {
    const governor = completedLifecycle();
    const state = governor.getState(42);
    const receipt = state.receipts.at(-1)!;
    const proof = governor.getReopenProofs(42).at(-1)!;
    const tampered = structuredClone(proof) as ReopenProof;
    tampered.body.checks.stableUpdatesObserved = 9;

    expect(verifyReopenProof(tampered, receipt)).toBe(false);

    const differentReceipt = structuredClone(receipt) as DecisionReceipt;
    differentReceipt.body.observedTs += 1;
    differentReceipt.hash = sha256(differentReceipt.body);
    expect(verifyReopenProof(proof, differentReceipt)).toBe(false);
  });

  it("rejects a V2 certificate that claims pre-resolution odds were fresh", () => {
    const governor = completedLifecycle();
    const receipt = governor.getState(42).receipts.at(-1)!;
    const proof = governor.getReopenProofs(42).at(-1)!;
    const tampered = structuredClone(proof) as ReopenProof;

    expect(tampered.body.version).toBe(2);
    if (tampered.body.version !== 2) throw new Error("Expected V2 proof");
    tampered.body.checks.firstPostResolutionQuoteTs =
      tampered.body.checks.resolutionObservedTs;
    tampered.hash = sha256(tampered.body);

    expect(verifyReopenProof(tampered, receipt)).toBe(false);
  });

  it("rejects a V2 certificate whose source quote predates resolution", () => {
    const governor = completedLifecycle();
    const receipt = governor.getState(42).receipts.at(-1)!;
    const proof = governor.getReopenProofs(42).at(-1)!;
    const tampered = structuredClone(proof) as ReopenProof;

    if (tampered.body.version !== 2) throw new Error("Expected V2 proof");
    tampered.body.checks.firstPostResolutionQuoteSourceTs =
      tampered.body.checks.resolutionSourceTs;
    tampered.hash = sha256(tampered.body);

    expect(verifyReopenProof(tampered, receipt)).toBe(false);
  });

  it("waits for an unresolved incident instead of issuing a certificate", () => {
    const governor = new QuoteGovernor(config);
    governor.process(quote("q0", 1_000, probabilities(0.4, 0.3, 0.3)));
    governor.process(event(2_000, false));
    governor.process(quote("q1", 2_500, probabilities(0.54, 0.25, 0.21)));
    governor.process(quote("q2", 2_700, probabilities(0.545, 0.247, 0.208)));
    governor.process(quote("q3", 2_900, probabilities(0.548, 0.245, 0.207)));

    expect(governor.process({ kind: "tick", observedTs: 3_900 })).toEqual([]);
    expect(governor.getReopenProofs(42)).toEqual([]);

    const invalidated = governor.process(event(4_000, true));
    expect(invalidated.at(-1)?.body.action).toBe("INVALIDATE_REPRICE");
    expect(governor.getReopenProofs(42)).toHaveLength(0);

    governor.process(quote("q4", 4_200, probabilities(0.55, 0.244, 0.206)));
    governor.process(quote("q5", 4_400, probabilities(0.551, 0.243, 0.206)));
    governor.process(quote("q6", 4_600, probabilities(0.552, 0.242, 0.206)));
    const reopened = governor.process({ kind: "tick", observedTs: 5_600 });
    expect(reopened.at(-1)?.body.action).toBe("REOPEN");
    expect(governor.getReopenProofs(42)).toHaveLength(1);
  });

  it("certifies reopening after a provisional incident is explicitly discarded", () => {
    const governor = new QuoteGovernor(config);
    governor.process(quote("q0", 1_000, probabilities(0.4, 0.3, 0.3)));
    governor.process(event(2_000, false));
    governor.process(quote("q1", 2_500, probabilities(0.4, 0.3, 0.3)));
    governor.process(quote("q2", 2_700, probabilities(0.401, 0.299, 0.3)));
    governor.process(quote("q3", 2_900, probabilities(0.402, 0.298, 0.3)));

    const invalidated = governor.process({
      kind: "event-resolution",
      fixtureId: 42,
      resolutionId: "discard-goal-1",
      incidentId: "goal-1",
      resolution: "DISCARDED",
      sourceTs: 4_000,
      receivedTs: 4_000,
    });
    expect(invalidated.at(-1)?.body.action).toBe("INVALIDATE_REPRICE");
    expect(governor.getReopenProofs(42)).toHaveLength(0);

    governor.process(quote("q4", 4_200, probabilities(0.4, 0.3, 0.3)));
    governor.process(quote("q5", 4_400, probabilities(0.401, 0.299, 0.3)));
    governor.process(quote("q6", 4_600, probabilities(0.402, 0.298, 0.3)));
    const reopened = governor.process({ kind: "tick", observedTs: 5_600 });
    const proof = governor.getReopenProofs(42).at(-1)!;

    expect(reopened.at(-1)?.body.action).toBe("REOPEN");
    expect(proof.body).toMatchObject({
      version: 2,
      checks: {
        unresolvedIncidentCount: 0,
        resolutionOutcome: "DISCARDED",
        postResolutionQuoteCount: 3,
        freshQuoteRequired: true,
        freshQuoteObserved: true,
      },
    });
    expect(verifyReopenProof(proof, reopened.at(-1)!)).toBe(true);
  });
});

function completedLifecycle() {
  const governor = new QuoteGovernor(config);
  governor.process(quote("q0", 1_000, probabilities(0.4, 0.3, 0.3)));
  governor.process(event(2_000));
  governor.process(quote("q1", 2_500, probabilities(0.54, 0.25, 0.21)));
  governor.process(quote("q2", 2_700, probabilities(0.545, 0.247, 0.208)));
  governor.process(quote("q3", 2_900, probabilities(0.548, 0.245, 0.207)));
  governor.process({ kind: "tick", observedTs: 3_900 });
  return governor;
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

function event(timestamp: number, confirmed = true) {
  return {
    kind: "match-event" as const,
    fixtureId: 42,
    eventId: `goal-1:${timestamp}`,
    incidentId: "goal-1",
    eventType: "GOAL" as const,
    sourceTs: timestamp,
    receivedTs: timestamp,
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
