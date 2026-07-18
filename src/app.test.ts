import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createApplication } from "./app.js";
import { loadConfig } from "./config.js";
import { QuoteGovernor } from "./domain/governor.js";
import {
  hashExecutionSubject,
  hashQuote,
} from "./execution-gate/execution-gate.js";
import { createPermitSigner } from "./execution-gate/permit-v2.js";
import type { PersistedLiveExecutionState } from "./execution-gate/live-context.js";
import {
  buildApprovedPublicClaim,
  buildPublicClaimCandidate,
  type PrivateHoldoutReport,
  type PublicLifecycleCandidate,
} from "./evidence/public-claim.js";
import { publicJudgeScenario } from "./replay/public-scenario.js";

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
const MISMATCH_HASH = `0x${"0".repeat(64)}`;

afterEach(async () => {
  await Promise.all(applications.splice(0).map(({ app }) => app.close()));
});

describe("operator API", () => {
  it("serves rebuilt hashed assets with strict MIME types after startup", async () => {
    const staticRoot = await mkdtemp(
      join(tmpdir(), "txodds-static-" + "XXXXXX"),
    );
    try {
      await writeFile(
        join(staticRoot, "index.html"),
        '<!doctype html><html><body><div id="root">Stoppage</div></body></html>',
      );
      const application = await createApplication({
        logger: false,
        staticRoot,
      });
      applications.push(application);

      const initial = await application.app.inject({
        method: "GET",
        url: "/",
      });
      expect(initial.statusCode).toBe(200);
      expect(initial.headers["content-type"]).toContain("text/html");

      await mkdir(join(staticRoot, "assets"));
      await writeFile(join(staticRoot, "assets", "index-rebuilt.css"), "*");
      await writeFile(
        join(staticRoot, "assets", "index-rebuilt.js"),
        'document.title = "Stoppage";',
      );

      const css = await application.app.inject({
        method: "GET",
        url: "/assets/index-rebuilt.css",
      });
      expect(css.statusCode).toBe(200);
      expect(css.headers["content-type"]).toContain("text/css");
      expect(css.body).toBe("*");

      const script = await application.app.inject({
        method: "GET",
        url: "/assets/index-rebuilt.js",
      });
      expect(script.statusCode).toBe(200);
      expect(script.headers["content-type"]).toContain("text/javascript");
      expect(script.body).toContain("Stoppage");

      const missingAsset = await application.app.inject({
        method: "GET",
        url: "/assets/index-missing.js",
      });
      expect(missingAsset.statusCode).toBe(404);
      expect(missingAsset.headers["content-type"]).toContain(
        "application/json",
      );
      expect(missingAsset.json()).toEqual({ error: "Not found" });

      const deepLink = await application.app.inject({
        method: "GET",
        url: "/judge/replay",
      });
      expect(deepLink.statusCode).toBe(200);
      expect(deepLink.headers["content-type"]).toContain("text/html");
      expect(deepLink.body).toContain("Stoppage");

      const missingApi = await application.app.inject({
        method: "GET",
        url: "/api/not-a-route",
      });
      expect(missingApi.statusCode).toBe(404);
      expect(missingApi.json()).toEqual({ error: "Not found" });
    } finally {
      await rm(staticRoot, { recursive: true, force: true });
    }
  });

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

  it("serves a judge bundle when claim and live tape are both available", async () => {
    const dataRoot = await mkdtemp(
      join(tmpdir(), "txodds-public-bundle-" + "XXXXXX"),
    );
    try {
      const publicClaim = await readFile(
        "data/public/public-claim.json",
        "utf8",
      );
      await writeFile(join(dataRoot, "public-claim.json"), publicClaim);

      const liveDecisionTape = await readFile(
        "data/public/live-decision-tape.json",
        "utf8",
      );
      await writeFile(
        join(dataRoot, "live-decision-tape.json"),
        liveDecisionTape,
      );

      const application = await createApplication({
        logger: false,
        serveStatic: false,
        publicClaimRoot: dataRoot,
      });
      applications.push(application);

      const bundle = await application.app.inject({
        method: "GET",
        url: "/api/judge-bundle",
      });
      expect(bundle.statusCode).toBe(200);
      const payload = bundle.json();

      expect(payload).toMatchObject({
        version: 1,
        status: "AVAILABLE",
        network: "solana-mainnet",
        publicClaim: {
          available: true,
          payload: {
            approvedConfigHash: expect.any(String),
            status: "AVAILABLE",
          },
        },
        liveDecisionTape: {
          available: true,
          payload: {
            status: "AVAILABLE",
            evidenceType: "RECORDED_BUILDER_ATTESTED_TXLINE_DECISION_TAPE",
          },
        },
      });
      expect(payload.dataBoundary).toContain("Judge evidence is restricted");
    } finally {
      await rm(dataRoot, { recursive: true, force: true });
    }
  });

  it("returns 404 for judge bundle when no evidence is available", async () => {
    const dataRoot = await mkdtemp(
      join(tmpdir(), "txodds-judge-bundle-empty-" + "XXXXXX"),
    );
    try {
      const application = await createApplication({
        logger: false,
        serveStatic: false,
        publicClaimRoot: dataRoot,
      });
      applications.push(application);

      const bundle = await application.app.inject({
        method: "GET",
        url: "/api/judge-bundle",
      });
      expect(bundle.statusCode).toBe(404);
      expect(bundle.json()).toMatchObject({
        error: "Judge evidence bundle not available",
      });
    } finally {
      await rm(dataRoot, { recursive: true, force: true });
    }
  });

  it("returns judge bundle with partial public evidence availability", async () => {
    const dataRoot = await mkdtemp(
      join(tmpdir(), "txodds-judge-bundle-partial-" + "XXXXXX"),
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

      const bundle = await application.app.inject({
        method: "GET",
        url: "/api/judge-bundle",
      });
      expect(bundle.statusCode).toBe(200);
      expect(bundle.json()).toMatchObject({
        version: 1,
        status: "AVAILABLE",
        publicClaim: {
          available: true,
        },
        liveDecisionTape: {
          available: false,
          reason: "No approved live decision tape is available",
        },
      });
    } finally {
      await rm(dataRoot, { recursive: true, force: true });
    }
  });

  it("filters public claim by approvedConfigHash in judge bundle", async () => {
    const dataRoot = await mkdtemp(
      join(tmpdir(), "txodds-judge-bundle-config-hash-" + "XXXXXX"),
    );
    try {
      const expectedClaimFile = await readFile(
        "data/public/public-claim.json",
        "utf8",
      );
      const expectedClaim = JSON.parse(expectedClaimFile) as {
        approvedConfigHash: string;
      };
      await writeFile(join(dataRoot, "public-claim.json"), expectedClaimFile);

      const liveDecisionTape = await readFile(
        "data/public/live-decision-tape.json",
        "utf8",
      );
      await writeFile(
        join(dataRoot, "live-decision-tape.json"),
        liveDecisionTape,
      );

      const application = await createApplication({
        logger: false,
        serveStatic: false,
        publicClaimRoot: dataRoot,
      });
      applications.push(application);

      const match = await application.app.inject({
        method: "GET",
        url: `/api/judge-bundle?approvedConfigHash=${expectedClaim.approvedConfigHash}`,
      });
      expect(match.statusCode).toBe(200);
      expect(match.json()).toMatchObject({
        version: 1,
        status: "AVAILABLE",
        publicClaim: { available: true },
      });

      const mismatch = await application.app.inject({
        method: "GET",
        url: `/api/judge-bundle?approvedConfigHash=${MISMATCH_HASH}`,
      });
      expect(mismatch.statusCode).toBe(200);
      expect(mismatch.json()).toMatchObject({
        version: 1,
        status: "AVAILABLE",
        publicClaim: {
          available: false,
          reason: `No approved public claim found for ${MISMATCH_HASH}`,
        },
        liveDecisionTape: { available: true },
      });
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

  it("serves the same execution gate used by the reference agent", async () => {
    const application = await createApplication({
      logger: false,
      serveStatic: false,
    });
    applications.push(application);
    await application.runtime.start(16);
    const snapshot = application.runtime.snapshot();
    const request = {
      version: 1,
      command: "PUBLISH_QUOTE",
      subjectHash: snapshot.execution.subjectHash,
      market: "1X2",
      quoteHash: snapshot.execution.agent.requestedQuoteHash,
    };

    const response = await application.app.inject({
      method: "POST",
      url: "/api/execution-gate/evaluate",
      payload: request,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      decision: "ALLOW_CERTIFIED_REOPEN",
      permit: {
        body: {
          subjectHash: snapshot.execution.subjectHash,
          quoteHash: snapshot.execution.agent.requestedQuoteHash,
          reopenProofHash: snapshot.reopenProofs[0]?.hash,
        },
      },
    });
  }, 5_000);

  it("serves an independent HTTPS agent handshake and rejects permit replay", async () => {
    const application = await createApplication({
      logger: false,
      serveStatic: false,
    });
    applications.push(application);
    await application.runtime.start(16);
    const snapshot = application.runtime.snapshot();

    const response = await application.app.inject({
      method: "POST",
      url: "/api/agent-gate",
      payload: {
        version: 1,
        agentId: "judge-market-maker-v1",
        command: "PUBLISH_QUOTE",
        sequence: snapshot.execution.sequence,
        subjectHash: snapshot.execution.subjectHash,
        market: "1X2",
        quoteHash: snapshot.execution.agent.requestedQuoteHash,
        challenge: "EXPIRED_REPLAY",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toMatchObject({
      dataMode: "SYNTHETIC",
      transport: {
        protocol: "HTTPS",
        endpoint: "/api/agent-gate",
      },
      result: {
        decision: "ALLOW_CERTIFIED_REOPEN",
      },
      challenge: {
        challenge: "EXPIRED_REPLAY",
        expected: "REJECT",
        valid: false,
        decision: "BLOCK_PERMIT_EXPIRED",
      },
    });
  }, 5_000);

  it("serves signed Permit V2 and public verification keys", async () => {
    const application = await createApplication({
      logger: false,
      serveStatic: false,
    });
    applications.push(application);
    await application.runtime.start(16);
    const snapshot = application.runtime.snapshot();

    const keys = await application.app.inject({
      method: "GET",
      url: "/api/permit-keys",
    });
    expect(keys.statusCode).toBe(200);
    expect(keys.headers["cache-control"]).toBe("no-store");
    expect(keys.json()).toMatchObject({
      version: 1,
      issuer: "stoppage",
      keys: [
        {
          alg: "Ed25519",
          use: "sig",
          status: "ACTIVE",
          publicKey: expect.any(String),
        },
      ],
    });

    const context = await application.app.inject({
      method: "GET",
      url: "/api/agent-context",
    });
    expect(context.statusCode).toBe(200);
    expect(context.headers["cache-control"]).toBe("no-store");
    expect(context.json()).toMatchObject({
      version: 2,
      dataMode: "SYNTHETIC",
      sequence: snapshot.execution.sequence,
      subjectHash: snapshot.execution.subjectHash,
      market: "1X2",
      quoteHash: snapshot.execution.agent.requestedQuoteHash,
    });

    const response = await application.app.inject({
      method: "POST",
      url: "/api/agent-gate",
      payload: {
        version: 2,
        agentId: "judge-market-maker-v2",
        audience: "venue:judge-market-maker-v2",
        nonce: "judge-request-0001",
        command: "PUBLISH_QUOTE",
        sequence: snapshot.execution.sequence,
        subjectHash: snapshot.execution.subjectHash,
        market: "1X2",
        quoteHash: snapshot.execution.agent.requestedQuoteHash,
        challenge: "UNKNOWN_SIGNING_KEY",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      version: 2,
      transport: { keyEndpoint: "/api/permit-keys" },
      result: {
        decision: "ALLOW_CERTIFIED_REOPEN",
        permit: {
          alg: "Ed25519",
          body: {
            version: 2,
            audience: "venue:judge-market-maker-v2",
            nonce: "judge-request-0001",
          },
          signature: expect.any(String),
        },
      },
      challenge: {
        expected: "REJECT",
        valid: false,
        decision: "BLOCK_UNKNOWN_SIGNING_KEY",
      },
    });
  }, 5_000);

  it("serves retired permit verification keys alongside active keys", async () => {
    const activeSigner = createPermitSigner(
      Uint8Array.from({ length: 32 }, (_, index) => 11 + index),
    );
    const retiredSigner = createPermitSigner(
      Uint8Array.from({ length: 32 }, (_, index) => 33 + index),
    );
    const application = await createApplication({
      logger: false,
      serveStatic: false,
      loadPermitSigner: () => activeSigner,
      loadRetiredPermitVerificationKeys: () => [
        {
          kid: retiredSigner.kid,
          alg: "Ed25519",
          use: "sig",
          publicKey: Buffer.from(retiredSigner.publicKey).toString("base64url"),
          status: "RETIRED",
          validUntil: 20_000,
        },
      ],
    });
    applications.push(application);
    await application.runtime.start(16);

    const keys = await application.app.inject({
      method: "GET",
      url: "/api/permit-keys",
    });
    expect(keys.statusCode).toBe(200);
    const payload = keys.json();
    expect(payload.keys).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          alg: "Ed25519",
          use: "sig",
          status: "ACTIVE",
          publicKey: Buffer.from(activeSigner.publicKey).toString("base64url"),
        }),
        expect.objectContaining({
          kid: retiredSigner.kid,
          status: "RETIRED",
          publicKey: Buffer.from(retiredSigner.publicKey).toString("base64url"),
        }),
      ]),
    );
  }, 5_000);

  it("evaluates a fresh private live-worker context without exposing its fixture", async () => {
    const live = liveExecutionFixture();
    const application = await createApplication({
      logger: false,
      serveStatic: false,
      readLiveGateState: async () => live.state,
    });
    applications.push(application);

    const response = await application.app.inject({
      method: "POST",
      url: "/api/execution-gate/evaluate",
      payload: live.request,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      decision: "ALLOW_CERTIFIED_REOPEN",
      permit: {
        body: {
          subjectHash: live.request.subjectHash,
          quoteHash: live.request.quoteHash,
        },
      },
    });
    expect(response.body).not.toContain("fixtureId");
  });

  it("serves a signed Permit V2 from fresh private live-worker context", async () => {
    const live = liveExecutionFixture();
    const signer = createPermitSigner(
      Uint8Array.from({ length: 32 }, (_, index) => index + 11),
    );
    const application = await createApplication({
      logger: false,
      serveStatic: false,
      readLiveGateState: async () => live.state,
      loadPermitSigner: () => signer,
    });
    applications.push(application);

    const response = await application.app.inject({
      method: "POST",
      url: "/api/execution-gate/evaluate",
      payload: {
        ...live.request,
        version: 2,
        agentId: "agent-a-reference",
        audience: "venue:agent-a-reference",
        nonce: "live-request-0001",
        sequence: live.state.contexts[0]!.sequence,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      version: 2,
      dataMode: "LIVE_PRIVATE",
      agent: { id: "agent-a-reference", automated: true },
      result: {
        decision: "ALLOW_CERTIFIED_REOPEN",
        permit: {
          body: {
            kid: signer.kid,
            audience: "venue:agent-a-reference",
            nonce: "live-request-0001",
          },
          signature: expect.any(String),
        },
      },
    });
    expect(response.body).not.toContain("fixtureId");
  });

  it("fails a stale private Permit V2 request closed without loading a signer", async () => {
    const live = liveExecutionFixture();
    live.state.contexts[0]!.updatedAt = "2026-01-01T00:00:00.000Z";
    const application = await createApplication({
      logger: false,
      serveStatic: false,
      readLiveGateState: async () => live.state,
      loadPermitSigner: () => {
        throw new Error("Signer must not be loaded for a stale context");
      },
    });
    applications.push(application);

    const response = await application.app.inject({
      method: "POST",
      url: "/api/execution-gate/evaluate",
      payload: {
        ...live.request,
        version: 2,
        agentId: "agent-a-reference",
        audience: "venue:agent-a-reference",
        nonce: "live-request-0002",
        sequence: live.state.contexts[0]!.sequence,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      version: 2,
      result: {
        decision: "BLOCK_STREAM_UNHEALTHY",
        permit: null,
      },
    });
  });

  it("fails a stale live-worker context closed without issuing a permit", async () => {
    const live = liveExecutionFixture();
    live.state.contexts[0]!.updatedAt = "2026-01-01T00:00:00.000Z";
    const application = await createApplication({
      logger: false,
      serveStatic: false,
      readLiveGateState: async () => live.state,
    });
    applications.push(application);

    const response = await application.app.inject({
      method: "POST",
      url: "/api/execution-gate/evaluate",
      payload: live.request,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      decision: "BLOCK_STREAM_UNHEALTHY",
      permit: null,
    });
  });

  it("fails an unreadable live-worker context closed", async () => {
    const application = await createApplication({
      logger: false,
      serveStatic: false,
      readLiveGateState: async () => {
        throw new Error("corrupt private context");
      },
    });
    applications.push(application);

    const response = await application.app.inject({
      method: "POST",
      url: "/api/execution-gate/evaluate",
      payload: {
        version: 1,
        command: "PUBLISH_QUOTE",
        subjectHash: SUSPEND_RECEIPT,
        market: "1X2",
        quoteHash: REPRICE_RECEIPT,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      decision: "BLOCK_STREAM_UNHEALTHY",
      permit: null,
    });
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
      statusFresh: true,
      fixturesLoaded: 6,
      messages: { odds: 12, scores: 9 },
      streamHealth: { odds: true, scores: true },
    });
    expect(response.body).not.toContain("lastMessageAt");
    expect(response.body).not.toContain("api-token");
  });

  it("fails the hosted health check closed when worker state is stale", async () => {
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
        reconnects: { odds: 0, scores: 0 },
        fixtureRefreshes: 3,
        fixtureRefreshFailures: 0,
        lastFixtureRefreshAt: now - 100_000,
        streamHealth: { odds: true, scores: true },
        lastMessageAt: { odds: now - 100_000, scores: now - 100_000 },
        startedAt: new Date(now - 200_000).toISOString(),
        updatedAt: new Date(now - 100_000).toISOString(),
      }),
    });
    applications.push(application);

    const response = await application.app.inject({
      method: "GET",
      url: "/api/host-health",
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      ok: false,
      worker: { statusFresh: false },
    });
    expect(response.body).not.toContain("lastMessageAt");
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

function liveExecutionFixture() {
  const governor = new QuoteGovernor();
  for (const step of publicJudgeScenario.steps) governor.process(step.input);
  const fixtureId = publicJudgeScenario.match.fixtureId;
  const state = governor.getState(fixtureId);
  const subjectHash = hashExecutionSubject({ fixtureId });
  const now = new Date().toISOString();
  const persisted: PersistedLiveExecutionState = {
    version: 1,
    updatedAt: now,
    contexts: [
      {
        version: 1,
        subjectHash,
        configHash: governor.configHash,
        sequence: publicJudgeScenario.steps.length,
        observedTs: Date.now(),
        state,
        reopenProofs: [...governor.getReopenProofs(fixtureId)],
        updatedAt: now,
      },
    ],
  };
  if (!state.quote) throw new Error("Expected a completed live quote");
  return {
    state: persisted,
    request: {
      version: 1 as const,
      command: "PUBLISH_QUOTE" as const,
      subjectHash,
      market: "1X2" as const,
      quoteHash: hashQuote(state.quote),
    },
  };
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
