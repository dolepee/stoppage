import { describe, expect, it, vi } from "vitest";

import { QuoteGovernor } from "../domain/governor.js";
import { hashExecutionSubject } from "../execution-gate/execution-gate.js";
import type { PersistedExecutionGateContext } from "../execution-gate/live-context.js";
import { createPermitSigner } from "../execution-gate/permit-v2.js";
import { publicJudgeScenario } from "../replay/public-scenario.js";
import {
  createLiveTapeVenueReceipt,
  LiveDecisionTapeQueue,
  LiveDecisionTapeRecorder,
  type LiveDecisionTapeRecord,
  type LiveDecisionTapeStatus,
  type LiveTapeNonceClaimer,
  type LiveTapeVenueCallback,
} from "./live-decision-tape.js";

const signer = createPermitSigner(
  Uint8Array.from({ length: 32 }, (_, index) => 31 - index),
);

describe("live decision tape", () => {
  it("executes only the intended verified agent and rejects permit theft", async () => {
    const records: LiveDecisionTapeRecord[] = [];
    const statuses: LiveDecisionTapeStatus[] = [];
    const invokeAgentA = vi.fn(createLiveTapeVenueReceipt);
    const invokeAgentB = vi.fn(createLiveTapeVenueReceipt);
    const recorder = new LiveDecisionTapeRecorder({
      signer,
      clock: () => 0,
      appendRecord: async (record) => records.push(record),
      writeStatus: async (status) => statuses.push(status),
      claimNonce: createNonceClaimer(),
      invokeAgentA,
      invokeAgentB,
    });

    const record = await recorder.record(checkpointAt(12), 10_000);

    expect(record).toMatchObject({
      source: "TXLINE_LIVE_QUOTE",
      timing: {
        permitIssuedAtBasis: "LIVE_EVALUATION_CLOCK",
        privateCaptureReceivedAt: null,
      },
      agentA: {
        gateDecision: "ALLOW_CERTIFIED_REOPEN",
        permitIssued: true,
        verification: { valid: true, decision: "ALLOW" },
        callbackInvoked: true,
        callbackReceiptHash: expect.stringMatching(/^0x[0-9a-f]{64}$/),
      },
      agentB: {
        attemptedPermitTheft: true,
        verification: {
          valid: false,
          decision: "BLOCK_AUDIENCE_MISMATCH",
        },
        callbackInvoked: false,
        callbackReceiptHash: null,
      },
      invariants: {
        callbacksAfterBlock: 0,
        callbacksWithoutVerifiedPermit: 0,
      },
    });
    expect(invokeAgentA).toHaveBeenCalledOnce();
    expect(invokeAgentB).not.toHaveBeenCalled();
    expect(records).toHaveLength(1);
    expect(statuses.at(-1)?.counters).toEqual({
      capturedRequests: 1,
      blockedRequests: 0,
      verifiedPermits: 1,
      callbacksAfterBlock: 0,
      callbacksWithoutVerifiedPermit: 0,
      crossAgentPermitTheftsRejected: 1,
    });
    expect(JSON.stringify(record)).not.toContain("fixtureId");
  });

  it("withholds every callback while the governor is uncertain", async () => {
    const invokeAgentA = vi.fn(createLiveTapeVenueReceipt);
    const invokeAgentB = vi.fn(createLiveTapeVenueReceipt);
    const recorder = new LiveDecisionTapeRecorder({
      signer,
      clock: () => 0,
      appendRecord: async () => undefined,
      writeStatus: async () => undefined,
      claimNonce: createNonceClaimer(),
      invokeAgentA,
      invokeAgentB,
    });

    const record = await recorder.record(checkpointAt(3), 10_000);

    expect(record).toMatchObject({
      agentA: {
        gateDecision: "BLOCK_UNRESOLVED_INCIDENT",
        permitIssued: false,
        verification: { valid: false, decision: "BLOCK_GATE_DECISION" },
        callbackInvoked: false,
        callbackReceiptHash: null,
      },
      agentB: {
        attemptedPermitTheft: false,
        callbackInvoked: false,
        callbackReceiptHash: null,
      },
      invariants: {
        callbacksAfterBlock: 0,
        callbacksWithoutVerifiedPermit: 0,
      },
    });
    expect(invokeAgentA).not.toHaveBeenCalled();
    expect(invokeAgentB).not.toHaveBeenCalled();
  });

  it("issues replay permits on the execution clock, never the capture clock", async () => {
    const recorder = new LiveDecisionTapeRecorder({
      signer,
      source: "TXLINE_CAPTURE_REPLAY",
      clock: () => 0,
      appendRecord: async () => undefined,
      writeStatus: async () => undefined,
      claimNonce: createNonceClaimer(),
      invokeAgentA: createLiveTapeVenueReceipt,
      invokeAgentB: createLiveTapeVenueReceipt,
    });

    const record = await recorder.record(checkpointAt(12), 20_000, 10_000);

    expect(record).toMatchObject({
      recordedAt: new Date(20_000).toISOString(),
      timing: {
        permitIssuedAtBasis: "REPLAY_EXECUTION_CLOCK",
        privateCaptureReceivedAt: 10_000,
      },
      agentA: {
        signedPermit: { body: { issuedAt: 20_000, expiresAt: 25_000 } },
      },
    });
    await expect(
      recorder.record(checkpointAt(12), 10_000, 10_000),
    ).rejects.toThrow(/independent execution clock/);
  });

  it("refuses to record execution when the venue returns no action receipt", async () => {
    const appendRecord = vi.fn();
    const recorder = new LiveDecisionTapeRecorder({
      signer,
      clock: () => 0,
      appendRecord,
      writeStatus: async () => undefined,
      claimNonce: createNonceClaimer(),
      invokeAgentA: (async () => undefined) as unknown as LiveTapeVenueCallback,
      invokeAgentB: createLiveTapeVenueReceipt,
    });

    await expect(recorder.record(checkpointAt(12), 10_000)).rejects.toThrow(
      /invalid action receipt/,
    );
    expect(appendRecord).not.toHaveBeenCalled();
  });

  it("isolates tape and diagnostic failures from later feed work", async () => {
    const appendRecord = vi
      .fn()
      .mockRejectedValueOnce(new Error("disk unavailable"))
      .mockResolvedValue(undefined);
    const recorder = new LiveDecisionTapeRecorder({
      signer,
      clock: () => 0,
      appendRecord,
      writeStatus: async () => undefined,
      claimNonce: createNonceClaimer(),
      invokeAgentA: createLiveTapeVenueReceipt,
      invokeAgentB: createLiveTapeVenueReceipt,
    });
    const reportFailure = vi.fn(async () => {
      throw new Error("diagnostic unavailable");
    });
    const queue = new LiveDecisionTapeQueue({
      recorder,
      resolveContext: (context) => context,
      reportFailure,
    });

    expect(() => queue.enqueue(checkpointAt(3))).not.toThrow();
    expect(() => queue.enqueue(checkpointAt(3))).not.toThrow();
    await expect(queue.drain()).resolves.toBeUndefined();

    expect(appendRecord).toHaveBeenCalledTimes(2);
    expect(reportFailure).toHaveBeenCalledOnce();
    expect(reportFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "LIVE_DECISION_TAPE_FAILURE",
        failureCount: 1,
        reason: "RECORDER_FAILURE",
        errorName: "Error",
      }),
    );
  });

  it("atomically consumes a permit nonce before invoking Agent A", async () => {
    const invokeAgentA = vi.fn(createLiveTapeVenueReceipt);
    const recorder = new LiveDecisionTapeRecorder({
      signer,
      clock: () => 0,
      appendRecord: async () => undefined,
      writeStatus: async () => undefined,
      claimNonce: createNonceClaimer(),
      invokeAgentA,
      invokeAgentB: createLiveTapeVenueReceipt,
    });
    const context = checkpointAt(12);

    const first = await recorder.record(context, 10_000);
    const retry = await recorder.record(context, 10_000);

    expect(first.agentA.callbackInvoked).toBe(true);
    expect(retry.agentA).toMatchObject({
      verification: { valid: false, decision: "BLOCK_NONCE_REPLAY" },
      callbackInvoked: false,
      callbackReceiptHash: null,
    });
    expect(invokeAgentA).toHaveBeenCalledOnce();
  });

  it("reverifies expiry after the durable nonce claim", async () => {
    let clock = 10_000;
    const invokeAgentA = vi.fn(createLiveTapeVenueReceipt);
    const recorder = new LiveDecisionTapeRecorder({
      signer,
      clock: () => clock,
      appendRecord: async () => undefined,
      writeStatus: async () => undefined,
      claimNonce: () => {
        clock = 15_000;
        return true;
      },
      invokeAgentA,
      invokeAgentB: createLiveTapeVenueReceipt,
    });

    const record = await recorder.record(checkpointAt(12), 10_000);

    expect(record.agentA).toMatchObject({
      verification: { valid: false, decision: "BLOCK_PERMIT_EXPIRED" },
      callbackInvoked: false,
      callbackReceiptHash: null,
    });
    expect(invokeAgentA).not.toHaveBeenCalled();
  });

  it("drops overflow beyond a fixed queue bound and reports it once", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const recorder = {
      record: vi.fn(async () => {
        await blocked;
        return {} as LiveDecisionTapeRecord;
      }),
    };
    const reportFailure = vi.fn(async () => undefined);
    const queue = new LiveDecisionTapeQueue({
      recorder,
      resolveContext: (context) => context,
      reportFailure,
      maxPending: 1,
    });

    expect(queue.enqueue(checkpointAt(3))).toBe(true);
    expect(queue.enqueue(checkpointAt(12))).toBe(false);
    release();
    await queue.drain();

    expect(recorder.record).toHaveBeenCalledOnce();
    expect(reportFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "QUEUE_OVERFLOW",
        errorName: "TapeQueueOverflow",
        queue: { pending: 1, limit: 1, dropped: 1 },
      }),
    );
  });

  it("drops a queued snapshot after the live sequence advances", async () => {
    const recorder = { record: vi.fn() };
    const reportFailure = vi.fn(async () => undefined);
    const queue = new LiveDecisionTapeQueue({
      recorder,
      resolveContext: () => null,
      reportFailure,
    });

    expect(queue.enqueue(checkpointAt(12))).toBe(true);
    await queue.drain();

    expect(recorder.record).not.toHaveBeenCalled();
    expect(reportFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "STALE_SNAPSHOT",
        errorName: "StaleTapeSnapshot",
        queue: expect.objectContaining({ dropped: 1 }),
      }),
    );
  });
});

function createNonceClaimer(): LiveTapeNonceClaimer {
  const claims = new Map<string, number>();
  return ({ key, expiresAt, now }) => {
    for (const [candidate, expiry] of claims) {
      if (expiry <= now) claims.delete(candidate);
    }
    if (claims.has(key)) return false;
    claims.set(key, expiresAt);
    return true;
  };
}

function checkpointAt(stepCount: number): PersistedExecutionGateContext {
  const governor = new QuoteGovernor();
  for (const step of publicJudgeScenario.steps.slice(0, stepCount)) {
    governor.process(step.input);
  }
  const fixtureId = publicJudgeScenario.match.fixtureId;
  const state = governor.getState(fixtureId);
  return {
    version: 1,
    subjectHash: hashExecutionSubject({ fixtureId }),
    configHash: governor.configHash,
    sequence: stepCount,
    observedTs: 10_000,
    state,
    reopenProofs: [...governor.getReopenProofs(fixtureId)],
    updatedAt: new Date(10_000).toISOString(),
  };
}
