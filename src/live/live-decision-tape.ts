import {
  verifyPermit,
  type ExecutionIntent,
  type PermitVerificationResult,
} from "@stoppage/sdk";

import { sha256 } from "../domain/canonical.js";
import { hashQuote } from "../execution-gate/execution-gate.js";
import {
  evaluateLiveAgentRequest,
  type LiveAgentRequestV2,
} from "../execution-gate/live-agent-gate.js";
import {
  executionContextFromPersisted,
  type PersistedExecutionGateContext,
} from "../execution-gate/live-context.js";
import {
  publicKeySetFor,
  type PermitSigner,
  type PermitVerificationKeySet,
  type SignedExecutionPermitV2,
} from "../execution-gate/permit-v2.js";
import { appendPrivateCapture } from "../private/capture-store.js";
import { writeRuntimeState } from "../private/runtime-store.js";

export const LIVE_DECISION_TAPE_PRIVATE_FILE = "live-decision-tape.jsonl";
export const LIVE_DECISION_TAPE_STATUS_FILE = "live-decision-tape-status.json";
export const LIVE_DECISION_TAPE_VENUE_ACTIONS_FILE =
  "live-decision-tape-venue-actions.jsonl";
export const LIVE_TAPE_AGENT_A = "stoppage-reference-agent";
export const LIVE_TAPE_AGENT_A_AUDIENCE = "venue:stoppage-reference-agent";
export const LIVE_TAPE_AGENT_B = "cross-agent-adversary";
export const LIVE_TAPE_AGENT_B_AUDIENCE = "venue:cross-agent-adversary";
export const LIVE_TAPE_QUEUE_CAPACITY = 64;

export interface LiveTapeVenueAction {
  version: 1;
  type: "SIMULATED_VENUE_PUBLISH";
  invokedAt: string;
  agentId: string;
  audience: string;
  command: "PUBLISH_QUOTE";
  subjectHash: string;
  quoteHash: string;
  sequence: number;
  permitHash: string;
}

export interface LiveTapeVenueReceipt {
  version: 1;
  type: "SIMULATED_VENUE_RECEIPT";
  actionHash: string;
}

export type LiveTapeVenueCallback = (
  action: LiveTapeVenueAction,
) => LiveTapeVenueReceipt | Promise<LiveTapeVenueReceipt>;

export interface LiveTapeNonceClaim {
  key: string;
  expiresAt: number;
  now: number;
}

export type LiveTapeNonceClaimer = (
  claim: LiveTapeNonceClaim,
) => boolean | Promise<boolean>;

export interface LiveDecisionTapeRecord {
  version: 1;
  type: "LIVE_DECISION_TAPE_RECORD";
  recordedAt: string;
  source: "TXLINE_LIVE_QUOTE" | "TXLINE_CAPTURE_REPLAY";
  evaluationPath: "LIVE_GATE_CORE";
  timing:
    | {
        permitIssuedAtBasis: "LIVE_EVALUATION_CLOCK";
        privateCaptureReceivedAt: null;
      }
    | {
        permitIssuedAtBasis: "REPLAY_EXECUTION_CLOCK";
        privateCaptureReceivedAt: number;
      };
  signer: {
    issuer: string;
    kid: string;
  };
  agentA: {
    intent: LiveAgentRequestV2;
    gateDecision: string;
    gateReason: string;
    permitIssued: boolean;
    permitHash: string | null;
    signedPermit: SignedExecutionPermitV2 | null;
    verification: PermitVerificationResult;
    callbackInvoked: boolean;
    callbackReceiptHash: string | null;
  };
  agentB: {
    attemptedPermitTheft: boolean;
    intent: ExecutionIntent | null;
    verification: PermitVerificationResult | null;
    callbackInvoked: boolean;
    callbackReceiptHash: string | null;
  };
  invariants: {
    callbacksAfterBlock: 0 | 1;
    callbacksWithoutVerifiedPermit: 0 | 1;
  };
}

export interface LiveDecisionTapeCounters {
  capturedRequests: number;
  blockedRequests: number;
  verifiedPermits: number;
  callbacksAfterBlock: number;
  callbacksWithoutVerifiedPermit: number;
  crossAgentPermitTheftsRejected: number;
}

export interface LiveDecisionTapeStatus {
  version: 1;
  updatedAt: string;
  signerKid: string;
  counters: LiveDecisionTapeCounters;
}

