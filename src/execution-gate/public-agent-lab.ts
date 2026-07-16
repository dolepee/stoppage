import { z } from "zod";

import { sha256 } from "../domain/canonical.js";
import { QuoteGovernor } from "../domain/governor.js";
import type { ConsensusQuote, GovernorInput } from "../domain/types.js";
import { publicJudgeScenario } from "../replay/public-scenario.js";
import {
  DEFAULT_EXECUTION_GATE_CONFIG,
  evaluateExecutionGate,
  hashExecutionSubject,
  hashQuote,
  inspectExecutionPermit,
} from "./execution-gate.js";
import {
  inspectExecutionPermitV2,
  issueExecutionPermitV2,
  nonceKey,
  publicKeySetFor,
  type ExecutionGateResultV2,
  type PermitSigner,
  type PermitV2BlockDecision,
  type PermitV2RequestBinding,
  type SignedExecutionPermitV2,
} from "./permit-v2.js";
import type {
  ExecutionGateContext,
  ExecutionGateDecision,
  ExecutionGateRequest,
  ExecutionGateResult,
  ExecutionPermit,
  PermitVerificationResult,
} from "./types.js";

export const publicAgentChallengeV1Schema = z.enum([
  "QUOTE_TAMPER",
  "EXPIRED_REPLAY",
  "RECEIPT_TAMPER",
]);

export const publicAgentChallengeSchema = z.enum([
  "QUOTE_TAMPER",
  "RECEIPT_TAMPER",
  "EXPIRED_REPLAY",
  "WRONG_AUDIENCE",
  "UNKNOWN_SIGNING_KEY",
  "REUSED_NONCE",
]);

const commonHandshakeShape = {
  agentId: z.string().regex(/^[a-z0-9][a-z0-9-]{2,63}$/),
  command: z.literal("PUBLISH_QUOTE"),
  sequence: z.number().int().min(1).max(publicJudgeScenario.steps.length),
  subjectHash: z.string().regex(/^0x[0-9a-f]{64}$/),
  market: z.literal("1X2"),
  quoteHash: z.string().regex(/^0x[0-9a-f]{64}$/),
};

export const publicAgentHandshakeV1Schema = z
  .object({
    version: z.literal(1),
    ...commonHandshakeShape,
    challenge: publicAgentChallengeV1Schema.optional(),
  })
  .strict();

export const publicAgentHandshakeV2Schema = z
  .object({
    version: z.literal(2),
    ...commonHandshakeShape,
    audience: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9:._/-]{2,127}$/),
    nonce: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9:._-]{7,127}$/),
    challenge: publicAgentChallengeSchema.optional(),
  })
  .strict();

export const publicAgentHandshakeSchema = z.discriminatedUnion("version", [
  publicAgentHandshakeV1Schema,
  publicAgentHandshakeV2Schema,
]);

export type PublicAgentChallenge = z.infer<typeof publicAgentChallengeSchema>;
export type PublicAgentHandshakeRequestV1 = z.infer<
  typeof publicAgentHandshakeV1Schema
>;
export type PublicAgentHandshakeRequestV2 = z.infer<
  typeof publicAgentHandshakeV2Schema
>;
export type PublicAgentHandshakeRequest = z.infer<
  typeof publicAgentHandshakeSchema
>;

export interface PublicAgentChallengeResult {
  challenge: PublicAgentChallenge;
  expected: "REJECT";
  valid: boolean;
  decision: ExecutionGateDecision | PermitV2BlockDecision | "ALLOW";
  reason: string;
}

interface PublicAgentResponseBase {
  dataMode: "SYNTHETIC";
  scenario: string;
  agent: {
    id: string;
    automated: true;
  };
}

export interface PublicAgentHandshakeResponseV1 extends PublicAgentResponseBase {
  version: 1;
  transport: {
    protocol: "HTTPS";
    endpoint: "/api/agent-gate";
    requestId: string;
  };
  request: ExecutionGateRequest & { sequence: number };
  result: ExecutionGateResult;
  challenge: PublicAgentChallengeResult | null;
}

export interface PublicAgentHandshakeResponseV2 extends PublicAgentResponseBase {
  version: 2;
  transport: {
    protocol: "HTTPS";
    endpoint: "/api/agent-gate";
    keyEndpoint: "/api/permit-keys";
    requestId: string;
  };
  request: PublicAgentHandshakeRequestV2;
  result: ExecutionGateResultV2;
  challenge: PublicAgentChallengeResult | null;
}

export type PublicAgentHandshakeResponse =
  PublicAgentHandshakeResponseV1 | PublicAgentHandshakeResponseV2;

export interface PublicAgentContext {
  version: 2;
  dataMode: "SYNTHETIC";
  scenario: string;
  sequence: number;
  subjectHash: string;
  market: "1X2";
  quoteHash: string;
}

export function getPublicAgentContext(): PublicAgentContext {
  const sequence = publicJudgeScenario.steps.length;
  const context = buildPublicCheckpoint(sequence);
  const quote = [...publicJudgeScenario.steps]
    .reverse()
    .find((step) => step.input.kind === "quote")?.input;
  if (!quote || quote.kind !== "quote") {
    throw new Error("The public agent context has no proposed quote");
  }
  return {
    version: 2,
    dataMode: "SYNTHETIC",
    scenario: publicJudgeScenario.id,
    sequence,
    subjectHash: context.subjectHash,
    market: "1X2",
    quoteHash: hashQuote(quote),
  };
}

