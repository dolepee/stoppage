import { describe, expect, it } from "vitest";
import { parsePublicClaim } from "./public-claim";

const hash = `0x${"a".repeat(64)}`;

function claim() {
  return {
    version: 3,
    status: "AVAILABLE",
    network: "solana-mainnet",
    approvedConfigHash: hash,
    candidateHash: hash,
    evaluatedAt: "2026-07-12T21:42:11.859Z",
    approvedAt: "2026-07-12T21:52:56.944Z",
    dataBoundary: "No source data.",
    featuredMatch: {
      evidenceType: "DERIVED_MATCH_ADDENDUM",
      label: "Argentina–England · completed World Cup match",
      dataMode: "TXLINE_REPLAY",
      finalState: "TXLINE_GAME_FINALISED",
      completeProtectedWindows: 3,
      protectedWindowSeconds: 366.131,
      preResolutionRepricesInvalidated: 3,
      postResolutionCertifiedReopens: 3,
      confirmedResolutionCertifiedReopens: 3,
      dataBoundary:
        "Derived aggregate only; no fixture ID, raw TxLINE record, odds vector or source timestamp.",
    },
    holdout: {
      fixtures: 4,
      completeProtectedWindows: 18,
      staleQuoteSeconds: 1853.723,
      mispricingIntegral: 302.499,
      eventLedProtectedWindows: 18,
      oddsLedProtectedWindows: 0,
      confirmedOddsLedProtectedWindows: 0,
      unconfirmedOddsLedProtectedWindows: 0,
      unconfirmedOddsLedSuspensionRate: null,
      preResolutionRepricesInvalidated: 11,
      postResolutionCertifiedReopens: 18,
      confirmedResolutionCertifiedReopens: 14,
      discardedResolutionCertifiedReopens: 4,
    },
    lifecycleEvidence: {
      policyRevision: 2,
      lifecycleDurationMs: 169636,
      maximumProbabilityMove: 0.762,
      preResolutionRepricesInvalidated: 1,
      txlineValidation: {
        transactionSignature: "3".repeat(64),
        explorer: `https://solscan.io/tx/${"3".repeat(64)}`,
      },
      decisions: [
        {
          action: "SUSPEND",
          trigger: "EVENT_BEFORE_REPRICE",
          fromMode: "OPEN",
          toMode: "SUSPENDED",
          elapsedMs: 0,
          receiptHash: hash,
        },
        {
          action: "REPRICE",
          trigger: "EVENT_BEFORE_REPRICE",
          fromMode: "SUSPENDED",
          toMode: "REPRICED",
          elapsedMs: 80_000,
          receiptHash: hash,
        },
        {
          action: "INVALIDATE_REPRICE",
          trigger: "RESOLUTION_DISCARDED",
          fromMode: "REPRICED",
          toMode: "SUSPENDED",
          elapsedMs: 90_000,
          receiptHash: hash,
        },
        {
          action: "REPRICE",
          trigger: "EVENT_BEFORE_REPRICE",
          fromMode: "SUSPENDED",
          toMode: "REPRICED",
          elapsedMs: 162640,
          receiptHash: hash,
        },
        {
          action: "REOPEN",
          trigger: "EVENT_BEFORE_REPRICE",
          fromMode: "REPRICED",
          toMode: "OPEN",
          elapsedMs: 169636,
          receiptHash: hash,
        },
      ],
    },
  };
}

describe("parsePublicClaim", () => {
  it("accepts the approved lifecycle shape", () => {
    expect(parsePublicClaim(claim()).holdout.completeProtectedWindows).toBe(18);
    expect(parsePublicClaim(claim()).featuredMatch?.label).toContain(
      "Argentina–England",
    );
  });

  it("rejects reordered lifecycle decisions", () => {
    const value = claim();
    value.lifecycleEvidence.decisions.reverse();
    expect(() => parsePublicClaim(value)).toThrow(
      "Lifecycle must invalidate a provisional reprice",
    );
  });

  it("rejects non-Solscan validation links", () => {
    const value = claim();
    value.lifecycleEvidence.txlineValidation.explorer =
      "https://example.com/not-proof";
    expect(() => parsePublicClaim(value)).toThrow();
  });
});