interface LiveDecisionTapeRecorderOptions {
  signer: PermitSigner;
  source?: LiveDecisionTapeRecord["source"];
  appendRecord?: (record: LiveDecisionTapeRecord) => Promise<unknown>;
  writeStatus?: (status: LiveDecisionTapeStatus) => Promise<unknown>;
  claimNonce: LiveTapeNonceClaimer;
  invokeAgentA: LiveTapeVenueCallback;
  invokeAgentB: LiveTapeVenueCallback;
}

export class LiveDecisionTapeRecorder {
  readonly #signer: PermitSigner;
  readonly #keys: PermitVerificationKeySet;
  readonly #source: LiveDecisionTapeRecord["source"];
  readonly #appendRecord: (record: LiveDecisionTapeRecord) => Promise<unknown>;
  readonly #writeStatus: (status: LiveDecisionTapeStatus) => Promise<unknown>;
  readonly #claimNonce: LiveTapeNonceClaimer;
  readonly #invokeAgentA: LiveTapeVenueCallback;
  readonly #invokeAgentB: LiveTapeVenueCallback;
  readonly #counters: LiveDecisionTapeCounters = emptyCounters();

  constructor(options: LiveDecisionTapeRecorderOptions) {
    this.#signer = options.signer;
    this.#keys = publicKeySetFor(options.signer);
    this.#source = options.source ?? "TXLINE_LIVE_QUOTE";
    this.#appendRecord =
      options.appendRecord ??
      ((record) =>
        appendPrivateCapture(LIVE_DECISION_TAPE_PRIVATE_FILE, record));
    this.#writeStatus =
      options.writeStatus ??
      ((status) => writeRuntimeState(LIVE_DECISION_TAPE_STATUS_FILE, status));
    this.#claimNonce = options.claimNonce;
    this.#invokeAgentA = options.invokeAgentA;
    this.#invokeAgentB = options.invokeAgentB;
  }

  async record(
    persisted: PersistedExecutionGateContext,
    now = Date.now(),
    privateCaptureReceivedAt?: number,
  ): Promise<LiveDecisionTapeRecord> {
    const timing = timingFor(this.#source, now, privateCaptureReceivedAt);
    const quote = persisted.state.quote;
    if (!quote) {
      throw new Error("A live decision-tape request requires a current quote");
    }

    const intent: LiveAgentRequestV2 = {
      version: 2,
      agentId: LIVE_TAPE_AGENT_A,
      audience: LIVE_TAPE_AGENT_A_AUDIENCE,
      nonce: nonceFor(persisted),
      command: "PUBLISH_QUOTE",
      sequence: persisted.sequence,
      subjectHash: persisted.subjectHash,
      market: "1X2",
      quoteHash: hashQuote(quote),
    };
    const response = evaluateLiveAgentRequest(
      intent,
      executionContextFromPersisted(persisted, now),
      this.#signer,
      now,
    );

    let agentAVerification: PermitVerificationResult = {
      valid: false,
      decision: "BLOCK_GATE_DECISION",
      reason: response.result.reason,
    };
    let agentACallbackInvoked = false;
    let agentACallbackReceiptHash: string | null = null;
    let agentBIntent: ExecutionIntent | null = null;
    let agentBVerification: PermitVerificationResult | null = null;
    let agentBCallbackInvoked = false;
    let agentBCallbackReceiptHash: string | null = null;

    if (
      response.result.decision.startsWith("ALLOW_") &&
      response.result.permit
    ) {
      agentAVerification = verifyPermit({
        permit: response.result.permit,
        intent,
        keys: this.#keys,
        now,
      });
      if (agentAVerification.valid) {
        const claimed = await this.#claimNonce({
          key: permitNonceKey(response.result.permit),
          expiresAt: response.result.permit.body.expiresAt,
          now,
        });
        if (!claimed) {
          agentAVerification = {
            valid: false,
            decision: "BLOCK_NONCE_REPLAY",
            reason: "The one-use request nonce has already been consumed.",
          };
        } else {
          const action = venueActionFor(intent, response.result.permit, now);
          const receipt = await this.#invokeAgentA(action);
          assertVenueReceipt(receipt, action);
          agentACallbackInvoked = true;
          agentACallbackReceiptHash = receipt.actionHash;
        }
      }

      agentBIntent = {
        ...intent,
        agentId: LIVE_TAPE_AGENT_B,
        audience: LIVE_TAPE_AGENT_B_AUDIENCE,
      };
      agentBVerification = verifyPermit({
        permit: response.result.permit,
        intent: agentBIntent,
        keys: this.#keys,
        now,
      });
      if (agentBVerification.valid) {
        const action = venueActionFor(
          agentBIntent,
          response.result.permit,
          now,
        );
        const receipt = await this.#invokeAgentB(action);
        assertVenueReceipt(receipt, action);
        agentBCallbackInvoked = true;
        agentBCallbackReceiptHash = receipt.actionHash;
      }
    }

