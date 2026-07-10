import { describe, expect, it } from "vitest";

import { evaluateSuspendedWindow } from "./metrics.js";

describe("evaluateSuspendedWindow", () => {
  it("uses a stable ex-post reference without money units", () => {
    const metrics = evaluateSuspendedWindow(
      [
        {
          startTs: 1_000,
          endTs: 3_000,
          baselineProbability: { HOME: 0.4, DRAW: 0.3, AWAY: 0.3 },
        },
        {
          startTs: 3_000,
          endTs: 4_000,
          baselineProbability: { HOME: 0.5, DRAW: 0.27, AWAY: 0.23 },
        },
      ],
      { HOME: 0.55, DRAW: 0.25, AWAY: 0.2 },
    );

    expect(metrics.staleQuoteSeconds).toBe(3);
    expect(metrics.mispricingIntegral).toBeCloseTo(0.35);
    expect(metrics.maximumProbabilityDivergence).toBeCloseTo(0.15);
  });
});
