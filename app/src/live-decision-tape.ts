export interface LiveDecisionTape {
  version: 1;
  status: "AVAILABLE";
  evidenceType: "RECORDED_BUILDER_ATTESTED_TXLINE_DECISION_TAPE";
  source: "TXLINE_CAPTURE_PROVENANCE_NOT_INDEPENDENTLY_VERIFIED";
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
    status?: "RETIRED";
    validUntil?: number;
  };
  counters: {
    capturedRequests: number;
    blockedRequests: number;
    verifiedPermits: number;
    callbacksAfterBlock: number;
    callbacksWithoutVerifiedPermit: number;
    crossAgentPermitTheftsRejected: number;
  };
  decisions: {
    allowHealthyQuote: number;
    allowCertifiedReopen: number;
    blockedUncertainty: number;
    blockedOther: number;
  };
  sampleProof: {
    decision: "ALLOW_HEALTHY_QUOTE" | "ALLOW_CERTIFIED_REOPEN";
    permit: {
      alg: "Ed25519";
      hash: string;
      signature: string;
      body: {
        kid: string;
        audience: string;
        issuedAt: number;
        expiresAt: number;
      };
    };
    intendedAgent: {
      id: string;
      audience: string;
      verification: "ALLOW";
      callbackInvoked: true;
      callbackInvokedAt: string;
      callbackReceiptHash: string;
    };
    crossAgentAttempt: {
      id: string;
      audience: string;
      verification: string;
      callbackInvoked: false;
      callbackInvokedAt: null;
      callbackReceiptHash: null;
    };
  };
  candidateHash: string;
  approvedAt: string;
  approval: {
    statement: string;
  };
}

const LIVE_TAPE_APPROVAL_PREFIX = "APPROVE STOPPAGE LIVE DECISION TAPE";

