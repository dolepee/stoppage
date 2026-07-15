import { describe, expect, it } from "vitest";

import { publicJudgeScenario } from "../replay/public-scenario.js";
import { hashExecutionSubject, hashQuote } from "./execution-gate.js";
import {
  evaluatePublicAgentHandshake,
  type PublicAgentChallenge,
} from "./public-agent-lab.js";
import {
  createPermitSigner,
  inspectExecutionPermitV2,
  publicKeySetFor,
} from "./permit-v2.js";

const agentId = "judge-market-maker-v1";
const subjectHash = hashExecutionSubject(publicJudgeScenario.id);
const signer = createPermitSigner(
  Uint8Array.from({ length: 32 }, (_, index) => index + 1),
);

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

  it.each(["QUOTE_TAMPER", "RECEIPT_TAMPER"] as const)(
    "rehashes the %s candidate so the state binding check is exercised",
    (challenge) => {
      const result = evaluatePublicAgentHandshake({
        ...requestAt(12),
        challenge,
      });

      expect(result.challenge).toMatchObject({
        challenge,
        decision: "BLOCK_INVALIDATED_BRANCH",
        reason: "The permit no longer matches the current governor state.",
      });
    },
  );

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

  it("signs Permit V2 only after Certified Reopen and verifies it offline", () => {
    const blocked = evaluatePublicAgentHandshake(requestV2At(2), signer);
    expect(blocked.result).toMatchObject({
      decision: "BLOCK_UNRESOLVED_INCIDENT",
      permit: null,
    });

    const allowed = evaluatePublicAgentHandshake(requestV2At(12), signer);
    if (allowed.version !== 2) throw new Error("Expected Permit V2 response");
    expect(allowed.result).toMatchObject({
      decision: "ALLOW_CERTIFIED_REOPEN",
      permit: {
        alg: "Ed25519",
        body: {
          version: 2,
          kid: signer.kid,
          audience: "venue:judge-market-maker-v2",
          nonce: "judge-request-0001",
        },
        signature: expect.any(String),
      },
    });
    expect(
      inspectExecutionPermitV2({
        permit: allowed.result.permit!,
        request: {
          agentId: allowed.request.agentId,
          audience: allowed.request.audience,
          nonce: allowed.request.nonce,
          command: allowed.request.command,
          subjectHash: allowed.request.subjectHash,
          market: allowed.request.market,
          quoteHash: allowed.request.quoteHash,
        },
        keys: publicKeySetFor(signer),
        now: allowed.result.evaluatedAt,
      }),
    ).toMatchObject({ valid: true, decision: "ALLOW" });
  });

  it.each<PublicAgentChallenge>([
    "QUOTE_TAMPER",
    "RECEIPT_TAMPER",
    "EXPIRED_REPLAY",
    "WRONG_AUDIENCE",
    "UNKNOWN_SIGNING_KEY",
    "REUSED_NONCE",
  ])("rejects Permit V2 Bench Lite attack %s", (challenge) => {
    const response = evaluatePublicAgentHandshake(
      { ...requestV2At(12), challenge },
      signer,
    );

    expect(response.challenge).toMatchObject({
      challenge,
      expected: "REJECT",
      valid: false,
      decision: expect.stringMatching(/^BLOCK_/),
    });
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

function requestV2At(sequence: number) {
  return {
    version: 2 as const,
    agentId: "judge-market-maker-v2",
    audience: "venue:judge-market-maker-v2",
    nonce: "judge-request-0001",
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
