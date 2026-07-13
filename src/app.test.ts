import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createApplication } from "./app.js";
import { loadConfig } from "./config.js";
import {
  buildApprovedPublicClaim,
  buildPublicClaimCandidate,
  type PrivateHoldoutReport,
  type PublicLifecycleCandidate,
} from "./evidence/public-claim.js";

const applications: Awaited<ReturnType<typeof createApplication>>[] = [];
const CONFIG_HASH = [
  "0x",
  "e2ad4818",
  "c05817f6",
  "d5d483b2",
  "7a7c3670",
  "c7aae205",
  "fd1eed32",
  "cbbe74d0",
  "0b491461",
].join("");
const SUSPEND_RECEIPT = [
  "0x",
  "3f71d8aa",
  "397601d7",
  "1d22c36e",
  "56201ecc",
  "02644e42",
  "66a6b4bf",
  "d21d672e",
  "6a8c8f2b",
].join("");
const REPRICE_RECEIPT = [
  "0x",
  "37185067",
  "8690469d",
  "066f908f",
  "c79bd89a",
  "08d0cc1d",
  "698faef5",
  "2c2fbbda",
  "4dad48e6",
].join("");
const TXLINE_SIGNATURE = [
  "3ZEuF4zPtGiwT5iMwHQnPMWp",
  "X9U8BsMz1aHybwyzmk",
  "jaoMKmCNVQ4eADQtAB",
  "11rNwyb1EtDLadn9qQe",
  "GZzuXXwPd",
].join("");

afterEach(async () => {
  await Promise.all(applications.splice(0).map(({ app }) => app.close()));
});

