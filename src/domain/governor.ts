import { sha256 } from "./canonical.js";
import {
  assertProbabilityVector,
  maximumProbabilityMove,
} from "./probability.js";
import type {
  ConsensusQuote,
  DecisionAction,
  DecisionReceipt,
  FixtureGovernorState,
  FixtureId,
  GovernorConfig,
  GovernorInput,
  GovernorMode,
  MatchEvent,
  TriggerCode,
} from "./types.js";

export const DEFAULT_GOVERNOR_CONFIG: GovernorConfig = {
  sharpMoveThreshold: 0.04,
  stabilityEpsilon: 0.006,
  stableUpdatesRequired: 3,
  reopenDelayMs: 5_000,
  eventConfirmationWindowMs: 30_000,
  recoveryStableMs: 5_000,
};

export class QuoteGovernor {
  readonly #config: GovernorConfig;
  readonly #configHash: string;
  readonly #fixtures = new Map<FixtureId, FixtureGovernorState>();
  readonly #streamHealth = { odds: true, scores: true };

  constructor(config: GovernorConfig = DEFAULT_GOVERNOR_CONFIG) {
    if (config.stableUpdatesRequired < 2) {
      throw new Error("stableUpdatesRequired must be at least 2");
    }
    this.#config = structuredClone(config);
    this.#configHash = sha256(this.#config);
  }

  get configHash() {
    return this.#configHash;
  }

  getState(fixtureId: FixtureId): Readonly<FixtureGovernorState> {
    return structuredClone(this.#state(fixtureId));
  }

  process(input: GovernorInput): DecisionReceipt[] {
    if (input.kind === "stream-health") return this.#processHealth(input);
    if (input.kind === "tick") return this.#processTick(input.observedTs);
    if (input.kind === "event-resolution") {
      return this.#processEventResolution(this.#state(input.fixtureId), input);
    }

    const state = this.#state(input.fixtureId);
    if (input.kind === "match-event")
      return this.#processMatchEvent(state, input);
    return this.#processQuote(state, input);
  }

  #processQuote(
    state: FixtureGovernorState,
    quote: ConsensusQuote,
  ): DecisionReceipt[] {
    assertProbabilityVector(quote.probabilities);
    if (quote.market !== "1X2")
      throw new Error("Stoppage MVP accepts 1X2 only");
    if (state.quote && quote.sourceTs < state.quote.sourceTs) return [];

    if (state.mode === "FAILSAFE") {
      state.quote = quote;
      return [];
    }

    if (state.mode === "OPEN") {
      if (!state.quote) {
        state.quote = quote;
        return [];
      }

      const move = maximumProbabilityMove(
        state.quote.probabilities,
        quote.probabilities,
      );
      const eventSupportsMove =
        state.lastHighImpactEvent !== null &&
        quote.receivedTs - state.lastHighImpactEvent.receivedTs <=
          this.#config.eventConfirmationWindowMs;

      if (move >= this.#config.sharpMoveThreshold && !eventSupportsMove) {
        state.preTriggerQuote = state.quote;
        state.quote = quote;
        state.pendingTrigger = "UNBACKED_MOVE";
        state.pendingSourceIds = [quote.messageId];
        state.suspendedAt = quote.receivedTs;
        state.stableUpdateCount = 1;
        state.candidateQuote = quote;
        return [
          this.#transition(
            state,
            "SUSPENDED",
            "SUSPEND",
            "UNBACKED_MOVE",
            quote.receivedTs,
            [quote.messageId],
          ),
        ];
      }

      state.quote = quote;
      return [];
    }

    const previousCandidate = state.candidateQuote;
    state.quote = quote;
    state.candidateQuote = quote;
    state.pendingSourceIds = unique([
      ...state.pendingSourceIds,
      quote.messageId,
    ]);

    if (
      previousCandidate &&
      maximumProbabilityMove(
        previousCandidate.probabilities,
        quote.probabilities,
      ) <= this.#config.stabilityEpsilon
    ) {
      state.stableUpdateCount += 1;
    } else {
      state.stableUpdateCount = 1;
      if (state.mode === "REPRICED") {
        state.mode = "SUSPENDED";
        state.repricedAt = null;
      }
    }

