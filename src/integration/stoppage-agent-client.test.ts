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

  it("verifies the complete allowed response before an agent can publish", () => {
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
    const result = {
      version: 1 as const,
      command: "PUBLISH_QUOTE" as const,
      decision: body.decision,
      reason: body.reason,
      evaluatedAt: body.issuedAt,
      sequence: body.sequence,
      permit,
    };

    expect(client.verifyPermitBinding(result, request, 1_001)).toBe(true);
    expect(
      client.verifyPermitBinding(
        {
          ...result,
          permit: { ...permit, hash: `0x${"0".repeat(64)}` },
        },
        request,
        1_001,
      ),
    ).toBe(false);
    expect(client.verifyPermitBinding(result, request, 6_000)).toBe(false);
  });

  it("rejects hostile responses even when the attacker rehashes the body", () => {
    const client = new StoppageAgentClient({ fetch: vi.fn() });
    const request: ExecutionGateRequest = {
      version: 1,
      command: "PUBLISH_QUOTE",
      subjectHash: `0x${"1".repeat(64)}`,
      market: "1X2",
      quoteHash: `0x${"2".repeat(64)}`,
    };
    const validBody = {
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
    const responseFor = (body: typeof validBody) => ({
      version: 1 as const,
      command: "PUBLISH_QUOTE" as const,
      decision: body.decision,
      reason: body.reason,
      evaluatedAt: body.issuedAt,
      sequence: body.sequence,
      permit: { body, hash: sha256(body) },
    });

    const hostileBodies = [
      { ...validBody, sequence: -99 },
      { ...validBody, configHash: "malformed" },
      { ...validBody, stateReceiptHash: "malformed" },
      { ...validBody, reopenProofHash: null },
    ];
    for (const body of hostileBodies) {
      expect(
        client.verifyPermitBinding(
          responseFor(body as typeof validBody),
          request,
          1_001,
        ),
      ).toBe(false);
    }

    const blockedBody = {
      ...validBody,
      decision: "BLOCK_STREAM_UNHEALTHY",
      sequence: -99,
      configHash: "malformed",
      stateReceiptHash: "malformed",
      reopenProofHash: "malformed",
    };
    const blockedResponse = {
      version: 1,
      command: "PUBLISH_QUOTE",
      decision: "BLOCK_STREAM_UNHEALTHY",
      reason: blockedBody.reason,
      evaluatedAt: blockedBody.issuedAt,
      sequence: blockedBody.sequence,
      permit: { body: blockedBody, hash: sha256(blockedBody) },
    };
    expect(
      client.verifyPermitBinding(blockedResponse as never, request, 1_001),
    ).toBe(false);
  });

  it("rejects response and permit fields that disagree", () => {
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
      decision: "ALLOW_HEALTHY_QUOTE" as const,
      reason: "Healthy",
      subjectHash: request.subjectHash,
      market: request.market,
      quoteHash: request.quoteHash,
      configHash: `0x${"3".repeat(64)}`,
      stateReceiptHash: null,
      reopenProofHash: null,
      sequence: 7,
      issuedAt: 1_000,
      expiresAt: 6_000,
    };
    const permit = { body, hash: sha256(body) };
    const result = {
      version: 1 as const,
      command: "PUBLISH_QUOTE" as const,
      decision: body.decision,
      reason: body.reason,
      evaluatedAt: body.issuedAt,
      sequence: body.sequence,
      permit,
    };

    expect(
      client.verifyPermitBinding(
        { ...result, sequence: result.sequence + 1 },
        request,
        1_001,
      ),
    ).toBe(false);
    expect(
      client.verifyPermitBinding(
        { ...result, reason: "Different response reason" },
        request,
        1_001,
      ),
    ).toBe(false);
    expect(
      client.verifyPermitBinding(
        { ...result, evaluatedAt: result.evaluatedAt + 1 },
        request,
        1_001,
      ),
    ).toBe(false);
  });
});
