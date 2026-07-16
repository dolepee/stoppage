import { verifyPermit } from "@stoppage/sdk";
import { describe, expect, it } from "vitest";

import { QuoteGovernor } from "../domain/governor.js";
import { publicJudgeScenario } from "../replay/public-scenario.js";
import { hashExecutionSubject, hashQuote } from "./execution-gate.js";
import {
  evaluateLiveAgentRequest,
  liveAgentRequestV2Schema,
  type LiveAgentRequestV2,
} from "./live-agent-gate.js";
import { createPermitSigner, publicKeySetFor } from "./permit-v2.js";
import type { ExecutionGateContext } from "./types.js";

const signer = createPermitSigner(
  Uint8Array.from({ length: 32 }, (_, index) => index + 1),
);

describe("live agent execution gate", () => {
  it("signs a live-context permit that the intended agent verifies offline", () => {
    const { context, request } = liveCheckpoint();
    const response = evaluateLiveAgentRequest(request, context, signer, 10_000);

    expect(response).toMatchObject({
      version: 2,
      dataMode: "LIVE_PRIVATE",
      agent: { id: request.agentId, automated: true },
      transport: {
        endpoint: "/api/execution-gate/evaluate",
        keyEndpoint: "/api/permit-keys",
      },
      result: {
        decision: "ALLOW_CERTIFIED_REOPEN",
        permit: {
          body: {
            agentId: request.agentId,
            audience: request.audience,
            nonce: request.nonce,
            sequence: request.sequence,
          },
        },
      },
    });
    expect(
      verifyPermit({
        permit: response.result.permit!,
        intent: request,
        keys: publicKeySetFor(signer),
        now: 10_001,
      }),
    ).toMatchObject({ valid: true, decision: "ALLOW" });
    expect(JSON.stringify(response)).not.toContain("fixtureId");
  });

  it("rejects a stolen permit before the second agent callback can run", () => {
    const { context, request } = liveCheckpoint();
    const response = evaluateLiveAgentRequest(request, context, signer, 10_000);
    const thiefIntent = {
      ...request,
      agentId: "agent-b-permit-thief",
      audience: "venue:agent-b-permit-thief",
    };

    expect(
      verifyPermit({
        permit: response.result.permit!,
        intent: thiefIntent,
        keys: publicKeySetFor(signer),
        now: 10_001,
      }),
    ).toMatchObject({
      valid: false,
      decision: "BLOCK_AUDIENCE_MISMATCH",
    });
  });

  it("fails a stale sequence closed and never signs it", () => {
    const { context, request } = liveCheckpoint();
    const response = evaluateLiveAgentRequest(
      { ...request, sequence: request.sequence - 1 },
      context,
      signer,
      10_000,
    );

    expect(response.result).toMatchObject({
      decision: "BLOCK_INVALIDATED_BRANCH",
      sequence: context.sequence,
      permit: null,
    });
  });

  it("strictly rejects unknown live-agent fields", () => {
    const { request } = liveCheckpoint();
    expect(() =>
      liveAgentRequestV2Schema.parse({ ...request, fixtureId: 12345 }),
    ).toThrow();
  });
});

function liveCheckpoint(): {
  context: ExecutionGateContext;
  request: LiveAgentRequestV2;
} {
  const governor = new QuoteGovernor();
  for (const step of publicJudgeScenario.steps) governor.process(step.input);
  const fixtureId = publicJudgeScenario.match.fixtureId;
  const state = governor.getState(fixtureId);
  if (!state.quote) throw new Error("Expected a completed quote");
  const sequence = publicJudgeScenario.steps.length;
  const subjectHash = hashExecutionSubject({ fixtureId });
  return {
    context: {
      subjectHash,
      configHash: governor.configHash,
      sequence,
      observedTs: 10_000,
      state,
      reopenProofs: [...governor.getReopenProofs(fixtureId)],
    },
    request: {
      version: 2,
      agentId: "agent-a-reference",
      audience: "venue:agent-a-reference",
      nonce: "live-request-0001",
      command: "PUBLISH_QUOTE",
      sequence,
      subjectHash,
      market: "1X2",
      quoteHash: hashQuote(state.quote),
    },
  };
}
