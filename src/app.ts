import { existsSync } from "node:fs";
import { resolve } from "node:path";

import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import { z } from "zod";

import type { AppConfig } from "./config.js";
import { loadConfig } from "./config.js";
import { publicJudgeScenario } from "./replay/public-scenario.js";
import { StoppageRuntime } from "./runtime/stoppage-runtime.js";

interface ApplicationOptions {
  config?: AppConfig;
  logger?: boolean;
  serveStatic?: boolean;
}

export async function createApplication(options: ApplicationOptions = {}) {
  const config = options.config ?? loadConfig();
  const app = Fastify({ logger: options.logger ?? true });
  const runtime = new StoppageRuntime(publicJudgeScenario);

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

  const publicRoot = resolve("dist/public");
  if ((options.serveStatic ?? true) && existsSync(publicRoot)) {
    await app.register(fastifyStatic, {
      root: publicRoot,
      wildcard: false,
    });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api/")) {
        return reply.code(404).send({ error: "Not found" });
      }
      return reply.sendFile("index.html");
    });
  }

  return { app, runtime, config };
}
