import type { ProbabilityVector, Selection } from "./types.js";

const selections: Selection[] = ["HOME", "DRAW", "AWAY"];

export function assertProbabilityVector(vector: ProbabilityVector): void {
  for (const selection of selections) {
    const probability = vector[selection];
    if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
      throw new Error(`Invalid ${selection} probability: ${probability}`);
    }
  }

  const total = selections.reduce(
    (sum, selection) => sum + vector[selection],
    0,
  );
  if (Math.abs(total - 1) > 0.002) {
    throw new Error(`1X2 probabilities must sum to 1; received ${total}`);
  }
}

export function maximumProbabilityMove(
  left: ProbabilityVector,
  right: ProbabilityVector,
): number {
  return Math.max(
    ...selections.map((selection) =>
      Math.abs(left[selection] - right[selection]),
    ),
  );
}
