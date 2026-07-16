import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

import { sha256 } from "../domain/canonical.js";
import { liveAgentRequestV2Schema } from "../execution-gate/live-agent-gate.js";
import {
  inspectExecutionPermitV2,
  type PermitVerificationKeySet,
  type SignedExecutionPermitV2,
} from "../execution-gate/permit-v2.js";
import type {
  LiveDecisionTapeCounters,
  LiveDecisionTapeRecord,
  LiveTapeVenueAction,
} from "../live/live-decision-tape.js";

export const LIVE_TAPE_APPROVAL_PREFIX = "APPROVE STOPPAGE LIVE DECISION TAPE";
export const LIVE_TAPE_DATA_BOUNDARY =
  "Sanitized derived enforcement results only. No raw fixture IDs, quote vectors, feed records, source timestamps, API tokens, wallet keys, or venue credentials.";

export interface PublicLiveDecisionTapePayload {
  version: 1;
  status: "AVAILABLE";
  evidenceType: "RECORDED_TXLINE_DECISION_TAPE";
  network: "solana-mainnet";
  source: "TXLINE_WORLD_CUP_SERVICE_LEVEL_12";
  operation: "BUILDER_OPERATED_CAPTURE";
  hostingClaim: "RECORDED_CAPTURE_NOT_HOSTED_UPTIME";
  dataBoundary: string;
  timingDisclosure: "PERMIT_ISSUED_AT_IS_ENFORCEMENT_EXECUTION_TIME_NOT_FEED_TIME";
  captureModes: {
    live: number;
    privateCaptureReplay: number;
  };
  contract: {
    command: "PUBLISH_QUOTE";
    enforcement: "CALLBACK_AFTER_OFFLINE_ED25519_VERIFICATION_ONLY";
    intendedAgent: string;
    adversaryAgent: string;
  };
  signer: {
    issuer: string;
    kid: string;
    alg: "Ed25519";
    publicKey: string;
  };
  counters: LiveDecisionTapeCounters;
  decisions: {
    allowHealthyQuote: number;
    allowCertifiedReopen: number;
    blockedUncertainty: number;
    blockedOther: number;
  };
  sampleProof: {
    decision: "ALLOW_HEALTHY_QUOTE" | "ALLOW_CERTIFIED_REOPEN";
    permit: SignedExecutionPermitV2;
    intendedAgent: {
      id: string;
      audience: string;
      verification: "ALLOW";
      callbackInvoked: true;
      callbackReceiptHash: string;
    };
    crossAgentAttempt: {
      id: string;
      audience: string;
      verification: string;
      callbackInvoked: false;
      callbackReceiptHash: null;
    };
  };
}

export interface PublicLiveDecisionTape extends PublicLiveDecisionTapePayload {
  candidateHash: string;
  approvedAt: string;
  approval: {
    statement: string;
  };
}

export interface LiveDecisionTapeCandidate {
  candidateHash: string;
  requiredApproval: string;
  payload: PublicLiveDecisionTapePayload;
}