export function evaluatePublicAgentHandshake(
  value: PublicAgentHandshakeRequestV1,
  signer?: PermitSigner,
): PublicAgentHandshakeResponseV1;
export function evaluatePublicAgentHandshake(
  value: PublicAgentHandshakeRequestV2,
  signer: PermitSigner,
): PublicAgentHandshakeResponseV2;
export function evaluatePublicAgentHandshake(
  value: unknown,
  signer?: PermitSigner,
): PublicAgentHandshakeResponse;
export function evaluatePublicAgentHandshake(
  value: unknown,
  signer?: PermitSigner,
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

  if (input.version === 1) {
    const challenge = input.challenge
      ? runChallengeV1(input.challenge, result.permit, context)
      : null;
    return {
      version: 1,
      dataMode: "SYNTHETIC",
      scenario: publicJudgeScenario.id,
      agent: { id: input.agentId, automated: true },
      transport: {
        protocol: "HTTPS",
        endpoint: "/api/agent-gate",
        requestId: requestIdFor(input, result.decision),
      },
      request: { ...request, sequence: input.sequence },
      result,
      challenge,
    };
  }

  if (!signer) {
    throw new Error("Permit V2 signing is unavailable; execution fails closed");
  }
  const binding = bindingFor(input);
  const signedResult = issueExecutionPermitV2(result, binding, signer);
  const challenge = input.challenge
    ? runChallengeV2(input.challenge, signedResult.permit, binding, signer)
    : null;
  return {
    version: 2,
    dataMode: "SYNTHETIC",
    scenario: publicJudgeScenario.id,
    agent: { id: input.agentId, automated: true },
    transport: {
      protocol: "HTTPS",
      endpoint: "/api/agent-gate",
      keyEndpoint: "/api/permit-keys",
      requestId: requestIdFor(input, signedResult.decision),
    },
    request: input,
    result: signedResult,
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

function runChallengeV1(
  challenge: z.infer<typeof publicAgentChallengeV1Schema>,
  permit: ExecutionPermit | null,
  context: ExecutionGateContext,
): PublicAgentChallengeResult {
  if (!permit) {
    return noPermitChallenge(challenge);
  }

  const candidate = structuredClone(permit);
  let verification: PermitVerificationResult;

  if (challenge === "QUOTE_TAMPER") {
    candidate.body.quoteHash = differentHash(candidate.body.quoteHash);
    candidate.hash = sha256(candidate.body);
    verification = inspectExecutionPermit(
      candidate,
      context,
      context.observedTs,
    );
  } else if (challenge === "RECEIPT_TAMPER") {
    candidate.body.stateReceiptHash = differentHash(
      candidate.body.stateReceiptHash ?? candidate.hash,
    );
    candidate.hash = sha256(candidate.body);
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

  return { challenge, expected: "REJECT", ...verification };
}

function runChallengeV2(
  challenge: PublicAgentChallenge,
  permit: SignedExecutionPermitV2 | null,
  request: PermitV2RequestBinding,
  signer: PermitSigner,
): PublicAgentChallengeResult {
  if (!permit) {
    return noPermitChallenge(challenge);
  }

  const candidate = structuredClone(permit);
  const expected = { ...request };
  const usedNonces = new Set<string>();
  let now = candidate.body.issuedAt;

  if (challenge === "QUOTE_TAMPER") {
    candidate.body.quoteHash = differentHash(candidate.body.quoteHash);
    candidate.hash = sha256(candidate.body);
  } else if (challenge === "RECEIPT_TAMPER") {
    candidate.body.stateReceiptHash = differentHash(
      candidate.body.stateReceiptHash ?? candidate.hash,
    );
    candidate.hash = sha256(candidate.body);
  } else if (challenge === "EXPIRED_REPLAY") {
    now = candidate.body.expiresAt;
  } else if (challenge === "WRONG_AUDIENCE") {
    expected.audience = `${request.audience}-other`;
  } else if (challenge === "UNKNOWN_SIGNING_KEY") {
    candidate.body.kid = "stp_unknown000000";
    candidate.hash = sha256(candidate.body);
  } else {
    usedNonces.add(nonceKey(candidate.body));
  }

  const verification = inspectExecutionPermitV2({
    permit: candidate,
    request: expected,
    keys: publicKeySetFor(signer),
    now,
    usedNonces,
  });
  return { challenge, expected: "REJECT", ...verification };
}

function bindingFor(
  input: PublicAgentHandshakeRequestV2,
): PermitV2RequestBinding {
  return {
    agentId: input.agentId,
    audience: input.audience,
    nonce: input.nonce,
    command: input.command,
    subjectHash: input.subjectHash,
    market: input.market,
    quoteHash: input.quoteHash,
    sequence: input.sequence,
  };
}

function requestIdFor(
  input: PublicAgentHandshakeRequest,
  decision: ExecutionGateDecision,
): string {
  return sha256({
    kind: "STOPPAGE_PUBLIC_AGENT_REQUEST",
    version: input.version,
    input,
    decision,
  });
}

function noPermitChallenge(
  challenge: PublicAgentChallenge,
): PublicAgentChallengeResult {
  return {
    challenge,
    expected: "REJECT",
    valid: false,
    decision: "BLOCK_BINDING_INVALID",
    reason: "No valid permit exists at this checkpoint to challenge.",
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
