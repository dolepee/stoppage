import { afterEach, describe, expect, it } from "vitest";

import { createApplication } from "./app.js";

const applications: Awaited<ReturnType<typeof createApplication>>[] = [];

afterEach(async () => {
  await Promise.all(applications.splice(0).map(({ app }) => app.close()));
});

describe("operator API", () => {
  it("reports an honest mainnet activation state", async () => {
    const application = await createApplication({
      logger: false,
      serveStatic: false,
    });
    applications.push(application);

    const response = await application.app.inject({
      method: "GET",
      url: "/api/health",
    });
    expect(response.statusCode).toBe(200);
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
});