export function buildLiveDecisionTapeCandidate(
  records: readonly LiveDecisionTapeRecord[],
  keys: PermitVerificationKeySet,
): LiveDecisionTapeCandidate {
  const validated = records.map((record) => validateRecord(record, keys));
  const counters = aggregateCounters(validated);
  const decisions = aggregateDecisions(validated);
  if (
    counters.capturedRequests < 1 ||
    counters.blockedRequests < 1 ||
    counters.verifiedPermits < 1 ||
    counters.crossAgentPermitTheftsRejected < 1
  ) {
    throw new Error(
      "The tape must contain a captured request, uncertainty block, verified permit, and rejected cross-agent theft",
    );
  }
  if (decisions.allowCertifiedReopen < 1) {
    throw new Error("The tape must contain a signed Certified Reopen request");
  }
  if (
    counters.callbacksAfterBlock !== 0 ||
    counters.callbacksWithoutVerifiedPermit !== 0
  ) {
    throw new Error("The live decision tape violates its callback invariants");
  }

  const sample = validated.find(
    (record) =>
      record.agentA.gateDecision === "ALLOW_CERTIFIED_REOPEN" &&
      record.agentA.signedPermit &&
      record.agentA.verification.valid &&
      isHash(record.agentA.callbackReceiptHash) &&
      record.agentB.intent &&
      record.agentB.verification &&
      !record.agentB.verification.valid,
  );
  if (
    !sample?.agentA.signedPermit ||
    !sample.agentB.intent ||
    !sample.agentB.verification
  ) {
    throw new Error("The tape has no independently verifiable permit sample");
  }
  const activeKey = keys.keys.find(
    (key) =>
      key.kid === sample.signer.kid &&
      key.alg === "Ed25519" &&
      key.status === "ACTIVE",
  );
  if (!activeKey || keys.issuer !== sample.signer.issuer) {
    throw new Error("The tape signer is absent from the active public key set");
  }

  const intendedAgent = sample.agentA.intent.agentId;
  const adversaryAgent = sample.agentB.intent.agentId;
  const payload: PublicLiveDecisionTapePayload = {
    version: 1,
    status: "AVAILABLE",
    evidenceType: "RECORDED_TXLINE_DECISION_TAPE",
    network: "solana-mainnet",
    source: "TXLINE_WORLD_CUP_SERVICE_LEVEL_12",
    operation: "BUILDER_OPERATED_CAPTURE",
    hostingClaim: "RECORDED_CAPTURE_NOT_HOSTED_UPTIME",
    dataBoundary: LIVE_TAPE_DATA_BOUNDARY,
    timingDisclosure:
      "PERMIT_ISSUED_AT_IS_ENFORCEMENT_EXECUTION_TIME_NOT_FEED_TIME",
    captureModes: {
      live: validated.filter((record) => record.source === "TXLINE_LIVE_QUOTE")
        .length,
      privateCaptureReplay: validated.filter(
        (record) => record.source === "TXLINE_CAPTURE_REPLAY",
      ).length,
    },
    contract: {
      command: "PUBLISH_QUOTE",
      enforcement: "CALLBACK_AFTER_OFFLINE_ED25519_VERIFICATION_ONLY",
      intendedAgent,
      adversaryAgent,
    },
    signer: {
      issuer: keys.issuer,
      kid: activeKey.kid,
      alg: activeKey.alg,
      publicKey: activeKey.publicKey,
    },
    counters,
    decisions,
    sampleProof: {
      decision: sample.agentA.gateDecision as
        "ALLOW_HEALTHY_QUOTE" | "ALLOW_CERTIFIED_REOPEN",
      permit: structuredClone(sample.agentA.signedPermit),
      intendedAgent: {
        id: intendedAgent,
        audience: sample.agentA.intent.audience,
        verification: "ALLOW",
        callbackInvoked: true,
        callbackReceiptHash: sample.agentA.callbackReceiptHash!,
      },
      crossAgentAttempt: {
        id: adversaryAgent,
        audience: sample.agentB.intent.audience,
        verification: sample.agentB.verification.decision,
        callbackInvoked: false,
        callbackReceiptHash: null,
      },
    },
  };
  assertLiveTapePublicBoundary(payload);
  const candidateHash = sha256(payload);
  return {
    candidateHash,
    requiredApproval: `${LIVE_TAPE_APPROVAL_PREFIX} ${activeKey.kid} ${candidateHash}`,
    payload,
  };
}

export function buildApprovedLiveDecisionTape({
  candidate,
  approvalStatement,
  approvedAt,
}: {
  candidate: LiveDecisionTapeCandidate;
  approvalStatement: string;
  approvedAt: string;
}): PublicLiveDecisionTape {
  validateCandidate(candidate);
  if (approvalStatement !== candidate.requiredApproval) {
    throw new Error(
      `Human approval must exactly equal: ${candidate.requiredApproval}`,
    );
  }
  if (!Number.isFinite(Date.parse(approvedAt))) {
    throw new Error("approvedAt must be a valid timestamp");
  }
  return {
    ...candidate.payload,
    candidateHash: candidate.candidateHash,
    approvedAt,
    approval: { statement: approvalStatement },
  };
}

