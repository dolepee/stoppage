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
        : "REPRICED";
  const toMode =
    action === "SUSPEND"
      ? "SUSPENDED"
      : action === "REPRICE"
        ? "REPRICED"
        : "OPEN";
  return {
    body: {
      version: 1,
      fixtureId: 42,
      market: "1X2",
      action,
      trigger: "UNBACKED_MOVE",
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
