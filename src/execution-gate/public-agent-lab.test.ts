import { describe, expect, it } from "vitest";

import { publicJudgeScenario } from "../replay/public-scenario.js";
import { hashExecutionSubject, hashQuote } from "./execution-gate.js";
import {
  evaluatePublicAgentHandshake,
  type PublicAgentChallenge,
} from "./public-agent-lab.js";

const agentId = "judge-market-maker-v1";
const subjectHash = hashExecutionSubject(publicJudgeScenario.id);

describe("public agent lab", () => {
  it("reproduces the blocked external-agent request during the VAR hold", () => {
    const result = evaluatePublicAgentHandshake(requestAt(2));

    expect(result).toMatchObject({
      dataMode: "SYNTHETIC",
      agent: { id: agentId, automated: true },
      transport: { protocol: "HTTPS", endpoint: "/api/agent-gate" },
      result: {
        decision: "BLOCK_UNRESOLVED_INCIDENT",
        permit: null,
      },
    });
  });

  it("returns the exact Certified Reopen permit at the final checkpoint", () => {
    const result = evaluatePublicAgentHandshake(requestAt(12));

    expect(result.result).toMatchObject({
      decision: "ALLOW_CERTIFIED_REOPEN",
      permit: {
        body: {
          sequence: 12,
          reopenProofHash: expect.stringMatching(/^0x[0-9a-f]{64}$/),
        },
      },
    });
  });

  it.each<PublicAgentChallenge>([
    "QUOTE_TAMPER",
    "EXPIRED_REPLAY",
    "RECEIPT_TAMPER",
  ])("rejects the %s challenge server-side", (challenge) => {
    const result = evaluatePublicAgentHandshake({
      ...requestAt(12),
      challenge,
    });

    expect(result.challenge).toMatchObject({
      challenge,
      expected: "REJECT",
      valid: false,
    });
    expect(result.challenge?.decision).toMatch(/^BLOCK_/);
  });

  it("fails a quote hash from the wrong branch closed", () => {
    const result = evaluatePublicAgentHandshake({
      ...requestAt(12),
      quoteHash: quoteHashAt(1),
    });

    expect(result.result).toMatchObject({
      decision: "BLOCK_QUOTE_STALE",
      permit: null,
    });
  });

  it("rejects unknown request properties", () => {
    expect(() =>
      evaluatePublicAgentHandshake({ ...requestAt(12), fixtureId: 9_000_001 }),
    ).toThrow();
  });
});

function requestAt(sequence: number) {
  return {
    version: 1 as const,
    agentId,
    command: "PUBLISH_QUOTE" as const,
    sequence,
    subjectHash,
    market: "1X2" as const,
    quoteHash: quoteHashAt(sequence),
  };
}

function quoteHashAt(sequence: number): string {
  const quote = [...publicJudgeScenario.steps]
    .slice(0, sequence)
    .reverse()
    .find((step) => step.input.kind === "quote")?.input;
  if (!quote || quote.kind !== "quote") {
    throw new Error(`No quote at sequence ${sequence}`);
  }
  return hashQuote(quote);
}
