import { describe, expect, it, vi } from "vitest";

import { StoppageAgentClient } from "./stoppage-agent-client.js";
import { sha256 } from "../domain/canonical.js";
import type { ExecutionGateRequest } from "../execution-gate/types.js";

describe("StoppageAgentClient", () => {
  it("sends an external agent request to the public HTTPS lab", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          version: 1,
          dataMode: "SYNTHETIC",
          result: { decision: "BLOCK_UNRESOLVED_INCIDENT" },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    const client = new StoppageAgentClient({
      baseUrl: "https://stoppage.example/",
      fetch,
    });

    await client.runPublicLab({
      version: 1,
      agentId: "test-market-maker",
      command: "PUBLISH_QUOTE",
      sequence: 2,
      subjectHash: `0x${"1".repeat(64)}`,
      market: "1X2",
      quoteHash: `0x${"2".repeat(64)}`,
    });

    expect(fetch).toHaveBeenCalledWith(
      "https://stoppage.example/api/agent-gate",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining('"agentId":"test-market-maker"'),
      }),
    );
  });

  it("fails visibly when the gate endpoint is unavailable", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response(null, { status: 503 }));
    const client = new StoppageAgentClient({ fetch });

    await expect(
      client.evaluate({
        version: 1,
        command: "PUBLISH_QUOTE",
        subjectHash: `0x${"1".repeat(64)}`,
        market: "1X2",
        quoteHash: `0x${"2".repeat(64)}`,
      }),
    ).rejects.toThrow("HTTP 503");
  });

  it("verifies the canonical permit binding before an agent can publish", () => {
    const client = new StoppageAgentClient({ fetch: vi.fn() });
    const request: ExecutionGateRequest = {
      version: 1,
      command: "PUBLISH_QUOTE",
      subjectHash: `0x${"1".repeat(64)}`,
      market: "1X2",
      quoteHash: `0x${"2".repeat(64)}`,
    };
    const body = {
      version: 1 as const,
      decision: "ALLOW_CERTIFIED_REOPEN" as const,
      reason: "Certified",
      subjectHash: request.subjectHash,
      market: request.market,
      quoteHash: request.quoteHash,
      configHash: `0x${"3".repeat(64)}`,
      stateReceiptHash: `0x${"4".repeat(64)}`,
      reopenProofHash: `0x${"5".repeat(64)}`,
      sequence: 12,
      issuedAt: 1_000,
      expiresAt: 6_000,
    };
    const permit = { body, hash: sha256(body) };

    expect(client.verifyPermitBinding(permit, request, 1_001)).toBe(true);
    expect(
      client.verifyPermitBinding(
        { ...permit, hash: `0x${"0".repeat(64)}` },
        request,
        1_001,
      ),
    ).toBe(false);
    expect(client.verifyPermitBinding(permit, request, 6_000)).toBe(false);
  });
});