    const isBlocked = response.result.decision.startsWith("BLOCK_");
    const record: LiveDecisionTapeRecord = {
      version: 1,
      type: "LIVE_DECISION_TAPE_RECORD",
      recordedAt: new Date(now).toISOString(),
      source: this.#source,
      evaluationPath: "LIVE_GATE_CORE",
      timing,
      signer: {
        issuer: this.#signer.issuer,
        kid: this.#signer.kid,
      },
      agentA: {
        intent,
        gateDecision: response.result.decision,
        gateReason: response.result.reason,
        permitIssued: response.result.permit !== null,
        permitHash: response.result.permit?.hash ?? null,
        signedPermit: response.result.permit,
        verification: agentAVerification,
        callbackInvoked: agentACallbackInvoked,
        callbackReceiptHash: agentACallbackReceiptHash,
      },
      agentB: {
        attemptedPermitTheft: agentBIntent !== null,
        intent: agentBIntent,
        verification: agentBVerification,
        callbackInvoked: agentBCallbackInvoked,
        callbackReceiptHash: agentBCallbackReceiptHash,
      },
      invariants: {
        callbacksAfterBlock:
          isBlocked && agentACallbackInvoked ? (1 as const) : (0 as const),
        callbacksWithoutVerifiedPermit:
          (agentACallbackInvoked && !agentAVerification.valid) ||
          (agentBCallbackInvoked && !agentBVerification?.valid)
            ? (1 as const)
            : (0 as const),
      },
    };

    updateCounters(this.#counters, record);
    await this.#appendRecord(record);
    await this.#writeStatus({
      version: 1,
      updatedAt: record.recordedAt,
      signerKid: this.#signer.kid,
      counters: { ...this.#counters },
    });
    return record;
  }
}

export interface LiveDecisionTapeFailure {
  version: 1;
  type: "LIVE_DECISION_TAPE_FAILURE";
  failedAt: string;
  failureCount: number;
  reason: "RECORDER_FAILURE" | "QUEUE_OVERFLOW";
  errorName: string;
  queue: {
    pending: number;
    limit: number;
    dropped: number;
  };
}

interface LiveDecisionTapeQueueOptions {
  recorder: Pick<LiveDecisionTapeRecorder, "record">;
  reportFailure: (failure: LiveDecisionTapeFailure) => Promise<unknown>;
  maxPending?: number;
}

export class LiveDecisionTapeQueue {
  readonly #recorder: Pick<LiveDecisionTapeRecorder, "record">;
  readonly #reportFailure: (
    failure: LiveDecisionTapeFailure,
  ) => Promise<unknown>;
  readonly #maxPending: number;
  #pending: Promise<void> = Promise.resolve();
  #diagnostic: Promise<void> | null = null;
  #diagnosticDirty = false;
  #lastFailure: Omit<
    LiveDecisionTapeFailure,
    "failedAt" | "failureCount"
  > | null = null;
  #pendingCount = 0;
  #failureCount = 0;
  #droppedCount = 0;

  constructor(options: LiveDecisionTapeQueueOptions) {
    this.#recorder = options.recorder;
    this.#reportFailure = options.reportFailure;
    this.#maxPending = options.maxPending ?? LIVE_TAPE_QUEUE_CAPACITY;
    if (!Number.isInteger(this.#maxPending) || this.#maxPending < 1) {
      throw new Error("Live decision-tape queue capacity must be positive");
    }
  }

  enqueue(context: PersistedExecutionGateContext): boolean {
    if (this.#pendingCount >= this.#maxPending) {
      this.#droppedCount += 1;
      this.#recordFailure("QUEUE_OVERFLOW", "TapeQueueOverflow");
      return false;
    }

    let snapshot: PersistedExecutionGateContext;
    try {
      snapshot = structuredClone(context);
    } catch (error) {
      this.#recordFailure("RECORDER_FAILURE", safeErrorName(error));
      return false;
    }

    this.#pendingCount += 1;
    const operation = this.#pending.then(async () => {
      await this.#recorder.record(snapshot);
    });
    this.#pending = operation
      .catch((error: unknown) => {
        this.#recordFailure("RECORDER_FAILURE", safeErrorName(error));
      })
      .finally(() => {
        this.#pendingCount -= 1;
      });
    return true;
  }

  async drain(): Promise<void> {
    await this.#pending;
    while (this.#diagnostic) await this.#diagnostic;
  }

  #recordFailure(reason: LiveDecisionTapeFailure["reason"], errorName: string) {
    this.#failureCount += 1;
    this.#lastFailure = {
      version: 1,
      type: "LIVE_DECISION_TAPE_FAILURE",
      reason,
      errorName,
      queue: {
        pending: this.#pendingCount,
        limit: this.#maxPending,
        dropped: this.#droppedCount,
      },
    };
    this.#diagnosticDirty = true;
    if (!this.#diagnostic) this.#startDiagnosticFlush();
  }

  #startDiagnosticFlush() {
    this.#diagnostic = this.#flushDiagnostics().finally(() => {
      this.#diagnostic = null;
      if (this.#diagnosticDirty) this.#startDiagnosticFlush();
    });
  }

  async #flushDiagnostics() {
    while (this.#diagnosticDirty && this.#lastFailure) {
      this.#diagnosticDirty = false;
      const failure: LiveDecisionTapeFailure = {
        ...this.#lastFailure,
        failedAt: new Date().toISOString(),
        failureCount: this.#failureCount,
      };
      try {
        await this.#reportFailure(failure);
      } catch {
        // Optional tape diagnostics never propagate into the core feed loop.
      }
    }
  }
}