    if (
      state.mode === "SUSPENDED" &&
      state.stableUpdateCount >= this.#config.stableUpdatesRequired
    ) {
      state.repricedAt = quote.receivedTs;
      return [
        this.#transition(
          state,
          "REPRICED",
          "REPRICE",
          state.pendingTrigger ?? "VOLATILITY_SPIKE",
          quote.receivedTs,
          state.pendingSourceIds,
          quote,
        ),
      ];
    }

    return this.#maybeReopen(state, quote.receivedTs);
  }

  #processMatchEvent(
    state: FixtureGovernorState,
    event: MatchEvent,
  ): DecisionReceipt[] {
    state.lastHighImpactEvent = event;
    const firstObservation = !state.seenEventIncidentIds.includes(
      event.incidentId,
    );
    if (firstObservation) state.seenEventIncidentIds.push(event.incidentId);
    if (event.confirmed) {
      state.pendingUnconfirmedIncidentIds =
        state.pendingUnconfirmedIncidentIds.filter(
          (incidentId) => incidentId !== event.incidentId,
        );
    } else if (
      !state.pendingUnconfirmedIncidentIds.includes(event.incidentId)
    ) {
      state.pendingUnconfirmedIncidentIds.push(event.incidentId);
    }
    if (state.mode === "FAILSAFE") return [];

    if (state.mode === "SUSPENDED" || state.mode === "REPRICED") {
      state.pendingSourceIds = unique([
        ...state.pendingSourceIds,
        event.eventId,
      ]);
      if (state.pendingTrigger === "UNBACKED_MOVE") {
        state.pendingTrigger = "EVENT_CONFIRMED_MOVE";
      }
      if (state.mode === "REPRICED" && firstObservation) {
        state.pendingTrigger = "EVENT_BEFORE_REPRICE";
        state.suspendedAt = event.receivedTs;
        state.stableUpdateCount = 0;
        state.candidateQuote = null;
        state.repricedAt = null;
        return [
          this.#transition(
            state,
            "SUSPENDED",
            "SUSPEND",
            "EVENT_BEFORE_REPRICE",
            event.receivedTs,
            state.pendingSourceIds,
          ),
        ];
      }
      return this.#maybeReopen(state, event.receivedTs);
    }

    if (!firstObservation) return [];

    state.preTriggerQuote = state.quote;
    state.pendingTrigger = "EVENT_BEFORE_REPRICE";
    state.pendingSourceIds = [event.eventId];
    state.suspendedAt = event.receivedTs;
    state.stableUpdateCount = 0;
    state.candidateQuote = null;

    return [
      this.#transition(
        state,
        "SUSPENDED",
        "SUSPEND",
        "EVENT_BEFORE_REPRICE",
        event.receivedTs,
        [event.eventId],
      ),
    ];
  }

  #processEventResolution(
    state: FixtureGovernorState,
    resolution: Extract<GovernorInput, { kind: "event-resolution" }>,
  ): DecisionReceipt[] {
    state.pendingUnconfirmedIncidentIds =
      state.pendingUnconfirmedIncidentIds.filter(
        (incidentId) => incidentId !== resolution.incidentId,
      );
    if (state.mode !== "SUSPENDED" && state.mode !== "REPRICED") return [];
    state.pendingSourceIds = unique([
      ...state.pendingSourceIds,
      resolution.resolutionId,
    ]);
    return this.#maybeReopen(state, resolution.receivedTs);
  }

  #processHealth(input: Extract<GovernorInput, { kind: "stream-health" }>) {
    const receipts: DecisionReceipt[] = [];
    this.#streamHealth[input.stream] = input.healthy;
    for (const state of this.#fixtures.values()) {
      state.streamHealth[input.stream] = input.healthy;
      const bothHealthy = state.streamHealth.odds && state.streamHealth.scores;

      if (!input.healthy && state.mode !== "FAILSAFE") {
        state.bothStreamsHealthySince = null;
        state.pendingTrigger = "STREAM_UNHEALTHY";
        receipts.push(
          this.#transition(
            state,
            "FAILSAFE",
            "ENTER_FAILSAFE",
            "STREAM_UNHEALTHY",
            input.observedTs,
            [`${input.stream}:${input.reason ?? "unhealthy"}`],
          ),
        );
      } else if (bothHealthy && state.mode === "FAILSAFE") {
        state.bothStreamsHealthySince ??= input.observedTs;
      }
    }
    return receipts;
  }

  #processTick(observedTs: number): DecisionReceipt[] {
    const receipts: DecisionReceipt[] = [];
    for (const state of this.#fixtures.values()) {
      if (
        state.mode === "FAILSAFE" &&
        state.bothStreamsHealthySince !== null &&
        observedTs - state.bothStreamsHealthySince >=
          this.#config.recoveryStableMs
      ) {
        state.pendingTrigger = "STREAM_UNHEALTHY";
        state.suspendedAt = observedTs;
        state.stableUpdateCount = 0;
        state.candidateQuote = null;
        receipts.push(
          this.#transition(
            state,
            "SUSPENDED",
            "RECOVER_TO_SUSPENDED",
            "STREAM_UNHEALTHY",
            observedTs,
            ["odds:healthy", "scores:healthy"],
          ),
        );
      } else {
        receipts.push(...this.#maybeReopen(state, observedTs));
      }
    }
    return receipts;
  }

  #maybeReopen(
    state: FixtureGovernorState,
    observedTs: number,
  ): DecisionReceipt[] {
    if (
      state.mode !== "REPRICED" ||
      state.repricedAt === null ||
      state.pendingUnconfirmedIncidentIds.length > 0 ||
      observedTs - state.repricedAt < this.#config.reopenDelayMs
    ) {
      return [];
    }

    const receipt = this.#transition(
      state,
      "OPEN",
      "REOPEN",
      state.pendingTrigger ?? "VOLATILITY_SPIKE",
      observedTs,
      state.pendingSourceIds,
      state.quote ?? undefined,
    );
    state.pendingTrigger = null;
    state.pendingSourceIds = [];
    state.suspendedAt = null;
    state.repricedAt = null;
    state.stableUpdateCount = 0;
    state.candidateQuote = null;
    state.preTriggerQuote = null;
    state.pendingUnconfirmedIncidentIds = [];
    return [receipt];
  }

  #transition(
    state: FixtureGovernorState,
    toMode: GovernorMode,
    action: DecisionAction,
    trigger: TriggerCode,
    observedTs: number,
    sourceIds: string[],
    quote?: ConsensusQuote,
  ): DecisionReceipt {
    const fromMode = state.mode;
    state.mode = toMode;
    const body = {
      version: 1 as const,
      fixtureId: state.fixtureId,
      market: state.market,
      action,
      trigger,
      fromMode,
      toMode,
      observedTs,
      sourceIds: unique(sourceIds).sort(),
      ...(quote ? { quote: quote.probabilities } : {}),
      configHash: this.#configHash,
    };
    const receipt = { body, hash: sha256(body) };
    state.receipts.push(receipt);
    return receipt;
  }

  #state(fixtureId: FixtureId): FixtureGovernorState {
    const existing = this.#fixtures.get(fixtureId);
    if (existing) return existing;

    const streamsHealthy = this.#streamHealth.odds && this.#streamHealth.scores;
    const created: FixtureGovernorState = {
      fixtureId,
      market: "1X2",
      mode: streamsHealthy ? "OPEN" : "FAILSAFE",
      quote: null,
      preTriggerQuote: null,
      candidateQuote: null,
      stableUpdateCount: 0,
      suspendedAt: null,
      repricedAt: null,
      lastHighImpactEvent: null,
      seenEventIncidentIds: [],
      pendingUnconfirmedIncidentIds: [],
      pendingTrigger: streamsHealthy ? null : "STREAM_UNHEALTHY",
      pendingSourceIds: [],
      streamHealth: structuredClone(this.#streamHealth),
      bothStreamsHealthySince: null,
      receipts: [],
    };
    this.#fixtures.set(fixtureId, created);
    return created;
  }
}

function unique(values: string[]) {
  return [...new Set(values)];
}
