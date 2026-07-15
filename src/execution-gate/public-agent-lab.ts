import { z } from "zod";

import { sha256 } from "../domain/canonical.js";
import { QuoteGovernor } from "../domain/governor.js";
import type { ConsensusQuote, GovernorInput } from "../domain/types.js";
import { publicJudgeScenario } from "../replay/public-scenario.js";
import {
  DEFAULT_EXECUTION_GATE_CONFIG,
  evaluateExecutionGate,
  hashExecutionSubject,
  inspectExecutionPermit,
} from "./execution-gate.js";
import type {
  ExecutionGateContext,
  ExecutionGateDecision,
  ExecutionGateRequest,
  ExecutionGateResult,
  ExecutionPermit,
  PermitVerificationResult,
} from "./types.js";

export const publicAgentChallengeSchema = z.enum([
  "QUOTE_TAMPER",
  "EXPIRED_REPLAY",
  "RECEIPT_TAMPER",
]);

export const publicAgentHandshakeSchema = z
  .object({
    version: z.literal(1),
    agentId: z.string().regex(/^[a-z0-9][a-z0-9-]{2,63}$/),
    command: z.literal("PUBLISH_QUOTE"),
    sequence: z.number().int().min(1).max(publicJudgeScenario.steps.length),
    subjectHash: z.string().regex(/^0x[0-9a-f]{64}$/),
    market: z.literal("1X2"),
    quoteHash: z.string().regex(/^0x[0-9a-f]{64}$/),
    challenge: publicAgentChallengeSchema.optional(),
  })
  .strict();

export type PublicAgentChallenge = z.infer<typeof publicAgentChallengeSchema>;
export type PublicAgentHandshakeRequest = z.infer<
  typeof publicAgentHandshakeSchema
>;

export interface PublicAgentChallengeResult extends PermitVerificationResult {
  challenge: PublicAgentChallenge;
  expected: "REJECT";
}

export interface PublicAgentHandshakeResponse {
  version: 1;
  dataMode: "SYNTHETIC";
  scenario: string;
  agent: {
    id: string;
    automated: true;
  };
  transport: {
    protocol: "HTTPS";
    endpoint: "/api/agent-gate";
    requestId: string;
  };
  request: ExecutionGateRequest & { sequence: number };
  result: ExecutionGateResult;
  challenge: PublicAgentChallengeResult | null;
}

export function evaluatePublicAgentHandshake(
  value: unknown,
): PublicAgentHandshakeResponse {
  const input = publicAgentHandshakeSchema.parse(value);
  const context = buildPublicCheckpoint(input.sequence);
  const request: ExecutionGateRequest = {
    version: 1,
    command: input.command,
    subjectHash: input.subjectHash,
    market: input.market,
    quoteHash: input.quoteHash,
  };
  const result = evaluateExecutionGate(request, context);
  const challenge = input.challenge
    ? runChallenge(input.challenge, result.permit, context)
    : null;

  return {
    version: 1,
    dataMode: "SYNTHETIC",
    scenario: publicJudgeScenario.id,
    agent: {
      id: input.agentId,
      automated: true,
    },
    transport: {
      protocol: "HTTPS",
      endpoint: "/api/agent-gate",
      requestId: sha256({
        kind: "STOPPAGE_PUBLIC_AGENT_REQUEST",
        version: 1,
        input,
        decision: result.decision,
      }),
    },
    request: { ...request, sequence: input.sequence },
    result,
    challenge,
  };
}

function buildPublicCheckpoint(sequence: number): ExecutionGateContext {
  const governor = new QuoteGovernor();
  let observedTs = publicJudgeScenario.match.kickoffTs;
  let baselineQuote: ConsensusQuote | null = null;

  for (const step of publicJudgeScenario.steps.slice(0, sequence)) {
    observedTs = inputTimestamp(step.input);
    if (step.input.kind === "quote") baselineQuote = step.input;
    governor.process(step.input);
  }

  const state = governor.getState(publicJudgeScenario.match.fixtureId);
  if (!baselineQuote) {
    throw new Error("The public agent checkpoint has no proposed quote");
  }

  return {
    subjectHash: hashExecutionSubject(publicJudgeScenario.id),
    configHash: governor.configHash,
    sequence,
    observedTs,
    state,
    reopenProofs: governor.getReopenProofs(publicJudgeScenario.match.fixtureId),
  };
}

function runChallenge(
  challenge: PublicAgentChallenge,
  permit: ExecutionPermit | null,
  context: ExecutionGateContext,
): PublicAgentChallengeResult {
  if (!permit) {
    return {
      challenge,
      expected: "REJECT",
      valid: false,
      decision: "BLOCK_INVALIDATED_BRANCH",
      reason: "No valid permit exists at this checkpoint to challenge.",
    };
  }

  const candidate = structuredClone(permit);
  let verification: PermitVerificationResult;

  if (challenge === "QUOTE_TAMPER") {
    candidate.body.quoteHash = differentHash(candidate.body.quoteHash);
    verification = inspectExecutionPermit(
      candidate,
      context,
      context.observedTs,
    );
  } else if (challenge === "RECEIPT_TAMPER") {
    candidate.body.stateReceiptHash = differentHash(
      candidate.body.stateReceiptHash ?? candidate.hash,
    );
    verification = inspectExecutionPermit(
      candidate,
      context,
      context.observedTs,
    );
  } else {
    verification = inspectExecutionPermit(
      candidate,
      context,
      candidate.body.expiresAt,
    );
  }

  return {
    challenge,
    expected: "REJECT",
    ...verification,
  };
}

function differentHash(value: string): string {
  const replacement = value.endsWith("0") ? "1" : "0";
  return `${value.slice(0, -1)}${replacement}`;
}

function inputTimestamp(input: GovernorInput): number {
  if (
    input.kind === "quote" ||
    input.kind === "match-event" ||
    input.kind === "event-resolution"
  ) {
    return input.receivedTs;
  }
  return input.observedTs;
}

export function isAllowedDecision(
  decision: ExecutionGateDecision,
): decision is "ALLOW_HEALTHY_QUOTE" | "ALLOW_CERTIFIED_REOPEN" {
  return decision.startsWith("ALLOW_");
}