export function parseLiveDecisionTape(value: unknown): LiveDecisionTape {
  if (!isRecord(value)) throw new Error("Live decision tape is malformed");
  const counters = requiredRecord(value, "counters");
  const captureModes = requiredRecord(value, "captureModes");
  const contract = requiredRecord(value, "contract");
  const signer = requiredRecord(value, "signer");
  const decisions = requiredRecord(value, "decisions");
  const sampleProof = requiredRecord(value, "sampleProof");
  const permit = requiredRecord(sampleProof, "permit");
  const permitBody = requiredRecord(permit, "body");
  const intendedAgent = requiredRecord(sampleProof, "intendedAgent");
  const crossAgentAttempt = requiredRecord(sampleProof, "crossAgentAttempt");
  const approval = requiredRecord(value, "approval");

  if (
    value.version !== 1 ||
    value.status !== "AVAILABLE" ||
    value.evidenceType !== "RECORDED_BUILDER_ATTESTED_TXLINE_DECISION_TAPE" ||
    value.source !== "TXLINE_CAPTURE_PROVENANCE_NOT_INDEPENDENTLY_VERIFIED" ||
    value.operation !== "BUILDER_OPERATED_CAPTURE" ||
    value.hostingClaim !== "RECORDED_CAPTURE_NOT_HOSTED_UPTIME" ||
    value.timingDisclosure !==
      "PERMIT_ISSUED_AT_IS_ENFORCEMENT_EXECUTION_TIME_NOT_FEED_TIME" ||
    contract.command !== "PUBLISH_QUOTE" ||
    contract.enforcement !==
      "CALLBACK_AFTER_OFFLINE_ED25519_VERIFICATION_ONLY" ||
    signer.alg !== "Ed25519" ||
    permit.alg !== "Ed25519" ||
    intendedAgent.verification !== "ALLOW" ||
    intendedAgent.callbackInvoked !== true ||
    crossAgentAttempt.callbackInvoked !== false ||
    crossAgentAttempt.callbackInvokedAt !== null ||
    !isHash(intendedAgent.callbackReceiptHash) ||
    crossAgentAttempt.callbackReceiptHash !== null ||
    (sampleProof.decision !== "ALLOW_HEALTHY_QUOTE" &&
      sampleProof.decision !== "ALLOW_CERTIFIED_REOPEN") ||
    !isHash(value.candidateHash) ||
    typeof signer.kid !== "string" ||
    signer.kid.length === 0 ||
    approval.statement !==
      `${LIVE_TAPE_APPROVAL_PREFIX} ${signer.kid} ${value.candidateHash}` ||
    !Number.isFinite(Date.parse(asString(value.approvedAt)))
  ) {
    throw new Error("Live decision tape failed contract validation");
  }

  const capturedRequests = asNonNegativeInteger(counters.capturedRequests);
  const blockedRequests = asNonNegativeInteger(counters.blockedRequests);
  const verifiedPermits = asNonNegativeInteger(counters.verifiedPermits);
  const callbacksAfterBlock = asNonNegativeInteger(
    counters.callbacksAfterBlock,
  );
  const callbacksWithoutPermit = asNonNegativeInteger(
    counters.callbacksWithoutVerifiedPermit,
  );
  const theftsRejected = asNonNegativeInteger(
    counters.crossAgentPermitTheftsRejected,
  );
  const liveCaptureCount = asNonNegativeInteger(captureModes.live);
  const replayCaptureCount = asNonNegativeInteger(
    captureModes.privateCaptureReplay,
  );
  const allowHealthyQuote = asNonNegativeInteger(decisions.allowHealthyQuote);
  const allowCertifiedReopen = asNonNegativeInteger(
    decisions.allowCertifiedReopen,
  );
  const blockedUncertainty = asNonNegativeInteger(decisions.blockedUncertainty);
  const blockedOther = asNonNegativeInteger(decisions.blockedOther);
  const permitIssuedAt = asNonNegativeInteger(permitBody.issuedAt);
  const permitExpiresAt = asNonNegativeInteger(permitBody.expiresAt);
  const signerStatus = signer.status ?? "ACTIVE";
  const callbackInvokedAt = Date.parse(
    asString(intendedAgent.callbackInvokedAt),
  );
  if (
    capturedRequests < 1 ||
    blockedRequests < 1 ||
    verifiedPermits < 1 ||
    theftsRejected < 1 ||
    callbacksAfterBlock !== 0 ||
    callbacksWithoutPermit !== 0 ||
    allowCertifiedReopen < 1 ||
    sampleProof.decision !== "ALLOW_CERTIFIED_REOPEN" ||
    (signer.status !== undefined && signer.status !== "RETIRED") ||
    (signer.status === undefined && "validUntil" in signer) ||
    (signerStatus === "RETIRED" &&
      (!Number.isInteger(signer.validUntil) ||
        permitExpiresAt > (signer.validUntil as number))) ||
    (signerStatus !== "ACTIVE" && signerStatus !== "RETIRED") ||
    !Number.isFinite(callbackInvokedAt) ||
    callbackInvokedAt < permitIssuedAt ||
    callbackInvokedAt >= permitExpiresAt ||
    liveCaptureCount + replayCaptureCount !== capturedRequests ||
    allowHealthyQuote +
      allowCertifiedReopen +
      blockedUncertainty +
      blockedOther !==
      capturedRequests
  ) {
    throw new Error("Live decision tape invariants failed");
  }

  for (const field of [
    value.dataBoundary,
    value.timingDisclosure,
    contract.intendedAgent,
    contract.adversaryAgent,
    signer.issuer,
    signer.kid,
    signer.publicKey,
    permit.hash,
    permit.signature,
    permitBody.kid,
    permitBody.audience,
    intendedAgent.id,
    intendedAgent.audience,
    crossAgentAttempt.id,
    crossAgentAttempt.audience,
    crossAgentAttempt.verification,
  ]) {
    asString(field);
  }
  return value as unknown as LiveDecisionTape;
}

function requiredRecord(value: Record<string, unknown>, key: string) {
  const nested = value[key];
  if (!isRecord(nested)) throw new Error(`Missing live tape field ${key}`);
  return nested;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("Live decision tape contains an invalid string");
  }
  return value;
}

function asNonNegativeInteger(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new Error("Live decision tape counters are malformed");
  }
  return value as number;
}

function isHash(value: unknown) {
  return typeof value === "string" && /^0x[0-9a-f]{64}$/.test(value);
}
