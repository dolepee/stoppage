import { describe, expect, it } from "vitest";

import { getChallengeResultDisplay } from "./challenge-result";

describe("challenge result display", () => {
  it("reports success only for an SDK-verifier rejection", () => {
    expect(
      getChallengeResultDisplay({
        challenge: "QUOTE_TAMPER",
        expected: "REJECT",
        valid: false,
        decision: "BLOCK_SIGNATURE_INVALID",
        reason: "Rejected",
      }),
    ).toEqual({
      passed: true,
      title: "REJECTED AS EXPECTED",
      detail: "BLOCK SIGNATURE INVALID",
    });
  });

  it("raises a visible security failure if tampering is accepted", () => {
    expect(
      getChallengeResultDisplay({
        challenge: "QUOTE_TAMPER",
        expected: "REJECT",
        valid: true,
        decision: "ALLOW",
        reason: "Regression",
      }),
    ).toEqual({
      passed: false,
      title: "SECURITY CHECK FAILED",
      detail: "UNSAFE ALLOW",
    });
  });
});
