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
      appendRecord: async (record) => records.push(record),
      writeStatus: async (status) => statuses.push(status),
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
      appendRecord: async () => undefined,
      writeStatus: async () => undefined,
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
      appendRecord: async () => undefined,
      writeStatus: async () => undefined,
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
      appendRecord,
      writeStatus: async () => undefined,
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
      appendRecord,
      writeStatus: async () => undefined,
      invokeAgentA: createLiveTapeVenueReceipt,
      invokeAgentB: createLiveTapeVenueReceipt,
    });
    const reportFailure = vi.fn(async () => {
      throw new Error("diagnostic unavailable");
    });
    const queue = new LiveDecisionTapeQueue({ recorder, reportFailure });

    expect(() => queue.enqueue(checkpointAt(3))).not.toThrow();
    expect(() => queue.enqueue(checkpointAt(3))).not.toThrow();
    await expect(queue.drain()).resolves.toBeUndefined();

    expect(appendRecord).toHaveBeenCalledTimes(2);
    expect(reportFailure).toHaveBeenCalledOnce();
    expect(reportFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "LIVE_DECISION_TAPE_FAILURE",
        failureCount: 1,
        errorName: "Error",
      }),
    );
  });
});

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
