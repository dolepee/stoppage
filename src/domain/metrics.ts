import { maximumProbabilityMove } from "./probability.js";
import type { ProbabilityVector } from "./types.js";

export interface EvaluationSegment {
  startTs: number;
  endTs: number;
  baselineProbability: ProbabilityVector;
}

export interface LifecycleMetrics {
  staleQuoteSeconds: number;
  mispricingIntegral: number;
  maximumProbabilityDivergence: number;
}

export function evaluateSuspendedWindow(
  segments: EvaluationSegment[],
  stableReference: ProbabilityVector,
): LifecycleMetrics {
  let staleQuoteSeconds = 0;
  let mispricingIntegral = 0;
  let maximumProbabilityDivergence = 0;

  for (const segment of segments) {
    if (segment.endTs < segment.startTs) {
      throw new Error("Evaluation segment ends before it starts");
    }
    const seconds = (segment.endTs - segment.startTs) / 1_000;
    const divergence = maximumProbabilityMove(
      segment.baselineProbability,
      stableReference,
    );
    staleQuoteSeconds += seconds;
    mispricingIntegral += divergence * seconds;
    maximumProbabilityDivergence = Math.max(
      maximumProbabilityDivergence,
      divergence,
    );
  }

  return {
    staleQuoteSeconds,
    mispricingIntegral,
    maximumProbabilityDivergence,
  };
}