export async function loadLatestLiveDecisionTapeCandidate(
  dataRoot = "data/private",
): Promise<LiveDecisionTapeCandidate | null> {
  const files = await readdir(resolve(dataRoot)).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  });
  for (const name of files
    .filter(
      (file) =>
        file.startsWith("live-decision-tape-candidate-") &&
        file.endsWith(".json"),
    )
    .sort()
    .reverse()) {
    const candidate = (await safeParseJson(
      resolve(dataRoot, name),
    )) as LiveDecisionTapeCandidate | null;
    try {
      if (candidate) validateCandidate(candidate);
      if (candidate) return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

export async function loadPublicLiveDecisionTape(
  dataRoot = "data/public",
): Promise<PublicLiveDecisionTape | null> {
  const tape = (await safeParseJson(
    resolve(dataRoot, "live-decision-tape.json"),
  )) as PublicLiveDecisionTape | null;
  if (!tape) return null;
  try {
    const payload = publicPayload(tape);
    const candidateHash = sha256(payload);
    const requiredApproval = `${LIVE_TAPE_APPROVAL_PREFIX} ${payload.signer.kid} ${candidateHash}`;
    validateCandidate({
      payload,
      candidateHash: tape.candidateHash,
      requiredApproval,
    });
    if (
      tape.candidateHash !== candidateHash ||
      tape.approval?.statement !== requiredApproval ||
      !Number.isFinite(Date.parse(tape.approvedAt))
    ) {
      return null;
    }
    assertLiveTapePublicBoundary(tape);
    return tape;
  } catch {
    return null;
  }
}

export function assertLiveTapePublicBoundary(value: unknown) {
  const serialized = JSON.stringify(value);
  for (const forbidden of [
    '"fixtureId"',
    '"probabilities"',
    '"payload"',
    '"sourceTs"',
    '"receivedTs"',
    '"observedTs"',
    '"privateCaptureReceivedAt"',
    '"eventId"',
    '"messageId"',
    '"apiToken"',
    '"privateKey"',
    '"secretKey"',
    '"venueCredentials"',
  ]) {
    if (serialized.includes(forbidden)) {
      throw new Error(`Public live decision tape contains ${forbidden}`);
    }
  }
}

function validateRecord(
  record: LiveDecisionTapeRecord,
  keys: PermitVerificationKeySet,
): LiveDecisionTapeRecord {
  const recordedAt = Date.parse(record.recordedAt);
  if (
    record.version !== 1 ||
    record.type !== "LIVE_DECISION_TAPE_RECORD" ||
    (record.source !== "TXLINE_LIVE_QUOTE" &&
      record.source !== "TXLINE_CAPTURE_REPLAY") ||
    !Number.isFinite(recordedAt) ||
    !liveAgentRequestV2Schema.safeParse(record.agentA.intent).success ||
    (record.invariants.callbacksAfterBlock !== 0 &&
      record.invariants.callbacksAfterBlock !== 1) ||
    (record.invariants.callbacksWithoutVerifiedPermit !== 0 &&
      record.invariants.callbacksWithoutVerifiedPermit !== 1)
  ) {
    throw new Error("A private live decision-tape record is malformed");
  }
  if (
    (record.source === "TXLINE_LIVE_QUOTE" &&
      (record.timing.permitIssuedAtBasis !== "LIVE_EVALUATION_CLOCK" ||
        record.timing.privateCaptureReceivedAt !== null)) ||
    (record.source === "TXLINE_CAPTURE_REPLAY" &&
      (record.timing.permitIssuedAtBasis !== "REPLAY_EXECUTION_CLOCK" ||
        !Number.isInteger(record.timing.privateCaptureReceivedAt) ||
        record.timing.privateCaptureReceivedAt === recordedAt))
  ) {
    throw new Error("A private live decision-tape record leaks source timing");
  }

  const allow = record.agentA.gateDecision.startsWith("ALLOW_");
  const block = record.agentA.gateDecision.startsWith("BLOCK_");
  if (!allow && !block) throw new Error("Unknown live tape gate decision");

  if (allow) {
    const permit = record.agentA.signedPermit;
    if (
      !permit ||
      !record.agentA.permitIssued ||
      !record.agentA.callbackInvoked ||
      !isHash(record.agentA.callbackReceiptHash) ||
      !record.agentA.verification.valid ||
      permit.body.issuedAt !== recordedAt
    ) {
      throw new Error("An allowed tape record lacks verified enforcement");
    }
    const intended = inspectExecutionPermitV2({
      permit,
      request: record.agentA.intent,
      keys,
      now: permit.body.issuedAt,
    });
    if (!intended.valid) {
      throw new Error("The recorded intended-agent permit is not verifiable");
    }
    if (
      record.agentA.callbackReceiptHash !==
      sha256(
        venueActionForEvidence({
          agentId: record.agentA.intent.agentId,
          audience: record.agentA.intent.audience,
          subjectHash: record.agentA.intent.subjectHash,
          quoteHash: record.agentA.intent.quoteHash,
          sequence: record.agentA.intent.sequence,
          permitHash: permit.hash,
          invokedAt: record.recordedAt,
        }),
      )
    ) {
      throw new Error("The recorded venue callback receipt is not bound");
    }
    if (
      !record.agentB.attemptedPermitTheft ||
      !record.agentB.intent ||
      !record.agentB.verification ||
      record.agentB.verification.valid ||
      record.agentB.callbackInvoked ||
      record.agentB.callbackReceiptHash !== null
    ) {
      throw new Error("An allowed tape record lacks rejected permit theft");
    }
    const stolen = inspectExecutionPermitV2({
      permit,
      request: record.agentB.intent,
      keys,
      now: permit.body.issuedAt,
    });
    if (
      stolen.valid ||
      stolen.decision !== record.agentB.verification.decision
    ) {
      throw new Error("The recorded cross-agent rejection is not reproducible");
    }
  } else if (
    record.agentA.signedPermit ||
    record.agentA.permitIssued ||
    record.agentA.callbackInvoked ||
    record.agentA.callbackReceiptHash !== null ||
    record.agentB.attemptedPermitTheft ||
    record.agentB.callbackInvoked ||
    record.agentB.callbackReceiptHash !== null
  ) {
    throw new Error("A blocked tape record invoked or delegated a callback");
  }

  if (
    record.invariants.callbacksAfterBlock !== 0 ||
    record.invariants.callbacksWithoutVerifiedPermit !== 0
  ) {
    throw new Error("A private tape record violates callback invariants");
  }
  if (
    record.signer.issuer !== keys.issuer ||
    !keys.keys.some(
      (key) => key.kid === record.signer.kid && key.status === "ACTIVE",
    )
  ) {
    throw new Error("A private tape record has an unknown signer");
  }
  return structuredClone(record);
}

function aggregateCounters(
  records: readonly LiveDecisionTapeRecord[],
): LiveDecisionTapeCounters {
  return records.reduce<LiveDecisionTapeCounters>(
    (counters, record) => {
      counters.capturedRequests += 1;
      if (record.agentA.gateDecision.startsWith("BLOCK_")) {
        counters.blockedRequests += 1;
      }
      if (record.agentA.verification.valid) counters.verifiedPermits += 1;
      counters.callbacksAfterBlock += record.invariants.callbacksAfterBlock;
      counters.callbacksWithoutVerifiedPermit +=
        record.invariants.callbacksWithoutVerifiedPermit;
      if (
        record.agentB.attemptedPermitTheft &&
        record.agentB.verification &&
        !record.agentB.verification.valid &&
        !record.agentB.callbackInvoked
      ) {
        counters.crossAgentPermitTheftsRejected += 1;
      }
      return counters;
    },
    {
      capturedRequests: 0,
      blockedRequests: 0,
      verifiedPermits: 0,
      callbacksAfterBlock: 0,
      callbacksWithoutVerifiedPermit: 0,
      crossAgentPermitTheftsRejected: 0,
    },
  );
}

function aggregateDecisions(records: readonly LiveDecisionTapeRecord[]) {
  return records.reduce(
    (counts, record) => {
      if (record.agentA.gateDecision === "ALLOW_HEALTHY_QUOTE") {
        counts.allowHealthyQuote += 1;
      } else if (record.agentA.gateDecision === "ALLOW_CERTIFIED_REOPEN") {
        counts.allowCertifiedReopen += 1;
      } else if (
        record.agentA.gateDecision === "BLOCK_UNRESOLVED_INCIDENT" ||
        record.agentA.gateDecision === "BLOCK_INVALIDATED_BRANCH"
      ) {
        counts.blockedUncertainty += 1;
      } else {
        counts.blockedOther += 1;
      }
      return counts;
    },
    {
      allowHealthyQuote: 0,
      allowCertifiedReopen: 0,
      blockedUncertainty: 0,
      blockedOther: 0,
    },
  );
}

function validateCandidate(candidate: LiveDecisionTapeCandidate) {
  assertLiveTapePublicBoundary(candidate.payload);
  assertPublicSample(candidate.payload);
  const hash = sha256(candidate.payload);
  if (
    candidate.candidateHash !== hash ||
    candidate.requiredApproval !==
      `${LIVE_TAPE_APPROVAL_PREFIX} ${candidate.payload.signer.kid} ${hash}` ||
    candidate.payload.status !== "AVAILABLE" ||
    candidate.payload.evidenceType !== "RECORDED_TXLINE_DECISION_TAPE" ||
    candidate.payload.timingDisclosure !==
      "PERMIT_ISSUED_AT_IS_ENFORCEMENT_EXECUTION_TIME_NOT_FEED_TIME" ||
    candidate.payload.counters.capturedRequests < 1 ||
    candidate.payload.counters.blockedRequests < 1 ||
    candidate.payload.counters.verifiedPermits < 1 ||
    candidate.payload.counters.crossAgentPermitTheftsRejected < 1 ||
    candidate.payload.counters.callbacksAfterBlock !== 0 ||
    candidate.payload.counters.callbacksWithoutVerifiedPermit !== 0 ||
    candidate.payload.decisions.allowCertifiedReopen < 1 ||
    candidate.payload.sampleProof.decision !== "ALLOW_CERTIFIED_REOPEN" ||
    candidate.payload.decisions.allowHealthyQuote +
      candidate.payload.decisions.allowCertifiedReopen +
      candidate.payload.decisions.blockedUncertainty +
      candidate.payload.decisions.blockedOther !==
      candidate.payload.counters.capturedRequests ||
    candidate.payload.captureModes.live +
      candidate.payload.captureModes.privateCaptureReplay !==
      candidate.payload.counters.capturedRequests
  ) {
    throw new Error("The live decision-tape candidate is invalid");
  }
}

function assertPublicSample(payload: PublicLiveDecisionTapePayload) {
  const permit = payload.sampleProof.permit;
  const intendedRequest = {
    agentId: payload.sampleProof.intendedAgent.id,
    audience: payload.sampleProof.intendedAgent.audience,
    nonce: permit.body.nonce,
    command: permit.body.command,
    subjectHash: permit.body.subjectHash,
    market: permit.body.market,
    quoteHash: permit.body.quoteHash,
    sequence: permit.body.sequence,
  };
  const keys: PermitVerificationKeySet = {
    version: 1,
    issuer: payload.signer.issuer,
    keys: [
      {
        kid: payload.signer.kid,
        alg: payload.signer.alg,
        use: "sig",
        publicKey: payload.signer.publicKey,
        status: "ACTIVE",
      },
    ],
  };
  const intended = inspectExecutionPermitV2({
    permit,
    request: intendedRequest,
    keys,
    now: permit.body.issuedAt,
  });
  const stolen = inspectExecutionPermitV2({
    permit,
    request: {
      ...intendedRequest,
      agentId: payload.sampleProof.crossAgentAttempt.id,
      audience: payload.sampleProof.crossAgentAttempt.audience,
    },
    keys,
    now: permit.body.issuedAt,
  });
  if (
    !intended.valid ||
    stolen.valid ||
    stolen.decision !== payload.sampleProof.crossAgentAttempt.verification ||
    permit.body.kid !== payload.signer.kid ||
    permit.body.decision !== payload.sampleProof.decision ||
    payload.sampleProof.intendedAgent.verification !== "ALLOW" ||
    !payload.sampleProof.intendedAgent.callbackInvoked ||
    !isHash(payload.sampleProof.intendedAgent.callbackReceiptHash) ||
    payload.sampleProof.intendedAgent.callbackReceiptHash !==
      sha256(
        venueActionForEvidence({
          agentId: payload.sampleProof.intendedAgent.id,
          audience: payload.sampleProof.intendedAgent.audience,
          subjectHash: permit.body.subjectHash,
          quoteHash: permit.body.quoteHash,
          sequence: permit.body.sequence,
          permitHash: permit.hash,
          invokedAt: new Date(permit.body.issuedAt).toISOString(),
        }),
      ) ||
    payload.sampleProof.crossAgentAttempt.callbackInvoked ||
    payload.sampleProof.crossAgentAttempt.callbackReceiptHash !== null
  ) {
    throw new Error("The public signed permit sample is invalid");
  }
}

function publicPayload(
  tape: PublicLiveDecisionTape,
): PublicLiveDecisionTapePayload {
  return {
    version: tape.version,
    status: tape.status,
    evidenceType: tape.evidenceType,
    network: tape.network,
    source: tape.source,
    operation: tape.operation,
    hostingClaim: tape.hostingClaim,
    dataBoundary: tape.dataBoundary,
    timingDisclosure: tape.timingDisclosure,
    captureModes: tape.captureModes,
    contract: tape.contract,
    signer: tape.signer,
    counters: tape.counters,
    decisions: tape.decisions,
    sampleProof: tape.sampleProof,
  };
}

async function safeParseJson(path: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return null;
  }
}

function isHash(value: unknown): value is string {
  return typeof value === "string" && /^0x[0-9a-f]{64}$/.test(value);
}

function venueActionForEvidence({
  agentId,
  audience,
  subjectHash,
  quoteHash,
  sequence,
  permitHash,
  invokedAt,
}: Omit<
  LiveTapeVenueAction,
  "version" | "type" | "command"
>): LiveTapeVenueAction {
  return {
    version: 1,
    type: "SIMULATED_VENUE_PUBLISH",
    invokedAt,
    agentId,
    audience,
    command: "PUBLISH_QUOTE",
    subjectHash,
    quoteHash,
    sequence,
    permitHash,
  };
}
