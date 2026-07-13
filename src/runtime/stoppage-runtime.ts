import { QuoteGovernor } from "../domain/governor.js";
import { evaluateSuspendedWindow } from "../domain/metrics.js";
import type {
  ConsensusQuote,
  DecisionReceipt,
  GovernorInput,
  ProbabilityVector,
} from "../domain/types.js";
import type { ReplayScenario } from "../replay/types.js";
import type { RuntimeMetrics, RuntimeSnapshot, TimelineItem } from "./types.js";

interface EvaluationSegment {
  startTs: number;
  endTs: number;
  baselineProbability: ProbabilityVector;
}

type SnapshotListener = (snapshot: RuntimeSnapshot) => void;

export class StoppageRuntime {
  #scenario: ReplayScenario;
  #governor = new QuoteGovernor();
  #status: RuntimeSnapshot["replayStatus"] = "IDLE";
  #speed = 4;
  #elapsedMs = 0;
  #timeline: TimelineItem[] = [];
  #baselineQuote: ConsensusQuote | null = null;
  #activeSegmentStart: number | null = null;
  #segments: EvaluationSegment[] = [];
  #metrics: RuntimeMetrics = emptyMetrics();
  #abortController: AbortController | null = null;
  #listeners = new Set<SnapshotListener>();

  constructor(scenario: ReplayScenario) {
    this.#scenario = scenario;
  }

  subscribe(listener: SnapshotListener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  snapshot(): RuntimeSnapshot {
    const state = this.#governor.getState(this.#scenario.match.fixtureId);
    return {
      version: 1,
      scenarioId: this.#scenario.id,
      scenarioLabel: this.#scenario.label,
      dataMode: this.#scenario.dataMode,
      dataDescription: this.#scenario.description,
      replayStatus: this.#status,
      replaySpeed: this.#speed,
      replayElapsedMs: this.#elapsedMs,
      match: this.#scenario.match,
      mode: state.mode,
      currentProbability: state.quote?.probabilities ?? null,
      baselineProbability: this.#baselineQuote?.probabilities ?? null,
      streamHealth: structuredClone(state.streamHealth),
      configHash: this.#governor.configHash,
      timeline: structuredClone(this.#timeline),
      receipts: structuredClone(state.receipts),
      reopenProofs: structuredClone([
        ...this.#governor.getReopenProofs(this.#scenario.match.fixtureId),
      ]),
      metrics: structuredClone(this.#metrics),
      updatedAt: new Date().toISOString(),
    };
  }

  async start(speed = 4): Promise<void> {
    if (!Number.isFinite(speed) || speed <= 0 || speed > 16) {
      throw new Error("Replay speed must be between 0 and 16");
    }
    this.stop();
    this.#reset();
    this.#speed = speed;
    this.#status = "RUNNING";
    this.#abortController = new AbortController();
    this.#publish();

    let previousAt = 0;
    try {
      for (const step of this.#scenario.steps) {
        const waitMs = (step.atMs - previousAt) / speed;
        await delay(waitMs, this.#abortController.signal);
        if (this.#abortController.signal.aborted) return;

        this.#elapsedMs = step.atMs;
        this.#recordInput(step.input, step.label);
        const receipts = this.#governor.process(step.input);
        this.#updateEvaluation(step.input, receipts);
        this.#recordReceipts(receipts);
        previousAt = step.atMs;
        this.#publish();
      }
      this.#status = "COMPLETE";
      this.#publish();
    } catch (error) {
      if ((error as Error).name !== "AbortError") throw error;
    }
  }

  stop() {
    if (this.#abortController) this.#abortController.abort();
    if (this.#status === "RUNNING") this.#status = "STOPPED";
    this.#abortController = null;
    this.#publish();
  }

  #reset() {
    this.#governor = new QuoteGovernor();
    this.#status = "IDLE";
    this.#elapsedMs = 0;
    this.#timeline = [];
    this.#baselineQuote = null;
    this.#activeSegmentStart = null;
    this.#segments = [];
    this.#metrics = emptyMetrics();
  }

  #recordInput(input: GovernorInput, label: string) {
    const at = inputTimestamp(input);
    this.#timeline.push({
      id: `input-${this.#timeline.length + 1}`,
      at,
      kind: "INPUT",
      label,
      detail: inputDetail(input),
    });
  }

  #recordReceipts(receipts: DecisionReceipt[]) {
    for (const receipt of receipts) {
      this.#timeline.push({
        id: `decision-${receipt.hash}`,
        at: receipt.body.observedTs,
        kind: "DECISION",
        label: receipt.body.action,
        detail: receipt.body.trigger,
        mode: receipt.body.toMode,
        receiptHash: receipt.hash,
      });
      if (receipt.body.action === "ENTER_FAILSAFE") {
        this.#metrics.failoverCount += 1;
      }
    }
  }

  #updateEvaluation(input: GovernorInput, receipts: DecisionReceipt[]) {
    const timestamp = inputTimestamp(input);
    const previousBaseline = this.#baselineQuote;

    if (input.kind === "quote") {
      if (this.#activeSegmentStart !== null && previousBaseline) {
        this.#segments.push({
          startTs: this.#activeSegmentStart,
          endTs: timestamp,
          baselineProbability: previousBaseline.probabilities,
        });
        this.#activeSegmentStart = timestamp;
      }
      this.#baselineQuote = input;
    }

    for (const receipt of receipts) {
      if (receipt.body.action === "SUSPEND") {
        this.#activeSegmentStart = receipt.body.observedTs;
        if (input.kind === "match-event" || input.kind === "quote") {
          this.#metrics.suspensionReactionMs =
            receipt.body.observedTs - input.sourceTs;
        }
      }

      if (
        receipt.body.action === "REOPEN" &&
        this.#baselineQuote &&
        this.#metrics.staleQuoteSeconds === null
      ) {
        if (this.#activeSegmentStart !== null) {
          this.#segments.push({
            startTs: this.#activeSegmentStart,
            endTs: receipt.body.observedTs,
            baselineProbability: this.#baselineQuote.probabilities,
          });
        }
        const evaluated = evaluateSuspendedWindow(
          this.#segments,
          this.#baselineQuote.probabilities,
        );
        this.#metrics.staleQuoteSeconds = evaluated.staleQuoteSeconds;
        this.#metrics.mispricingIntegral = evaluated.mispricingIntegral;
        this.#metrics.maximumProbabilityDivergence =
          evaluated.maximumProbabilityDivergence;
        this.#activeSegmentStart = null;
        this.#segments = [];
      }
    }
  }

  #publish() {
    const snapshot = this.snapshot();
    for (const listener of this.#listeners) listener(snapshot);
  }
}

function emptyMetrics(): RuntimeMetrics {
  return {
    suspensionReactionMs: null,
    staleQuoteSeconds: null,
    mispricingIntegral: null,
    maximumProbabilityDivergence: null,
    failoverCount: 0,
  };
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

function inputDetail(input: GovernorInput): string {
  if (input.kind === "quote") return `${input.market} · ${input.messageId}`;
  if (input.kind === "match-event") {
    return `${input.eventType} · ${input.confirmed ? "confirmed" : "unconfirmed"}`;
  }
  if (input.kind === "event-resolution") {
    return `${input.resolution} · ${input.incidentId}`;
  }
  if (input.kind === "stream-health") {
    return `${input.stream} · ${input.healthy ? "healthy" : (input.reason ?? "unhealthy")}`;
  }
  return "policy clock";
}

function delay(milliseconds: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(resolve, Math.max(0, milliseconds));
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        reject(new DOMException("Replay aborted", "AbortError"));
      },
      { once: true },
    );
  });
}
