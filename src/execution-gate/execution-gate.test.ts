import { describe, expect, it } from "vitest";

import { sha256 } from "../domain/canonical.js";
import { QuoteGovernor } from "../domain/governor.js";
import type {
  ConsensusQuote,
  GovernorInput,
  MatchEvent,
} from "../domain/types.js";
import { publicJudgeScenario } from "../replay/public-scenario.js";
import {
  DEFAULT_EXECUTION_GATE_CONFIG,
  evaluateExecutionGate,
  hashExecutionSubject,
  hashQuote,
  verifyExecutionPermit,
} from "./execution-gate.js";
import { ReferenceMarketMaker } from "./reference-agent.js";
import type {
  ExecutionGateContext,
  ExecutionGateRequest,
  ExecutionPermit,
} from "./types.js";

const fixtureId = publicJudgeScenario.match.fixtureId;
const subjectHash = hashExecutionSubject(publicJudgeScenario.id);

describe("Execution Gate", () => {
  it("allows a healthy current quote before an incident", () => {
    const harness = createHarness();
    const quote = harness.processStep(0) as ConsensusQuote;
    const result = evaluateExecutionGate(request(quote), harness.context());

    expect(result.decision).toBe("ALLOW_HEALTHY_QUOTE");
    expect(result.permit).not.toBeNull();
    expect(
      verifyExecutionPermit(
        result.permit!,
        harness.context(),
        harness.context().observedTs,
      ),
    ).toBe(true);
  });

  it("blocks every unresolved and invalidated lifecycle state", () => {
    const harness = createHarness();
    harness.processStep(0);
    harness.processStep(1);
    expect(evaluateCurrent(harness).decision).toBe("BLOCK_UNRESOLVED_INCIDENT");

    harness.processThrough(5);
    expect(harness.context().state.mode).toBe("REPRICED");
    expect(evaluateCurrent(harness).decision).toBe("BLOCK_UNRESOLVED_INCIDENT");

    harness.processStep(6);
    expect(harness.context().state.mode).toBe("SUSPENDED");
    expect(evaluateCurrent(harness).decision).toBe("BLOCK_INVALIDATED_BRANCH");

    harness.processThrough(10);
    expect(harness.context().state.mode).toBe("REPRICED");
    expect(evaluateCurrent(harness).decision).toBe("BLOCK_INVALIDATED_BRANCH");
  });

  it("issues a verified permit only for the exact Certified Reopen", () => {
    const harness = createHarness();
    harness.processThrough(11);
    const context = harness.context();
    const result = evaluateCurrent(harness);

    expect(context.state.mode).toBe("OPEN");
    expect(result.decision).toBe("ALLOW_CERTIFIED_REOPEN");
    expect(result.permit?.body.reopenProofHash).toBe(
      context.reopenProofs[0]?.hash,
    );
    expect(result.permit?.body.stateReceiptHash).toBe(
      context.state.receipts.at(-1)?.hash,
    );
    expect(
      verifyExecutionPermit(result.permit!, context, context.observedTs),
    ).toBe(true);
  });

  it("rejects permit tampering even when the attacker recomputes its hash", () => {
    const harness = createHarness();
    harness.processThrough(11);
    const context = harness.context();
    const permit = evaluateCurrent(harness).permit!;

    const mutations: Array<(candidate: ExecutionPermit) => void> = [
      (candidate) => {
        candidate.body.subjectHash = sha256("different-subject");
      },
      (candidate) => {
        candidate.body.quoteHash = sha256("different-quote");
      },
      (candidate) => {
        candidate.body.configHash = sha256("different-config");
      },
      (candidate) => {
        candidate.body.stateReceiptHash = sha256("different-receipt");
      },
      (candidate) => {
        candidate.body.reopenProofHash = sha256("different-proof");
      },
      (candidate) => {
        candidate.body.sequence += 1;
      },
      (candidate) => {
        candidate.body.expiresAt += 1;
      },
    ];

    for (const mutate of mutations) {
      const candidate = structuredClone(permit);
      mutate(candidate);
      candidate.hash = sha256(candidate.body);
      expect(
        verifyExecutionPermit(candidate, context, context.observedTs),
      ).toBe(false);
    }
  });

  it("revokes a permit on expiry, a new quote, a new incident, or stream failure", () => {
    const expiredHarness = completedHarness();
    const expiredPermit = evaluateCurrent(expiredHarness).permit!;
    expect(
      verifyExecutionPermit(
        expiredPermit,
        expiredHarness.context(),
        expiredPermit.body.expiresAt,
      ),
    ).toBe(false);

    const quoteHarness = completedHarness();
    const quotePermit = evaluateCurrent(quoteHarness).permit!;
    quoteHarness.process(
      quote("replacement", quoteHarness.context().observedTs + 1, {
        HOME: 0.455,
        DRAW: 0.283,
        AWAY: 0.262,
      }),
    );
    expect(
      verifyExecutionPermit(
        quotePermit,
        quoteHarness.context(),
        quoteHarness.context().observedTs,
      ),
    ).toBe(false);

    const incidentHarness = completedHarness();
    const incidentPermit = evaluateCurrent(incidentHarness).permit!;
    incidentHarness.process(
      incident("new-incident", incidentHarness.context().observedTs + 1),
    );
    expect(
      verifyExecutionPermit(
        incidentPermit,
        incidentHarness.context(),
        incidentHarness.context().observedTs,
      ),
    ).toBe(false);

    const healthHarness = completedHarness();
    const healthPermit = evaluateCurrent(healthHarness).permit!;
    healthHarness.process({
      kind: "stream-health",
      stream: "odds",
      healthy: false,
      observedTs: healthHarness.context().observedTs + 1,
      reason: "test",
    });
    expect(evaluateCurrent(healthHarness).decision).toBe(
      "BLOCK_STREAM_UNHEALTHY",
    );
    expect(
      verifyExecutionPermit(
        healthPermit,
        healthHarness.context(),
        healthHarness.context().observedTs,
      ),
    ).toBe(false);
  });

  it("blocks a stale proposed quote and never emits a permit", () => {
    const harness = createHarness();
    harness.processStep(0);
    const result = evaluateExecutionGate(
      {
        version: 1,
        command: "PUBLISH_QUOTE",
        subjectHash,
        market: "1X2",
        quoteHash: sha256("stale"),
      },
      harness.context(),
    );

    expect(result).toMatchObject({
      decision: "BLOCK_QUOTE_STALE",
      permit: null,
    });
  });
});