describe("operator API", () => {
  it("serves a public approved claim when available", async () => {
    const dataRoot = await mkdtemp(
      join(tmpdir(), "txodds-public-claim-" + "XXXXXX"),
    );
    try {
      await writeFile(
        join(dataRoot, "public-claim.json"),
        JSON.stringify(approvedClaimFixture()),
      );

      const application = await createApplication({
        logger: false,
        serveStatic: false,
        publicClaimRoot: dataRoot,
      });
      applications.push(application);

      const response = await application.app.inject({
        method: "GET",
        url: "/api/public-claim",
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        status: "AVAILABLE",
        approvedConfigHash: CONFIG_HASH,
        holdout: {
          fixtures: 2,
          eventLedProtectedWindows: 11,
          oddsLedProtectedWindows: 0,
          unconfirmedOddsLedSuspensionRate: null,
        },
        lifecycleEvidence: {
          evidenceType: "DERIVED_LIFECYCLE_EVIDENCE",
          policyRevision: 2,
          preResolutionRepricesInvalidated: 1,
        },
      });
      expect(
        response
          .json()
          .lifecycleEvidence.decisions.map(
            (decision: { action: string }) => decision.action,
          ),
      ).toEqual([
        "SUSPEND",
        "REPRICE",
        "INVALIDATE_REPRICE",
        "REPRICE",
        "REOPEN",
      ]);
      expect(response.json().approvedAt).toBe("2026-07-10T12:30:00.000Z");
      expect(response.body).not.toContain("fixtureId");
    } finally {
      await rm(dataRoot, { recursive: true, force: true });
    }
  });

  it("does not publish a claim without the exact second approval", async () => {
    const dataRoot = await mkdtemp(
      join(tmpdir(), "txodds-public-claim-pending-" + "XXXXXX"),
    );
    try {
      await writeFile(
        join(dataRoot, "public-claim.json"),
        JSON.stringify({
          version: 2,
          status: "AVAILABLE",
          network: "solana-mainnet",
          approvedConfigHash: CONFIG_HASH,
          evaluatedAt: "2026-07-10T12:00:00.000Z",
          approvedAt: "2026-07-10T12:30:00.000Z",
          approval: { statement: "NOT APPROVED" },
        }),
      );
      const application = await createApplication({
        logger: false,
        serveStatic: false,
        publicClaimRoot: dataRoot,
      });
      applications.push(application);

      const response = await application.app.inject({
        method: "GET",
        url: "/api/public-claim",
      });
      expect(response.statusCode).toBe(404);
    } finally {
      await rm(dataRoot, { recursive: true, force: true });
    }
  });

  it("returns 404 when no public claim is available", async () => {
    const dataRoot = await mkdtemp(
      join(tmpdir(), "txodds-public-claim-empty-" + "XXXXXX"),
    );
    try {
      const application = await createApplication({
        logger: false,
        serveStatic: false,
        publicClaimRoot: dataRoot,
      });
      applications.push(application);

      const response = await application.app.inject({
        method: "GET",
        url: "/api/public-claim",
      });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({
        error: "Public claim not available",
      });
    } finally {
      await rm(dataRoot, { recursive: true, force: true });
    }
  });

  it("reports an honest mainnet activation state", async () => {
    const application = await createApplication({
      config: loadConfig({}),
      logger: false,
      serveStatic: false,
    });
    applications.push(application);

    const response = await application.app.inject({
      method: "GET",
      url: "/api/health",
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.json()).toMatchObject({
      ok: true,
      network: "solana-mainnet",
      txlineMode: "awaiting-activation",
    });
  });

  it("starts and stops the zero-friction replay", async () => {
    const application = await createApplication({
      logger: false,
      serveStatic: false,
    });
    applications.push(application);

    const started = await application.app.inject({
      method: "POST",
      url: "/api/replay/start",
      payload: { speed: 16 },
    });
    expect(started.statusCode).toBe(202);
    expect(started.json()).toMatchObject({
      replayStatus: "RUNNING",
      dataMode: "SYNTHETIC",
    });

    const stopped = await application.app.inject({
      method: "POST",
      url: "/api/replay/stop",
    });
    expect(stopped.statusCode).toBe(200);
    expect(stopped.json().replayStatus).toBe("STOPPED");
  });

  it("rejects invalid replay speeds", async () => {
    const application = await createApplication({
      logger: false,
      serveStatic: false,
    });
    applications.push(application);

    const response = await application.app.inject({
      method: "POST",
      url: "/api/replay/start",
      payload: { speed: 100 },
    });
    expect(response.statusCode).toBe(400);
  });

  it("publishes sanitized worker health without feed identifiers", async () => {
    const now = Date.now();
    const application = await createApplication({
      logger: false,
      serveStatic: false,
      readWorkerStatus: async () => ({
        running: true,
        fixturesLoaded: 6,
        oddsMessages: 12,
        scoreMessages: 9,
        normalizedOdds: 4,
        normalizedEvents: 2,
        skippedOdds: 8,
        reconnects: { odds: 0, scores: 1 },
        fixtureRefreshes: 3,
        fixtureRefreshFailures: 0,
        lastFixtureRefreshAt: now - 10_000,
        streamHealth: { odds: true, scores: true },
        lastMessageAt: { odds: now - 2_000, scores: now - 3_000 },
        startedAt: new Date(now - 60_000).toISOString(),
        updatedAt: new Date(now - 500).toISOString(),
      }),
    });
    applications.push(application);

    const response = await application.app.inject({
      method: "GET",
      url: "/api/worker-health",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      available: true,
      running: true,
      fixturesLoaded: 6,
      messages: { odds: 12, scores: 9 },
      streamHealth: { odds: true, scores: true },
    });
    expect(response.body).not.toContain("lastMessageAt");
    expect(response.body).not.toContain("api-token");
  });
});

function approvedClaimFixture() {
  const holdout: PrivateHoldoutReport = {
    version: 2,
    status: "AWAITING_PUBLIC_CLAIM_APPROVAL",
    network: "solana-mainnet",
    approvedConfigHash: CONFIG_HASH,
    evaluatedAt: "2026-07-10T12:00:00.000Z",
    fixtures: [],
    aggregate: {
      fixtures: 2,
      completeProtectedWindows: 11,
      staleQuoteSeconds: 1230.071,
      mispricingIntegral: 180.9,
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
  const lifecycle: PublicLifecycleCandidate = {
    version: 2,
    status: "AWAITING_HUMAN_APPROVAL",
    evidenceType: "DERIVED_LIFECYCLE_EVIDENCE",
    network: "solana-mainnet",
    policyRevision: 2,
    dataBoundary:
      "No TxLINE records, vectors, identifiers, or absolute source timestamps.",
    lifecycleDurationMs: 169_636,
    maximumProbabilityMove: 0.7620899775,
    preResolutionRepricesInvalidated: 1,
    configHash: CONFIG_HASH,
    decisions: [
      decision("SUSPEND", "EVENT_BEFORE_REPRICE", "OPEN", "SUSPENDED", 0),
      decision(
        "REPRICE",
        "EVENT_BEFORE_REPRICE",
        "SUSPENDED",
        "REPRICED",
        80_000,
      ),
      decision(
        "INVALIDATE_REPRICE",
        "RESOLUTION_DISCARDED",
        "REPRICED",
        "SUSPENDED",
        90_000,
      ),
      decision(
        "REPRICE",
        "EVENT_BEFORE_REPRICE",
        "SUSPENDED",
        "REPRICED",
        160_000,
      ),
      decision("REOPEN", "EVENT_BEFORE_REPRICE", "REPRICED", "OPEN", 169_636),
    ],
    txlineValidation: {
      transactionSignature: TXLINE_SIGNATURE,
      explorer: `https://solscan.io/tx/${TXLINE_SIGNATURE}`,
    },
  };
  const candidate = buildPublicClaimCandidate({ holdout, lifecycle });
  return buildApprovedPublicClaim({
    holdout,
    lifecycle,
    approvalStatement: candidate.requiredApproval,
    approvedAt: "2026-07-10T12:30:00.000Z",
  });
}

function decision(
  action: PublicLifecycleCandidate["decisions"][number]["action"],
  trigger: PublicLifecycleCandidate["decisions"][number]["trigger"],
  fromMode: PublicLifecycleCandidate["decisions"][number]["fromMode"],
  toMode: PublicLifecycleCandidate["decisions"][number]["toMode"],
  elapsedMs: number,
) {
  return {
    action,
    trigger,
    fromMode,
    toMode,
    elapsedMs,
    receiptHash: action === "SUSPEND" ? SUSPEND_RECEIPT : REPRICE_RECEIPT,
    configHash: CONFIG_HASH,
  };
}
