import { describe, expect, it } from "vitest";

import { DEFAULT_GOVERNOR_CONFIG } from "../domain/governor.js";
import { publicJudgeScenario } from "../replay/public-scenario.js";
import { evaluateHoldout } from "./holdout.js";

describe("evaluateHoldout", () => {
  it("measures protected windows without money units or future inputs", () => {
    const evaluation = evaluateHoldout(
      publicJudgeScenario.steps.map((step) => step.input),
      DEFAULT_GOVERNOR_CONFIG,
    );

    expect(evaluation.sample.completeProtectedWindows).toBe(2);
    expect(evaluation.sample.incompleteProtectedWindow).toBe(false);
    expect(evaluation.metrics.staleQuoteSeconds).toBeCloseTo(25.56);
    expect(evaluation.metrics.eventSuspensions).toBe(1);
    expect(evaluation.metrics.unconfirmedSuspensionRate).toBe(0);
    expect(evaluation.windows[0]).toMatchObject({
      trigger: "EVENT_BEFORE_REPRICE",
      staleQuoteSeconds: 10.56,
      reopenLatencyMs: 10_560,
    });
  });
});