describe("Reference market-maker", () => {
  it("obeys the gate through BLOCK and certified ALLOW", () => {
    const harness = createHarness();
    const agent = new ReferenceMarketMaker(DEFAULT_EXECUTION_GATE_CONFIG);

    let proposed = harness.processStep(0) as ConsensusQuote;
    expect(agent.attempt(proposed, harness.context())).toMatchObject({
      decision: "ALLOW",
      result: "SIMULATED_QUOTE_PUBLISHED",
      permitVerified: true,
    });

    harness.processStep(1);
    expect(agent.attempt(proposed, harness.context())).toMatchObject({
      decision: "BLOCK",
      decisionCode: "BLOCK_UNRESOLVED_INCIDENT",
      result: "QUOTE_BLOCKED",
      permit: null,
    });

    for (let index = 2; index <= 10; index += 1) {
      const input = harness.processStep(index);
      if (input.kind === "quote") proposed = input;
      expect(agent.attempt(proposed, harness.context()).decision).toBe("BLOCK");
    }

    harness.processStep(11);
    expect(agent.attempt(proposed, harness.context())).toMatchObject({
      decision: "ALLOW",
      decisionCode: "ALLOW_CERTIFIED_REOPEN",
      result: "SIMULATED_QUOTE_PUBLISHED",
      permitVerified: true,
    });
  });
});

function createHarness() {
  const governor = new QuoteGovernor();
  let sequence = 0;
  let observedTs = publicJudgeScenario.match.kickoffTs;
  let lastProcessedIndex = -1;

  return {
    process(input: GovernorInput) {
      sequence += 1;
      observedTs = inputTimestamp(input);
      governor.process(input);
      return input;
    },
    processStep(index: number) {
      lastProcessedIndex = Math.max(lastProcessedIndex, index);
      return this.process(publicJudgeScenario.steps[index]!.input);
    },
    processThrough(index: number) {
      for (let step = lastProcessedIndex + 1; step <= index; step += 1) {
        this.processStep(step);
      }
    },
    context(): ExecutionGateContext {
      return {
        subjectHash,
        configHash: governor.configHash,
        sequence,
        observedTs,
        state: governor.getState(fixtureId),
        reopenProofs: governor.getReopenProofs(fixtureId),
      };
    },
  };
}

function completedHarness() {
  const harness = createHarness();
  harness.processThrough(11);
  return harness;
}

function evaluateCurrent(harness: ReturnType<typeof createHarness>) {
  const context = harness.context();
  return evaluateExecutionGate(
    {
      version: 1,
      command: "PUBLISH_QUOTE",
      subjectHash,
      market: "1X2",
      quoteHash: context.state.quote
        ? hashQuote(context.state.quote)
        : sha256("no-quote"),
    },
    context,
  );
}

function request(quoteInput: ConsensusQuote): ExecutionGateRequest {
  return {
    version: 1,
    command: "PUBLISH_QUOTE",
    subjectHash,
    market: quoteInput.market,
    quoteHash: hashQuote(quoteInput),
  };
}

function inputTimestamp(input: GovernorInput) {
  if (input.kind === "stream-health" || input.kind === "tick") {
    return input.observedTs;
  }
  return input.receivedTs;
}

function quote(
  messageId: string,
  timestamp: number,
  probabilities: ConsensusQuote["probabilities"],
): ConsensusQuote {
  return {
    kind: "quote",
    fixtureId,
    market: "1X2",
    messageId,
    sourceTs: timestamp,
    receivedTs: timestamp,
    probabilities,
  };
}

function incident(eventId: string, timestamp: number): MatchEvent {
  return {
    kind: "match-event",
    fixtureId,
    eventId,
    incidentId: eventId,
    eventType: "GOAL",
    sourceTs: timestamp,
    receivedTs: timestamp,
    confirmed: false,
  };
}
