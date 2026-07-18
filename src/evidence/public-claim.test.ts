import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildApprovedPublicClaim,
  buildPublicClaimCandidate,
  loadLatestPrivateEvidence,
  loadLatestPublicClaim,
  PUBLIC_CLAIM_APPROVAL_PREFIX,
  validatePublicFeaturedMatchLabel,
  type PrivateHoldoutReport,
  type PublicLifecycleCandidate,
} from "./public-claim.js";
import { sha256 } from "../domain/canonical.js";

const configHash = `0x${"ab".repeat(32)}`;

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
    const candidate = buildPublicClaimCandidate({
      holdout: holdout(),
      lifecycle: lifecycle(),
    });
    const claim = buildApprovedPublicClaim({
      holdout: holdout(),
      lifecycle: lifecycle(),
      approvalStatement: candidate.requiredApproval,
      approvedAt: "2026-07-10T15:00:00.000Z",
    });

    expect(claim).toMatchObject({
      version: 3,
      status: "AVAILABLE",
      candidateHash: candidate.candidateHash,
      approval: { statement: candidate.requiredApproval },
      holdout: {
        completeProtectedWindows: 11,
        eventLedProtectedWindows: 11,
        oddsLedProtectedWindows: 0,
        unconfirmedOddsLedProtectedWindows: 0,
        unconfirmedOddsLedSuspensionRate: null,
        provisionalEventProtectedWindows: 11,
        preResolutionRepricesInvalidated: 7,
        postResolutionCertifiedReopens: 11,
      },
      featuredMatch: {
        label: "Argentina–England · completed World Cup match",
        completeProtectedWindows: 3,
        preResolutionRepricesInvalidated: 3,
        postResolutionCertifiedReopens: 3,
      },
    });
    expect(JSON.stringify(claim)).not.toContain("fixtureId");
  });

  it("binds approval to the exact public candidate payload", () => {
    const candidate = buildPublicClaimCandidate({
      holdout: holdout(),
      lifecycle: lifecycle(),
    });
    const changed = holdout();
    changed.aggregate.completeProtectedWindows += 1;

    expect(() =>
      buildApprovedPublicClaim({
        holdout: changed,
        lifecycle: lifecycle(),
        approvalStatement: candidate.requiredApproval,
        approvedAt: "2026-07-10T15:00:00.000Z",
      }),
    ).toThrow("Human approval must exactly equal");
  });

  it("rejects a featured match that exceeds the holdout aggregate", () => {
    const changed = holdout();
    changed.featuredMatch!.completeProtectedWindows =
      changed.aggregate.completeProtectedWindows + 1;

    expect(() =>
      buildPublicClaimCandidate({
        holdout: changed,
        lifecycle: lifecycle(),
      }),
    ).toThrow("Featured match exceeds the approved holdout aggregate");
  });

  it("accepts only privacy-safe completed-match labels", () => {
    expect(
      validatePublicFeaturedMatchLabel(
        "Argentina–England · completed World Cup match",
      ),
    ).toBe("Argentina–England · completed World Cup match");
    for (const unsafe of [
      "Fixture 123456",
      "Argentina–England · 2026-07-16T20:00:00Z",
      "fixture-123456-raw-capture.json",
    ]) {
      expect(() => validatePublicFeaturedMatchLabel(unsafe)).toThrow(
        "without IDs or timestamps",
      );
    }
  });

  it("publishes only allowlisted featured-match fields", () => {
    const changed = holdout();
    Object.assign(changed.featuredMatch!, {
      fixtureId: "private-fixture-id",
      sourceCapture: { path: "/private/raw-capture.json" },
      receivedTs: "2026-07-10T14:00:00.000Z",
    });

    const candidate = buildPublicClaimCandidate({
      holdout: changed,
      lifecycle: lifecycle(),
    });

    expect(candidate.payload.featuredMatch).toEqual(holdout().featuredMatch);
    expect(JSON.stringify(candidate.payload.featuredMatch)).not.toMatch(
      /fixtureId|sourceCapture|receivedTs/,
    );
  });

  it("rejects an approved claim containing non-public featured-match fields", async () => {
    const root = await mkdtemp(join(tmpdir(), "stoppage-public-claim-"));
    try {
      const candidate = buildPublicClaimCandidate({
        holdout: holdout(),
        lifecycle: lifecycle(),
      });
      const claim = buildApprovedPublicClaim({
        holdout: holdout(),
        lifecycle: lifecycle(),
        approvalStatement: candidate.requiredApproval,
        approvedAt: "2026-07-10T15:00:00.000Z",
      });
      Object.assign(claim.featuredMatch!, {
        fixtureId: "private-fixture-id",
        sourceCapture: "/private/raw-capture.json",
      });
      const {
        candidateHash: _candidateHash,
        approvedAt: _approvedAt,
        approval: _approval,
        ...poisonedPayload
      } = claim;
      claim.candidateHash = sha256(poisonedPayload);
      claim.approval.statement = `${PUBLIC_CLAIM_APPROVAL_PREFIX} ${claim.approvedConfigHash} ${claim.candidateHash}`;
      await writeFile(join(root, "public-claim.json"), JSON.stringify(claim));

      expect(await loadLatestPublicClaim(root)).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("selects the strongest verified lifecycle for the latest holdout", async () => {
    const root = await mkdtemp(join(tmpdir(), "stoppage-evidence-"));
    try {
      const olderHoldout = holdout();
      olderHoldout.aggregate.fixtures = 2;
      const latestHoldout = holdout();
      latestHoldout.aggregate.fixtures = 4;
      const weaker = lifecycle();
      weaker.maximumProbabilityMove = 0.4;
      const strongest = lifecycle();
      strongest.maximumProbabilityMove = 0.8;

      await Promise.all([
        writeFile(
          join(root, "holdout-2026-07-10.json"),
          JSON.stringify(olderHoldout),
        ),
        writeFile(
          join(root, "holdout-2026-07-12.json"),
          JSON.stringify(latestHoldout),
        ),
        writeFile(
          join(root, "public-evidence-candidate-2026-07-11.json"),
          JSON.stringify(strongest),
        ),
        writeFile(
          join(root, "public-evidence-candidate-2026-07-12.json"),
          JSON.stringify(weaker),
        ),
      ]);

      const evidence = await loadLatestPrivateEvidence(root, configHash);
      expect(evidence?.holdout.aggregate.fixtures).toBe(4);
      expect(evidence?.lifecycle.maximumProbabilityMove).toBe(0.8);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function holdout(): PrivateHoldoutReport {
  return {
    version: 2,
    status: "AWAITING_PUBLIC_CLAIM_APPROVAL",
    network: "solana-mainnet",
    approvedConfigHash: configHash,
    evaluatedAt: "2026-07-10T14:00:00.000Z",
    fixtures: [],
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
      preResolutionRepricesInvalidated: 7,
      postResolutionCertifiedReopens: 11,
      confirmedResolutionCertifiedReopens: 8,
      discardedResolutionCertifiedReopens: 3,
    },
  };
}

function lifecycle(): PublicLifecycleCandidate {
  return {
    version: 2,
    status: "AWAITING_HUMAN_APPROVAL",
    evidenceType: "DERIVED_LIFECYCLE_EVIDENCE",
    network: "solana-mainnet",
    policyRevision: 2,
    dataBoundary:
      "No TxLINE records, vectors, identifiers, or absolute source timestamps.",
    lifecycleDurationMs: 169636,
    maximumProbabilityMove: 0.762,
    preResolutionRepricesInvalidated: 1,
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
      {
        action: "REPRICE",
        trigger: "EVENT_BEFORE_REPRICE",
        fromMode: "SUSPENDED",
        toMode: "REPRICED",
        elapsedMs: 80_000,
        receiptHash: `0x${"de".repeat(32)}`,
        configHash,
      },
      {
        action: "INVALIDATE_REPRICE",
        trigger: "RESOLUTION_DISCARDED",
        fromMode: "REPRICED",
        toMode: "SUSPENDED",
        elapsedMs: 90_000,
        receiptHash: `0x${"bc".repeat(32)}`,
        configHash,
      },
      {
        action: "REPRICE",
        trigger: "EVENT_BEFORE_REPRICE",
        fromMode: "SUSPENDED",
        toMode: "REPRICED",
        elapsedMs: 160_000,
        receiptHash: `0x${"bd".repeat(32)}`,
        configHash,
      },
      {
        action: "REOPEN",
        trigger: "EVENT_BEFORE_REPRICE",
        fromMode: "REPRICED",
        toMode: "OPEN",
        elapsedMs: 169_636,
        receiptHash: `0x${"ef".repeat(32)}`,
        configHash,
      },
    ],
    txlineValidation: {
      transactionSignature:
        "3ZEuF4zPtGiwT5iMwHQnPMWpX9U8BsMz1aHybwyzmkjaoMKmCNVQ4eADQtAB11rNwyb1EtDLadn9qQeGZzuXXwPd",
      explorer:
        "https://solscan.io/tx/3ZEuF4zPtGiwT5iMwHQnPMWpX9U8BsMz1aHybwyzmkjaoMKmCNVQ4eADQtAB11rNwyb1EtDLadn9qQeGZzuXXwPd",
    },
  };
}
