import { existsSync } from "node:fs";
import { resolve } from "node:path";

import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import { z } from "zod";

import type { AppConfig } from "./config.js";
import { loadConfig } from "./config.js";
import type { LiveWorkerStatus } from "./live/types.js";
import { readRuntimeState } from "./private/runtime-store.js";
import { publicJudgeScenario } from "./replay/public-scenario.js";
import { StoppageRuntime } from "./runtime/stoppage-runtime.js";
import { loadLatestPublicClaim } from "./evidence/public-claim.js";
import { evaluateExecutionGate } from "./execution-gate/execution-gate.js";
import {
  evaluatePublicAgentHandshake,
  getPublicAgentContext,
} from "./execution-gate/public-agent-lab.js";
import {
  loadPermitSigner,
  publicKeySetFor,
} from "./execution-gate/permit-v2.js";
import {
  executionContextFromPersisted,
  LIVE_EXECUTION_CONTEXT_MAX_AGE_MS,
  readLiveExecutionState,
  type PersistedLiveExecutionState,
} from "./execution-gate/live-context.js";

interface ApplicationOptions {
  config?: AppConfig;
  logger?: boolean;
  serveStatic?: boolean;
  staticRoot?: string;
  readWorkerStatus?: WorkerStatusReader;
  readLiveGateState?: LiveGateStateReader;
  publicClaimRoot?: string;
}

type PersistedWorkerStatus = LiveWorkerStatus & { updatedAt: string };
type WorkerStatusReader = () => Promise<PersistedWorkerStatus | null>;
type LiveGateStateReader = () => Promise<PersistedLiveExecutionState | null>;
const WORKER_STATUS_MAX_AGE_MS = 15_000;

