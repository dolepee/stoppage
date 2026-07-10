import { afterEach, describe, expect, it } from "vitest";

import { createApplication } from "./app.js";
import { loadConfig } from "./config.js";

const applications: Awaited<ReturnType<typeof createApplication>>[] = [];

afterEach(async () => {
  await Promise.all(applications.splice(0).map(({ app }) => app.close()));
});

describe("operator API", () => {
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
