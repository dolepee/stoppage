import { describe, expect, it } from "vitest";

import {
  buildApprovedPublicClaim,
  type PrivateHoldoutReport,
  type PublicLifecycleCandidate,
} from "./public-claim.js";

const configHash = `0x${"ab".repeat(32)}`;
const approval = `APPROVE STOPPAGE PUBLIC CLAIM ${configHash}`;

describe("public claim approval", () => {
  it("requires the exact second human approval statement", () => {
    expect(() =>
      buildApprovedPublicClaim({
        holdout: holdout(),
        lifecycle: lifecycle(),
        approvalStatement: "APPROVE",
        approvedAt: "2026-07-10T15:00:00.000Z",
      }),
    ).toThrow("Human approval must exactly equal");
  });

  it("builds an unambiguous approved projection", () => {
    const claim = buildApprovedPublicClaim({
      holdout: holdout(),
      lifecycle: lifecycle(),
      approvalStatement: approval,
      approvedAt: "2026-07-10T15:00:00.000Z",
    });

    expect(claim).toMatchObject({
      version: 2,
      status: "AVAILABLE",
      approval: { statement: approval },
      holdout: {
        completeProtectedWindows: 11,
        eventLedProtectedWindows: 11,
        oddsLedProtectedWindows: 0,
        unconfirmedOddsLedProtectedWindows: 0,
        unconfirmedOddsLedSuspensionRate: null,
        provisionalEventProtectedWindows: 11,
      },
    });
    expect(JSON.stringify(claim)).not.toContain("fixtureId");
  });
});

function holdout(): PrivateHoldoutReport {
  return {
    version: 1,
    status: "AWAITING_PUBLIC_CLAIM_APPROVAL",
    network: "solana-mainnet",
    approvedConfigHash: configHash,
    evaluatedAt: "2026-07-10T14:00:00.000Z",
    fixtures: [],
    aggregate: {
      fixtures: 2,
      completeProtectedWindows: 11,
      staleQuoteSeconds: 1230.071,
      mispricingIntegral: 180.903,
      eventLedProtectedWindows: 11,
      oddsLedProtectedWindows: 0,
      confirmedOddsLedProtectedWindows: 0,
      unconfirmedOddsLedProtectedWindows: 0,
      unconfirmedOddsLedSuspensionRate: null,
      failsafeProtectedWindows: 0,
      provisionalEventProtectedWindows: 11,
    },
  };
}

function lifecycle(): PublicLifecycleCandidate {
  return {
    status: "AWAITING_HUMAN_APPROVAL",
    evidenceType: "DERIVED_LIFECYCLE_EVIDENCE",
    network: "solana-mainnet",
    dataBoundary:
      "No TxLINE records, vectors, identifiers, or absolute source timestamps.",
    lifecycleDurationMs: 169636,
    maximumProbabilityMove: 0.762,
    configHash,
    decisions: [
      {
        action: "SUSPEND",
        trigger: "EVENT_BEFORE_REPRICE",
        fromMode: "OPEN",
        toMode: "SUSPENDED",
        elapsedMs: 0,
        receiptHash: `0x${"cd".repeat(32)}`,
        configHash,
      },
    ],
    txlineValidation: {
      transactionSignature:
        "3ZEuF4zPtGiwT5iMwHQnPMWpX9U8BsMz1aHybwyzmkjaoMKmCNVQ4eADQtAB11rNwyb1EtDLadn9qQeGZzuXXwPd",
      explorer: "https://solscan.io/tx/test",
    },
  };
}
