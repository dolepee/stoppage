import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { QuoteGovernor } from "../domain/governor.js";
import { hashExecutionSubject } from "../execution-gate/execution-gate.js";
import type { PersistedExecutionGateContext } from "../execution-gate/live-context.js";
import {
  createPermitSigner,
  publicKeySetFor,
} from "../execution-gate/permit-v2.js";
import {
  LiveDecisionTapeRecorder,
  type LiveDecisionTapeRecord,
} from "../live/live-decision-tape.js";
import { publicJudgeScenario } from "../replay/public-scenario.js";
import {
  assertLiveTapePublicBoundary,
  buildApprovedLiveDecisionTape,
  buildLiveDecisionTapeCandidate,
  loadPublicLiveDecisionTape,
} from "./live-decision-tape.js";

const signer = createPermitSigner(
  Uint8Array.from({ length: 32 }, (_, index) => index + 21),
);

describe("public live decision-tape evidence", () => {
  it("publishes only an approved sanitized aggregate with a verifiable sample", async () => {
    const candidate = buildLiveDecisionTapeCandidate(
      await completeTape(),
      publicKeySetFor(signer),
    );
    const approved = buildApprovedLiveDecisionTape({
      candidate,
      approvalStatement: candidate.requiredApproval,
      approvedAt: "2026-07-16T16:00:00.000Z",
    });

    expect(approved).toMatchObject({
      status: "AVAILABLE",
      evidenceType: "RECORDED_TXLINE_DECISION_TAPE",
      operation: "BUILDER_OPERATED_CAPTURE",
      hostingClaim: "RECORDED_CAPTURE_NOT_HOSTED_UPTIME",
      timingDisclosure:
        "PERMIT_ISSUED_AT_IS_ENFORCEMENT_EXECUTION_TIME_NOT_FEED_TIME",
      counters: {
        capturedRequests: 2,
        blockedRequests: 1,
        verifiedPermits: 1,
        callbacksAfterBlock: 0,
        callbacksWithoutVerifiedPermit: 0,
        crossAgentPermitTheftsRejected: 1,
      },
      sampleProof: {
        decision: "ALLOW_CERTIFIED_REOPEN",
        intendedAgent: {
          verification: "ALLOW",
          callbackInvoked: true,
        },
        crossAgentAttempt: {
          verification: "BLOCK_AUDIENCE_MISMATCH",
          callbackInvoked: false,
        },
      },
    });
    expect(JSON.stringify(approved)).not.toContain("fixtureId");
    expect(JSON.stringify(approved)).not.toContain("probabilities");

    const root = await mkdtemp(join(tmpdir(), "stoppage-live-tape-"));
    await writeFile(
      join(root, "live-decision-tape.json"),
      JSON.stringify(approved),
    );
    await expect(loadPublicLiveDecisionTape(root)).resolves.toEqual(approved);
  });

  it("requires one real block and rejects unapproved or tampered publication", async () => {
    const records = await completeTape();
    expect(() =>
      buildLiveDecisionTapeCandidate(
        records.filter((record) =>
          record.agentA.gateDecision.startsWith("ALLOW_"),
        ),
        publicKeySetFor(signer),
      ),
    ).toThrow(/uncertainty block/);

    const candidate = buildLiveDecisionTapeCandidate(
      records,
      publicKeySetFor(signer),
    );
    expect(() =>
      buildApprovedLiveDecisionTape({
        candidate,
        approvalStatement: "APPROVE SOMETHING ELSE",
        approvedAt: "2026-07-16T16:00:00.000Z",
      }),
    ).toThrow(/exactly equal/);

    const root = await mkdtemp(join(tmpdir(), "stoppage-live-tape-"));
    const approved = buildApprovedLiveDecisionTape({
      candidate,
      approvalStatement: candidate.requiredApproval,
      approvedAt: "2026-07-16T16:00:00.000Z",
    });
    approved.counters.callbacksAfterBlock = 1;
    await writeFile(
      join(root, "live-decision-tape.json"),
      JSON.stringify(approved),
    );
    await expect(loadPublicLiveDecisionTape(root)).resolves.toBeNull();
  });

  it("requires Certified Reopen rather than an ordinary healthy allow", async () => {
    const records: LiveDecisionTapeRecord[] = [];
    const recorder = new LiveDecisionTapeRecorder({
      signer,
      appendRecord: async (record) => records.push(record),
      writeStatus: async () => undefined,
    });
    await recorder.record(checkpointAt(3), 10_000);
    await recorder.record(checkpointAt(1), 20_000);

    expect(() =>
      buildLiveDecisionTapeCandidate(records, publicKeySetFor(signer)),
    ).toThrow(/signed Certified Reopen/);
  });

  it("rejects replay capture time at both the private and public boundaries", async () => {
    const records: LiveDecisionTapeRecord[] = [];
    const recorder = new LiveDecisionTapeRecorder({
      signer,
      source: "TXLINE_CAPTURE_REPLAY",
      appendRecord: async (record) => records.push(record),
      writeStatus: async () => undefined,
    });
    await recorder.record(checkpointAt(3), 30_000, 10_000);
    await recorder.record(checkpointAt(12), 40_000, 20_000);
    records[0]!.timing.privateCaptureReceivedAt = Date.parse(
      records[0]!.recordedAt,
    );

    expect(() =>
      buildLiveDecisionTapeCandidate(records, publicKeySetFor(signer)),
    ).toThrow(/source timing/);
    expect(() =>
      assertLiveTapePublicBoundary({ privateCaptureReceivedAt: 10_000 }),
    ).toThrow(/privateCaptureReceivedAt/);
  });

  it("rejects raw licensed-feed fields at the publication boundary", () => {
    expect(() =>
      assertLiveTapePublicBoundary({ fixtureId: 123, safe: false }),
    ).toThrow(/fixtureId/);
    expect(() =>
      assertLiveTapePublicBoundary({ probabilities: [0.4, 0.3, 0.3] }),
    ).toThrow(/probabilities/);
    expect(() => assertLiveTapePublicBoundary({ sourceTs: 123 })).toThrow(
      /sourceTs/,
    );
  });
});

async function completeTape(): Promise<LiveDecisionTapeRecord[]> {
  const records: LiveDecisionTapeRecord[] = [];
  const recorder = new LiveDecisionTapeRecorder({
    signer,
    appendRecord: async (record) => records.push(record),
    writeStatus: async () => undefined,
  });
  await recorder.record(checkpointAt(3), 10_000);
  await recorder.record(checkpointAt(12), 20_000);
  return records;
}

function checkpointAt(stepCount: number): PersistedExecutionGateContext {
  const governor = new QuoteGovernor();
  for (const step of publicJudgeScenario.steps.slice(0, stepCount)) {
    governor.process(step.input);
  }
  const fixtureId = publicJudgeScenario.match.fixtureId;
  return {
    version: 1,
    subjectHash: hashExecutionSubject({ fixtureId }),
    configHash: governor.configHash,
    sequence: stepCount,
    observedTs: 10_000,
    state: governor.getState(fixtureId),
    reopenProofs: [...governor.getReopenProofs(fixtureId)],
    updatedAt: new Date(10_000).toISOString(),
  };
}
