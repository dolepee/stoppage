import { describe, expect, it } from "vitest";

import type { DecisionReceipt } from "../domain/types.js";
import { projectDecisionReceipt } from "./public-projection.js";

describe("public decision projection", () => {
  it("strips TxLINE identifiers, quote vectors, fixture IDs, and absolute time", () => {
    const receipt: DecisionReceipt = {
      body: {
        version: 1,
        fixtureId: 99,
        market: "1X2",
        action: "REPRICE",
        trigger: "EVENT_BEFORE_REPRICE",
        fromMode: "SUSPENDED",
        toMode: "REPRICED",
        observedTs: 15_000,
        sourceIds: ["private-message-id"],
        quote: { HOME: 0.6, DRAW: 0.25, AWAY: 0.15 },
        configHash: "config-hash",
      },
      hash: "receipt-hash",
    };

    const projected = projectDecisionReceipt(receipt, 10_000);

    expect(projected).toEqual({
      action: "REPRICE",
      trigger: "EVENT_BEFORE_REPRICE",
      fromMode: "SUSPENDED",
      toMode: "REPRICED",
      elapsedMs: 5_000,
      receiptHash: "receipt-hash",
      configHash: "config-hash",
    });
    expect(JSON.stringify(projected)).not.toMatch(
      /private-message-id|"HOME"|"fixtureId"|15000/,
    );
  });
});
