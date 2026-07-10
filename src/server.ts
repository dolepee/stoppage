import { existsSync } from "node:fs";
import { resolve } from "node:path";

import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import { z } from "zod";

import { loadConfig } from "./config.js";
import { publicJudgeScenario } from "./replay/public-scenario.js";
import { StoppageRuntime } from "./runtime/stoppage-runtime.js";

const config = loadConfig();
const app = Fastify({ logger: true });
const runtime = new StoppageRuntime(publicJudgeScenario);

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
  runtime.on("snapshot", send);

  const heartbeat = setInterval(
    () => response.write(": heartbeat\n\n"),
    15_000,
  );
  request.raw.on("close", () => {
    clearInterval(heartbeat);
    runtime.off("snapshot", send);
    response.end();
  });
});

const publicRoot = resolve("dist/public");
if (existsSync(publicRoot)) {
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

await app.listen({ host: config.host, port: config.port });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void app.close().finally(() => process.exit(0));
  });
}
