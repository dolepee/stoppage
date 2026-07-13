import { describe, expect, it } from "vitest";

import { QuoteGovernor } from "../domain/governor.js";
import type { ConsensusQuote } from "../domain/types.js";
import { publicJudgeScenario } from "../replay/public-scenario.js";
import { hashExecutionSubject } from "./execution-gate.js";
import {
  executionContextFromPersisted,
  LiveExecutionContextTracker,
} from "./live-context.js";

describe("live Execution Gate contexts", () => {
  it("tracks private per-fixture context and advances global safety inputs", () => {
    const governor = new QuoteGovernor();
    const tracker = new LiveExecutionContextTracker();
    const quote = publicJudgeScenario.steps[0]!.input as ConsensusQuote;
    const incident = publicJudgeScenario.steps[1]!.input;
    const tickAt = quote.receivedTs + 2_000;

    tracker.observe(quote, "2026-07-13T16:00:00.000Z");
    governor.process(quote);
    tracker.observe(incident, "2026-07-13T16:00:01.000Z");
    governor.process(incident);
    tracker.observe(
      { kind: "tick", observedTs: tickAt },
      "2026-07-13T16:00:02.000Z",
    );
    governor.process({ kind: "tick", observedTs: tickAt });

    const contexts = tracker.contexts(governor);
    expect(contexts).toHaveLength(1);
    expect(contexts[0]).toMatchObject({
      version: 1,
      subjectHash: hashExecutionSubject({ fixtureId: quote.fixtureId }),
      configHash: governor.configHash,
      sequence: 3,
      observedTs: tickAt,
      updatedAt: "2026-07-13T16:00:02.000Z",
      state: {
        fixtureId: quote.fixtureId,
        mode: "SUSPENDED",
      },
    });

    const projected = executionContextFromPersisted(contexts[0]!, tickAt + 1);
    expect(projected.observedTs).toBe(tickAt + 1);
    projected.state.pendingUnconfirmedIncidentIds.length = 0;
    expect(contexts[0]!.state.pendingUnconfirmedIncidentIds).not.toHaveLength(
      0,
    );
  });
});