export function createLiveTapeVenueReceipt(
  action: LiveTapeVenueAction,
): LiveTapeVenueReceipt {
  return {
    version: 1,
    type: "SIMULATED_VENUE_RECEIPT",
    actionHash: sha256(action),
  };
}

function venueActionFor(
  intent: ExecutionIntent,
  permit: SignedExecutionPermitV2,
  now: number,
): LiveTapeVenueAction {
  return {
    version: 1,
    type: "SIMULATED_VENUE_PUBLISH",
    invokedAt: new Date(now).toISOString(),
    agentId: intent.agentId,
    audience: intent.audience,
    command: intent.command,
    subjectHash: intent.subjectHash,
    quoteHash: intent.quoteHash,
    sequence: intent.sequence,
    permitHash: permit.hash,
  };
}

function assertVenueReceipt(
  receipt: LiveTapeVenueReceipt,
  action: LiveTapeVenueAction,
) {
  if (
    !receipt ||
    receipt.version !== 1 ||
    receipt.type !== "SIMULATED_VENUE_RECEIPT" ||
    receipt.actionHash !== sha256(action)
  ) {
    throw new Error("The simulated venue returned an invalid action receipt");
  }
}

function nonceFor(context: PersistedExecutionGateContext): string {
  return `live-${sha256({
    kind: "STOPPAGE_LIVE_TAPE_NONCE",
    version: 1,
    subjectHash: context.subjectHash,
    sequence: context.sequence,
    quote: context.state.quote,
  }).slice(2, 34)}`;
}

function permitNonceKey(permit: SignedExecutionPermitV2): string {
  const { issuer, agentId, audience, nonce } = permit.body;
  return `${issuer}:${agentId}:${audience}:${nonce}`;
}

function timingFor(
  source: LiveDecisionTapeRecord["source"],
  permitIssuedAt: number,
  privateCaptureReceivedAt?: number,
): LiveDecisionTapeRecord["timing"] {
  if (source === "TXLINE_LIVE_QUOTE") {
    if (privateCaptureReceivedAt !== undefined) {
      throw new Error("Direct live tape rows cannot carry replay timing");
    }
    return {
      permitIssuedAtBasis: "LIVE_EVALUATION_CLOCK",
      privateCaptureReceivedAt: null,
    };
  }
  if (
    !Number.isInteger(privateCaptureReceivedAt) ||
    privateCaptureReceivedAt === permitIssuedAt
  ) {
    throw new Error(
      "Capture replay must issue permits on an independent execution clock",
    );
  }
  return {
    permitIssuedAtBasis: "REPLAY_EXECUTION_CLOCK",
    privateCaptureReceivedAt: privateCaptureReceivedAt!,
  };
}

function safeErrorName(error: unknown) {
  if (!error || typeof error !== "object" || !("name" in error)) {
    return "UnknownError";
  }
  const name = String(error.name);
  return /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(name) ? name : "UnknownError";
}

function updateCounters(
  counters: LiveDecisionTapeCounters,
  record: LiveDecisionTapeRecord,
) {
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
}

function emptyCounters(): LiveDecisionTapeCounters {
  return {
    capturedRequests: 0,
    blockedRequests: 0,
    verifiedPermits: 0,
    callbacksAfterBlock: 0,
    callbacksWithoutVerifiedPermit: 0,
    crossAgentPermitTheftsRejected: 0,
  };
}
