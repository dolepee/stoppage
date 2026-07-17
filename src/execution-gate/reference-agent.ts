import type { ConsensusQuote } from "../domain/types.js";
import {
  evaluateExecutionGate,
  hashQuote,
  inspectExecutionPermit,
} from "./execution-gate.js";
import type {
  ExecutionGateConfig,
  ExecutionGateContext,
  ExecutionGateDecision,
  ExecutionPermit,
} from "./types.js";

export interface ReferenceAgentSnapshot {
  version: 1;
  name: "Reference market-maker";
  command: "PUBLISH_QUOTE";
  decision: "WAITING" | "BLOCK" | "ALLOW";
  decisionCode: ExecutionGateDecision | null;
  reason: string;
  result: "NO_QUOTE" | "QUOTE_BLOCKED" | "SIMULATED_QUOTE_PUBLISHED";
  requestedQuoteHash: string | null;
  permit: ExecutionPermit | null;
  permitVerified: boolean;
  attemptedAt: number | null;
  simulated: true;
}

export class ReferenceMarketMaker {
  readonly #config: ExecutionGateConfig;
  #snapshot: ReferenceAgentSnapshot = emptySnapshot();

  constructor(config: ExecutionGateConfig) {
    this.#config = structuredClone(config);
  }

  snapshot(): ReferenceAgentSnapshot {
    return structuredClone(this.#snapshot);
  }

  reset() {
    this.#snapshot = emptySnapshot();
  }

  attempt(
    quote: ConsensusQuote | null,
    context: ExecutionGateContext,
  ): ReferenceAgentSnapshot {
    if (!quote) {
      this.#snapshot = emptySnapshot();
      return this.snapshot();
    }

    const requestedQuoteHash = hashQuote(quote);
    const result = evaluateExecutionGate(
      {
        version: 1,
        command: "PUBLISH_QUOTE",
        subjectHash: context.subjectHash,
        market: quote.market,
        quoteHash: requestedQuoteHash,
      },
      context,
      this.#config,
    );

    if (!result.permit) {
      this.#snapshot = {
        version: 1,
        name: "Reference market-maker",
        command: "PUBLISH_QUOTE",
        decision: "BLOCK",
        decisionCode: result.decision,
        reason: result.reason,
        result: "QUOTE_BLOCKED",
        requestedQuoteHash,
        permit: null,
        permitVerified: false,
        attemptedAt: context.observedTs,
        simulated: true,
      };
      return this.snapshot();
    }

    const verification = inspectExecutionPermit(
      result.permit,
      context,
      context.observedTs,
      this.#config,
    );
    this.#snapshot = {
      version: 1,
      name: "Reference market-maker",
      command: "PUBLISH_QUOTE",
      decision: verification.valid ? "ALLOW" : "BLOCK",
      decisionCode: verification.valid
        ? result.decision
        : verification.decision,
      reason: verification.reason,
      result: verification.valid
        ? "SIMULATED_QUOTE_PUBLISHED"
        : "QUOTE_BLOCKED",
      requestedQuoteHash,
      permit: verification.valid ? result.permit : null,
      permitVerified: verification.valid,
      attemptedAt: context.observedTs,
      simulated: true,
    };
    return this.snapshot();
  }
}

function emptySnapshot(): ReferenceAgentSnapshot {
  return {
    version: 1,
    name: "Reference market-maker",
    command: "PUBLISH_QUOTE",
    decision: "WAITING",
    decisionCode: null,
    reason: "Waiting for the first governed quote.",
    result: "NO_QUOTE",
    requestedQuoteHash: null,
    permit: null,
    permitVerified: false,
    attemptedAt: null,
    simulated: true,
  };
}