export async function createApplication(options: ApplicationOptions = {}) {
  const config = options.config ?? loadConfig();
  const app = Fastify({ logger: options.logger ?? true });
  const runtime = new StoppageRuntime(publicJudgeScenario);
  const readWorkerStatus =
    options.readWorkerStatus ??
    (() => readRuntimeState<PersistedWorkerStatus>("worker-status.json"));
  const readLiveGateState =
    options.readLiveGateState ?? (() => readLiveExecutionState());
  const publicClaimRoot = options.publicClaimRoot ?? "data/public";

  app.addHook("onRequest", async (_request, reply) => {
    reply
      .header("X-Content-Type-Options", "nosniff")
      .header("X-Frame-Options", "DENY")
      .header("Referrer-Policy", "strict-origin-when-cross-origin")
      .header("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
      .header(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'",
      );
  });

  app.addHook("onSend", async (request, reply, payload) => {
    const pathname = request.url.split("?", 1)[0] ?? request.url;
    if (
      reply.statusCode < 400 &&
      pathname.startsWith("/assets/") &&
      pathname.endsWith(".js")
    ) {
      reply.type("text/javascript; charset=utf-8");
    }
    return payload;
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof z.ZodError) {
      return reply.code(400).send({
        error: "Invalid request",
        issues: error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      });
    }
    app.log.error(error);
    return reply.code(500).send({ error: "Internal server error" });
  });

  app.addHook("onClose", async () => runtime.stop());

  app.get("/api/health", async () => ({
    ok: true,
    service: "stoppage",
    network: "solana-mainnet",
    txlineMode: config.txlineApiToken ? "configured" : "awaiting-activation",
    now: new Date().toISOString(),
  }));

  app.get("/api/status", async () => runtime.snapshot());

  app.get("/api/execution-gate", async () => runtime.snapshot().execution);

  app.post("/api/execution-gate/evaluate", async (request) => {
    const body = z
      .object({
        version: z.literal(1),
        command: z.literal("PUBLISH_QUOTE"),
        subjectHash: z.string().regex(/^0x[0-9a-f]{64}$/),
        market: z.literal("1X2"),
        quoteHash: z.string().regex(/^0x[0-9a-f]{64}$/),
      })
      .strict()
      .parse(request.body);
    const synthetic = runtime.snapshot();
    if (body.subjectHash === synthetic.execution.subjectHash) {
      return runtime.evaluateExecution(body);
    }

    const now = Date.now();
    let liveContext:
      PersistedLiveExecutionState["contexts"][number] | undefined;
    try {
      const persisted = await readLiveGateState();
      liveContext = Array.isArray(persisted?.contexts)
        ? persisted.contexts.find(
            (context) => context.subjectHash === body.subjectHash,
          )
        : undefined;
    } catch (error) {
      app.log.error({ error }, "private live execution state is unreadable");
      return unavailableLiveGate(now, 0);
    }
    const contextUpdatedAt = liveContext
      ? Date.parse(liveContext.updatedAt)
      : Number.NaN;
    if (
      !liveContext ||
      !Number.isFinite(contextUpdatedAt) ||
      contextUpdatedAt > now + 5_000 ||
      now - contextUpdatedAt >= LIVE_EXECUTION_CONTEXT_MAX_AGE_MS
    ) {
      return unavailableLiveGate(now, liveContext?.sequence ?? 0);
    }

    try {
      return evaluateExecutionGate(
        body,
        executionContextFromPersisted(liveContext, now),
      );
    } catch (error) {
      app.log.error({ error }, "private live execution context is invalid");
      return unavailableLiveGate(now, liveContext.sequence);
    }
  });

  app.post("/api/agent-gate", async (request, reply) => {
    const value = request.body;
    const signer =
      value &&
      typeof value === "object" &&
      "version" in value &&
      value.version === 2
        ? loadPermitSigner()
        : undefined;
    return reply
      .header("Cache-Control", "no-store")
      .send(evaluatePublicAgentHandshake(value, signer));
  });

  app.get("/api/agent-context", async (_request, reply) => {
    return reply
      .header("Cache-Control", "no-store")
      .send(getPublicAgentContext());
  });

  app.get("/api/permit-keys", async (_request, reply) => {
    return reply
      .header("Cache-Control", "no-store")
      .send(publicKeySetFor(loadPermitSigner()));
  });

  app.get("/api/worker-health", async () => {
    const status = await readWorkerStatus();
    if (!status) {
      return {
        available: false,
        configured: Boolean(config.txlineApiToken),
      };
    }
    const now = Date.now();
    const updatedAt = Date.parse(status.updatedAt);
    const statusFresh =
      Number.isFinite(updatedAt) &&
      updatedAt <= now + 5_000 &&
      now - updatedAt < WORKER_STATUS_MAX_AGE_MS;
    return {
      available: true,
      configured: Boolean(config.txlineApiToken),
      running: status.running,
      statusFresh,
      fixturesLoaded: status.fixturesLoaded,
      messages: {
        odds: status.oddsMessages,
        scores: status.scoreMessages,
      },
      normalizedOdds: status.normalizedOdds,
      normalizedEvents: status.normalizedEvents,
      reconnects: status.reconnects,
      fixtureRefreshes: status.fixtureRefreshes,
      fixtureRefreshFailures: status.fixtureRefreshFailures,
      streamHealth: status.streamHealth,
      lastMessageAgeMs: {
        odds:
          status.lastMessageAt.odds === null
            ? null
            : Math.max(0, now - status.lastMessageAt.odds),
        scores:
          status.lastMessageAt.scores === null
            ? null
            : Math.max(0, now - status.lastMessageAt.scores),
      },
      updatedAt: status.updatedAt,
    };
  });

  app.get("/api/host-health", async (_request, reply) => {
    const status = await readWorkerStatus();
    const now = Date.now();
    const updatedAt = status ? Date.parse(status.updatedAt) : Number.NaN;
    const statusFresh =
      Number.isFinite(updatedAt) &&
      updatedAt <= now + 5_000 &&
      now - updatedAt < WORKER_STATUS_MAX_AGE_MS;
    const streamsHealthy = Boolean(
      status?.streamHealth.odds && status.streamHealth.scores,
    );
    const healthy = Boolean(status?.running && statusFresh && streamsHealthy);
    return reply.code(healthy ? 200 : 503).send({
      ok: healthy,
      service: "stoppage-hosted-worker",
      worker: {
        available: Boolean(status),
        running: status?.running ?? false,
        statusFresh,
        streamsHealthy,
        reconnects: status?.reconnects ?? { odds: 0, scores: 0 },
        fixtureRefreshFailures: status?.fixtureRefreshFailures ?? 0,
      },
    });
  });

  app.post("/api/replay/start", async (request, reply) => {
    const body = z
      .object({ speed: z.number().min(0.25).max(16).default(4) })
      .default({ speed: 4 })
      .parse(request.body ?? {});

    void runtime.start(body.speed).catch((error) => app.log.error(error));
    return reply.code(202).send(runtime.snapshot());
  });

  app.post("/api/replay/stop", async (_request, reply) => {
    runtime.stop();
    return reply.send(runtime.snapshot());
  });

  app.get("/api/events", async (request, reply) => {
    reply.hijack();
    const response = reply.raw;
    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    const send = (snapshot: ReturnType<StoppageRuntime["snapshot"]>) => {
      response.write(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);
    };
    send(runtime.snapshot());
    const unsubscribe = runtime.subscribe(send);

    const heartbeat = setInterval(
      () => response.write(": heartbeat\n\n"),
      15_000,
    );
    request.raw.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
      response.end();
    });
  });

  app.get("/api/public-claim", async (request, reply) => {
    const query = z
      .object({
        approvedConfigHash: z
          .string()
          .regex(/^0x[0-9a-fA-F]{64}$/)
          .optional(),
      })
      .passthrough()
      .default({})
      .parse(request.query);

    const claim = await loadLatestPublicClaim(
      publicClaimRoot,
      query.approvedConfigHash,
    );

    if (!claim) {
      return reply.code(404).send({
        error: "Public claim not available",
      });
    }

    return claim;
  });

  const publicRoot = resolve(options.staticRoot ?? "dist/public");
  if ((options.serveStatic ?? true) && existsSync(publicRoot)) {
    await app.register(fastifyStatic, {
      root: publicRoot,
      wildcard: true,
    });
    app.setNotFoundHandler((request, reply) => {
      if (
        request.url.startsWith("/api/") ||
        request.url.startsWith("/assets/")
      ) {
        return reply.code(404).send({ error: "Not found" });
      }
      return reply.sendFile("index.html");
    });
  }

  return { app, runtime, config };
}

function unavailableLiveGate(evaluatedAt: number, sequence: number) {
  return {
    version: 1 as const,
    command: "PUBLISH_QUOTE" as const,
    decision: "BLOCK_STREAM_UNHEALTHY" as const,
    reason:
      "No fresh valid private live-worker context is available for this subject; execution fails closed.",
    evaluatedAt,
    sequence,
    permit: null,
  };
}
