import { describe, expect, it } from "vitest";

import type {
  ConsensusQuote,
  DecisionReceipt,
  ProbabilityVector,
} from "../domain/types.js";
import { completeLifecycles } from "./lifecycles.js";

describe("completeLifecycles", () => {
  it("compares an odds-first trigger with the quote before it", () => {
    const inputs = [
      quote("before", 1_000, probabilities(0.4, 0.3, 0.3)),
      quote("trigger", 2_000, probabilities(0.5, 0.25, 0.25)),
      quote("stable", 3_000, probabilities(0.51, 0.245, 0.245)),
    ];
    const receipts = [
      receipt("SUSPEND", 2_000, ["trigger"], "suspend"),
      receipt(
        "REPRICE",
        3_000,
        ["trigger", "stable"],
        "reprice",
        probabilities(0.51, 0.245, 0.245),
      ),
      receipt("REOPEN", 4_000, ["trigger", "stable"], "reopen"),
    ];

    const [lifecycle] = completeLifecycles(receipts, inputs);

    expect(lifecycle?.maximumProbabilityMove).toBeCloseTo(0.11);
    expect(lifecycle?.decisionHashes).toEqual(["suspend", "reprice", "reopen"]);
    expect(lifecycle?.preResolutionRepricesInvalidated).toBe(0);
  });

  it("retains an invalidated branch in the completed decision path", () => {
    const inputs = [
      quote("before", 1_000, probabilities(0.4, 0.3, 0.3)),
      quote("provisional", 2_500, probabilities(0.52, 0.26, 0.22)),
      quote("fresh", 4_000, probabilities(0.41, 0.3, 0.29)),
    ];
    const receipts = [
      receipt("SUSPEND", 2_000, ["goal"], "suspend"),
      receipt(
        "REPRICE",
        2_500,
        ["provisional"],
        "provisional-reprice",
        probabilities(0.52, 0.26, 0.22),
      ),
      receipt("INVALIDATE_REPRICE", 3_000, ["var-overturn"], "invalidate"),
      receipt(
        "REPRICE",
        4_000,
        ["fresh"],
        "fresh-reprice",
        probabilities(0.41, 0.3, 0.29),
      ),
      receipt("REOPEN", 5_000, ["fresh"], "reopen"),
    ];

    const [lifecycle] = completeLifecycles(receipts, inputs);

    expect(lifecycle).toMatchObject({
      decisionHashes: [
        "suspend",
        "provisional-reprice",
        "invalidate",
        "fresh-reprice",
        "reopen",
      ],
      preResolutionRepricesInvalidated: 1,
      repriceHash: "fresh-reprice",
    });
  });
});

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

function receipt(
  action: DecisionReceipt["body"]["action"],
  observedTs: number,
  sourceIds: string[],
  hash: string,
  quoteVector?: ProbabilityVector,
): DecisionReceipt {
  const fromMode =
    action === "SUSPEND"
      ? "OPEN"
      : action === "REPRICE"
        ? "SUSPENDED"
        : action === "INVALIDATE_REPRICE"
          ? "REPRICED"
          : "REPRICED";
  const toMode =
    action === "SUSPEND"
      ? "SUSPENDED"
      : action === "REPRICE"
        ? "REPRICED"
        : action === "INVALIDATE_REPRICE"
          ? "SUSPENDED"
          : "OPEN";
  return {
    body: {
      version: 1,
      fixtureId: 42,
      market: "1X2",
      action,
      trigger:
        action === "INVALIDATE_REPRICE"
          ? "RESOLUTION_DISCARDED"
          : "UNBACKED_MOVE",
      fromMode,
      toMode,
      observedTs,
      sourceIds,
      ...(quoteVector ? { quote: quoteVector } : {}),
      configHash: "config-hash",
    },
    hash,
  };
}

function probabilities(
  home: number,
  draw: number,
  away: number,
): ProbabilityVector {
  return { HOME: home, DRAW: draw, AWAY: away };
}
