import { z } from "zod";

import { sha256 } from "../domain/canonical.js";
import { evaluateExecutionGate } from "./execution-gate.js";
import {
  issueExecutionPermitV2,
  type ExecutionGateResultV2,
  type PermitSigner,
  type PermitV2RequestBinding,
} from "./permit-v2.js";
import type {
  ExecutionGateContext,
  ExecutionGateRequest,
  ExecutionGateResult,
} from "./types.js";

const hashSchema = z.string().regex(/^0x[0-9a-f]{64}$/);

export const executionGateRequestV1Schema = z
  .object({
    version: z.literal(1),
    command: z.literal("PUBLISH_QUOTE"),
    subjectHash: hashSchema,
    market: z.literal("1X2"),
    quoteHash: hashSchema,
  })
  .strict();

export const liveAgentRequestV2Schema = z
  .object({
    version: z.literal(2),
    agentId: z.string().regex(/^[a-z0-9][a-z0-9-]{2,63}$/),
    audience: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9:._/-]{2,127}$/),
    nonce: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9:._-]{7,127}$/),
    command: z.literal("PUBLISH_QUOTE"),
    sequence: z.number().int().min(1),
    subjectHash: hashSchema,
    market: z.literal("1X2"),
    quoteHash: hashSchema,
  })
  .strict();

export const liveExecutionGateRequestSchema = z.discriminatedUnion("version", [
  executionGateRequestV1Schema,
  liveAgentRequestV2Schema,
]);

export type LiveAgentRequestV2 = z.infer<typeof liveAgentRequestV2Schema>;

export interface LiveAgentResponseV2 {
  version: 2;
  dataMode: "LIVE_PRIVATE";
  agent: {
    id: string;
    automated: true;
  };
  transport: {
    protocol: "HTTPS";
    endpoint: "/api/execution-gate/evaluate";
    keyEndpoint: "/api/permit-keys";
    requestId: string;
  };
  request: LiveAgentRequestV2;
  result: ExecutionGateResultV2;
}

export function evaluateLiveAgentRequest(
  request: LiveAgentRequestV2,
  context: ExecutionGateContext,
  signer: PermitSigner,
  now = Date.now(),
): LiveAgentResponseV2 {
  const binding = bindingFor(request);
  const result =
    request.sequence === context.sequence
      ? evaluateExecutionGate(v1RequestFor(request), context)
      : sequenceMismatch(context, now);

  return liveAgentResponse(
    request,
    issueExecutionPermitV2(result, binding, signer, now),
  );
}

export function unavailableLiveAgentResponse(
  request: LiveAgentRequestV2,
  evaluatedAt: number,
  sequence: number,
): LiveAgentResponseV2 {
  return liveAgentResponse(request, {
    version: 2,
    command: "PUBLISH_QUOTE",
    decision: "BLOCK_STREAM_UNHEALTHY",
    reason:
      "No fresh valid private live-worker context is available for this subject; execution fails closed.",
    evaluatedAt,
    sequence,
    permit: null,
  });
}

function liveAgentResponse(
  request: LiveAgentRequestV2,
  result: ExecutionGateResultV2,
): LiveAgentResponseV2 {
  return {
    version: 2,
    dataMode: "LIVE_PRIVATE",
    agent: { id: request.agentId, automated: true },
    transport: {
      protocol: "HTTPS",
      endpoint: "/api/execution-gate/evaluate",
      keyEndpoint: "/api/permit-keys",
      requestId: sha256({
        kind: "STOPPAGE_LIVE_AGENT_REQUEST",
        version: 2,
        request,
        decision: result.decision,
      }),
    },
    request,
    result,
  };
}

function bindingFor(request: LiveAgentRequestV2): PermitV2RequestBinding {
  return {
    agentId: request.agentId,
    audience: request.audience,
    nonce: request.nonce,
    command: request.command,
    subjectHash: request.subjectHash,
    market: request.market,
    quoteHash: request.quoteHash,
    sequence: request.sequence,
  };
}

function v1RequestFor(request: LiveAgentRequestV2): ExecutionGateRequest {
  return {
    version: 1,
    command: request.command,
    subjectHash: request.subjectHash,
    market: request.market,
    quoteHash: request.quoteHash,
  };
}

function sequenceMismatch(
  context: ExecutionGateContext,
  evaluatedAt: number,
): ExecutionGateResult {
  return {
    version: 1,
    command: "PUBLISH_QUOTE",
    decision: "BLOCK_INVALIDATED_BRANCH",
    reason: "The requested execution sequence is no longer current.",
    evaluatedAt,
    sequence: context.sequence,
    permit: null,
  };
}
