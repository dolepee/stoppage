import { describe, expect, it } from "vitest";

import { publicJudgeScenario } from "../replay/public-scenario.js";
import { StoppageRuntime } from "./stoppage-runtime.js";

describe("StoppageRuntime", () => {
  it("completes the public lifecycle without exposing TxLINE raw data", async () => {
    const runtime = new StoppageRuntime(publicJudgeScenario);
    await runtime.start(16);
    const snapshot = runtime.snapshot();

    expect(snapshot.replayStatus).toBe("COMPLETE");
    expect(snapshot.dataMode).toBe("SYNTHETIC");
    expect(snapshot.receipts.map((receipt) => receipt.body.action)).toEqual([
      "SUSPEND",
      "REPRICE",
      "REOPEN",
      "ENTER_FAILSAFE",
      "RECOVER_TO_SUSPENDED",
      "REPRICE",
      "REOPEN",
    ]);
    expect(snapshot.mode).toBe("OPEN");
    expect(snapshot.metrics.suspensionReactionMs).toBe(240);
    expect(snapshot.metrics.staleQuoteSeconds).toBeCloseTo(10.56);
    expect(snapshot.metrics.mispricingIntegral).toBeCloseTo(0.45656);
  }, 5_000);
});
