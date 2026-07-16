import { describe, expect, it } from "vitest";

import { parseLiveDecisionTape } from "./live-decision-tape";

describe("live decision tape parser", () => {
  it("accepts a complete approved aggregate", () => {
    expect(parseLiveDecisionTape(fixture()).counters.capturedRequests).toBe(20);
  });

  it("rejects an unsafe-callback claim or incomplete evidence", () => {
    const unsafe = fixture();
    unsafe.counters.callbacksAfterBlock = 1;
    expect(() => parseLiveDecisionTape(unsafe)).toThrow(/invariants/);

    const incomplete = fixture();
    incomplete.counters.blockedRequests = 0;
    expect(() => parseLiveDecisionTape(incomplete)).toThrow(/invariants/);
  });
});

function fixture() {
  return {
    version: 1,
    status: "AVAILABLE",
    evidenceType: "RECORDED_TXLINE_DECISION_TAPE",
    source: "TXLINE_WORLD_CUP_SERVICE_LEVEL_12",
    operation: "BUILDER_OPERATED_CAPTURE",
    hostingClaim: "RECORDED_CAPTURE_NOT_HOSTED_UPTIME",
    timingDisclosure:
      "PERMIT_ISSUED_AT_IS_ENFORCEMENT_EXECUTION_TIME_NOT_FEED_TIME",
    dataBoundary: "Sanitized",
    captureModes: { live: 0, privateCaptureReplay: 20 },
    contract: {
      command: "PUBLISH_QUOTE",
      enforcement: "CALLBACK_AFTER_OFFLINE_ED25519_VERIFICATION_ONLY",
      intendedAgent: "stoppage-reference-agent",
      adversaryAgent: "cross-agent-adversary",
    },
    signer: {
      issuer: "stoppage",
      kid: "stp_1234567890abcdef",
      alg: "Ed25519",
      publicKey: "public-key",
    },
    counters: {
      capturedRequests: 20,
      blockedRequests: 10,
      verifiedPermits: 10,
      callbacksAfterBlock: 0,
      callbacksWithoutVerifiedPermit: 0,
      crossAgentPermitTheftsRejected: 10,
    },
    decisions: {
      allowHealthyQuote: 9,
      allowCertifiedReopen: 1,
      blockedUncertainty: 10,
      blockedOther: 0,
    },
    sampleProof: {
      decision: "ALLOW_CERTIFIED_REOPEN",
      permit: {
        alg: "Ed25519",
        hash: `0x${"1".repeat(64)}`,
        signature: "signed",
        body: {
          kid: "stp_1234567890abcdef",
          audience: "venue:stoppage-reference-agent",
          issuedAt: 10_000,
          expiresAt: 15_000,
        },
      },
      intendedAgent: {
        id: "stoppage-reference-agent",
        audience: "venue:stoppage-reference-agent",
        verification: "ALLOW",
        callbackInvoked: true,
      },
      crossAgentAttempt: {
        id: "cross-agent-adversary",
        audience: "venue:cross-agent-adversary",
        verification: "BLOCK_AUDIENCE_MISMATCH",
        callbackInvoked: false,
      },
    },
    candidateHash: `0x${"2".repeat(64)}`,
    approvedAt: "2026-07-16T16:00:00.000Z",
  };
}
