import { sha256 } from "./canonical.js";
import {
  assertProbabilityVector,
  maximumProbabilityMove,
} from "./probability.js";
import { createReopenProof } from "./reopen-proof.js";
import type {
  ConsensusQuote,
  DecisionAction,
  DecisionReceipt,
  FixtureGovernorState,
  FixtureId,
  GovernorConfig,
  GovernorInput,
  GovernorMode,
  IncidentResolutionOutcome,
  MatchEvent,
  ReopenProof,
  TriggerCode,
} from "./types.js";

export const APPROVED_GOVERNOR_CONFIG_V1: GovernorConfig = {
  sharpMoveThreshold: 0.04,
  stabilityEpsilon: 0.006,
  stableUpdatesRequired: 3,
  reopenDelayMs: 5_000,
  eventConfirmationWindowMs: 30_000,
  recoveryStableMs: 5_000,
};

export const DEFAULT_GOVERNOR_CONFIG: GovernorConfig = {
  ...APPROVED_GOVERNOR_CONFIG_V1,
  postResolutionFreshQuotesRequired: true,
};

export class QuoteGovernor {
  readonly #config: GovernorConfig;
  readonly #configHash: string;
  readonly #fixtures = new Map<FixtureId, FixtureGovernorState>();
  readonly #reopenProofs = new Map<FixtureId, ReopenProof[]>();
  readonly #streamHealth = { odds: true, scores: true };

  constructor(config: GovernorConfig = DEFAULT_GOVERNOR_CONFIG) {
    validateConfig(config);
    this.#config = structuredClone(config);
    this.#configHash = sha256(this.#config);
  }

  get configHash() {
    return this.#configHash;
  }

  getState(fixtureId: FixtureId): Readonly<FixtureGovernorState> {
    return structuredClone(this.#state(fixtureId));
  }

  getReopenProofs(fixtureId: FixtureId): readonly ReopenProof[] {
    return structuredClone(this.#reopenProofs.get(fixtureId) ?? []);
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
      const eventAge = state.lastHighImpactEvent
        ? quote.receivedTs - state.lastHighImpactEvent.receivedTs
        : null;
      const eventSupportsMove =
        eventAge !== null &&
        eventAge >= 0 &&
        eventAge <= this.#config.eventConfirmationWindowMs;

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

    if (
      this.#requiresResolutionFreshness() &&
      state.lastIncidentResolution &&
      !quoteFollowsResolution(quote, state.lastIncidentResolution)
    ) {
      return [];
    }

    const previousCandidate = state.candidateQuote;
    state.quote = quote;
    state.candidateQuote = quote;
    state.pendingSourceIds = unique([
      ...state.pendingSourceIds,
      quote.messageId,
    ]);
    if (state.lastIncidentResolution) {
      state.firstPostResolutionQuoteSourceTs ??= quote.sourceTs;
      state.firstPostResolutionQuoteTs ??= quote.receivedTs;
      state.postResolutionQuoteCount += 1;
    }

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
    const wasPending = state.pendingUnconfirmedIncidentIds.includes(
      event.incidentId,
    );
    if (firstObservation) state.seenEventIncidentIds.push(event.incidentId);
    if (event.confirmed) {
      state.pendingUnconfirmedIncidentIds =
        state.pendingUnconfirmedIncidentIds.filter(
          (incidentId) => incidentId !== event.incidentId,
        );
    }

    const quotePredatesEvent =
      state.quote === null || state.quote.sourceTs < event.sourceTs;
    const incidentAffectsCurrentState =
      state.mode === "FAILSAFE" ||
      state.mode === "SUSPENDED" ||
      state.mode === "REPRICED" ||
      (state.mode === "OPEN" && firstObservation && quotePredatesEvent);
    if (
      !event.confirmed &&
      incidentAffectsCurrentState &&
      !state.pendingUnconfirmedIncidentIds.includes(event.incidentId)
    ) {
      state.pendingUnconfirmedIncidentIds.push(event.incidentId);
    }

    const resolutionReceipts =
      event.confirmed &&
      incidentAffectsCurrentState &&
      (firstObservation || wasPending)
        ? this.#recordIncidentResolution(
            state,
            event.incidentId,
            "CONFIRMED",
            event.eventId,
            event.sourceTs,
            event.receivedTs,
          )
        : [];
    if (state.mode === "FAILSAFE") return resolutionReceipts;

    if (state.mode === "SUSPENDED" || state.mode === "REPRICED") {
      state.pendingSourceIds = unique([
        ...state.pendingSourceIds,
        event.eventId,
      ]);
      if (state.pendingTrigger === "UNBACKED_MOVE" && event.confirmed) {
        state.pendingTrigger = "EVENT_CONFIRMED_MOVE";
      }
      if (resolutionReceipts.length) return resolutionReceipts;
      if (firstObservation) {
        state.stableUpdateCount = 0;
        state.candidateQuote = null;
        if (state.pendingTrigger !== "EVENT_CONFIRMED_MOVE") {
          state.pendingTrigger = "EVENT_BEFORE_REPRICE";
        }
        if (state.mode === "REPRICED") {
          state.suspendedAt = event.receivedTs;
          state.repricedAt = null;
          return [
            this.#transition(
              state,
              "SUSPENDED",
              "SUSPEND",
              state.pendingTrigger,
              event.receivedTs,
              state.pendingSourceIds,
            ),
          ];
        }
      }
      return this.#maybeReopen(state, event.receivedTs);
    }

    if (!firstObservation || !quotePredatesEvent) return [];

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
    if (!state.pendingUnconfirmedIncidentIds.includes(resolution.incidentId)) {
      return [];
    }
    state.pendingUnconfirmedIncidentIds =
      state.pendingUnconfirmedIncidentIds.filter(
        (incidentId) => incidentId !== resolution.incidentId,
      );
    state.pendingSourceIds = unique([
      ...state.pendingSourceIds,
      resolution.resolutionId,
    ]);
    if (this.#requiresResolutionFreshness()) {
      return this.#recordIncidentResolution(
        state,
        resolution.incidentId,
        "DISCARDED",
        resolution.resolutionId,
        resolution.sourceTs,
        resolution.receivedTs,
      );
    }
    if (state.mode !== "SUSPENDED" && state.mode !== "REPRICED") return [];
    return this.#maybeReopen(state, resolution.receivedTs);
  }

  #recordIncidentResolution(
    state: FixtureGovernorState,
    incidentId: string,
    outcome: IncidentResolutionOutcome,
    resolutionId: string,
    sourceTs: number,
    observedTs: number,
  ): DecisionReceipt[] {
    if (!this.#requiresResolutionFreshness()) return [];

    state.lastIncidentResolution = {
      incidentId,
      outcome,
      resolutionId,
      sourceTs,
      observedTs,
    };
    state.firstPostResolutionQuoteSourceTs = null;
    state.firstPostResolutionQuoteTs = null;
    state.postResolutionQuoteCount = 0;
    state.stableUpdateCount = 0;
    state.candidateQuote = null;
    state.repricedAt = null;
    state.pendingSourceIds = unique([...state.pendingSourceIds, resolutionId]);

    if (state.mode !== "REPRICED") return [];
    return [
      this.#transition(
        state,
        "SUSPENDED",
        "INVALIDATE_REPRICE",
        outcome === "CONFIRMED"
          ? "RESOLUTION_CONFIRMED"
          : "RESOLUTION_DISCARDED",
        observedTs,
        state.pendingSourceIds,
      ),
    ];
  }

  #processHealth(input: Extract<GovernorInput, { kind: "stream-health" }>) {
    const receipts: DecisionReceipt[] = [];
    this.#streamHealth[input.stream] = input.healthy;
    for (const state of this.#fixtures.values()) {
      state.streamHealth[input.stream] = input.healthy;
      const bothHealthy = state.streamHealth.odds && state.streamHealth.scores;

      if (!input.healthy) {
        state.bothStreamsHealthySince = null;
        if (state.mode !== "FAILSAFE") {
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
        }
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
    const oddsStreamHealthy = state.streamHealth.odds;
    const scoresStreamHealthy = state.streamHealth.scores;
    const unresolvedIncidentCount = state.pendingUnconfirmedIncidentIds.length;
    const stableUpdatesObserved = state.stableUpdateCount;
    const quotePresent = state.quote !== null;
    const resolutionFreshnessRequired =
      this.#requiresResolutionFreshness() &&
      state.lastIncidentResolution !== null;
    const freshQuoteObserved =
      !resolutionFreshnessRequired ||
      (state.firstPostResolutionQuoteTs !== null &&
        state.postResolutionQuoteCount >= this.#config.stableUpdatesRequired);
    if (
      state.mode !== "REPRICED" ||
      state.repricedAt === null ||
      !oddsStreamHealthy ||
      !scoresStreamHealthy ||
      unresolvedIncidentCount !== 0 ||
      stableUpdatesObserved < this.#config.stableUpdatesRequired ||
      !quotePresent ||
      !freshQuoteObserved ||
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
    const commonProof = {
      kind: "CERTIFIED_REOPEN",
      fixtureId: state.fixtureId,
      market: state.market,
      reopenReceiptHash: receipt.hash,
      configHash: this.#configHash,
      observedTs,
      checks: {
        oddsStreamHealthy,
        scoresStreamHealthy,
        unresolvedIncidentCount,
        stableUpdatesObserved,
        stableUpdatesRequired: this.#config.stableUpdatesRequired,
        repriceAgeMs: observedTs - state.repricedAt,
        reopenDelayMs: this.#config.reopenDelayMs,
        quotePresent,
      },
    } as const;
    const proof = this.#requiresResolutionFreshness()
      ? createReopenProof({
          ...commonProof,
          version: 2,
          checks: {
            ...commonProof.checks,
            policyRevision: 2,
            resolutionOutcome:
              state.lastIncidentResolution?.outcome ?? "NOT_REQUIRED",
            resolutionSourceTs: state.lastIncidentResolution?.sourceTs ?? null,
            resolutionObservedTs:
              state.lastIncidentResolution?.observedTs ?? null,
            firstPostResolutionQuoteSourceTs:
              state.firstPostResolutionQuoteSourceTs,
            firstPostResolutionQuoteTs: state.firstPostResolutionQuoteTs,
            postResolutionQuoteCount: state.postResolutionQuoteCount,
            freshQuoteRequired: resolutionFreshnessRequired,
            freshQuoteObserved,
          },
        })
      : createReopenProof({ ...commonProof, version: 1 });
    const proofs = this.#reopenProofs.get(state.fixtureId) ?? [];
    proofs.push(proof);
    this.#reopenProofs.set(state.fixtureId, proofs);
    state.pendingTrigger = null;
    state.pendingSourceIds = [];
    state.suspendedAt = null;
    state.repricedAt = null;
    state.stableUpdateCount = 0;
    state.candidateQuote = null;
    state.preTriggerQuote = null;
    state.pendingUnconfirmedIncidentIds = [];
    state.lastIncidentResolution = null;
    state.firstPostResolutionQuoteSourceTs = null;
    state.firstPostResolutionQuoteTs = null;
    state.postResolutionQuoteCount = 0;
    return [receipt];
  }

  #requiresResolutionFreshness() {
    return this.#config.postResolutionFreshQuotesRequired === true;
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
      lastIncidentResolution: null,
      firstPostResolutionQuoteSourceTs: null,
      firstPostResolutionQuoteTs: null,
      postResolutionQuoteCount: 0,
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

function validateConfig(config: GovernorConfig) {
  if (
    !Number.isFinite(config.sharpMoveThreshold) ||
    config.sharpMoveThreshold <= 0 ||
    config.sharpMoveThreshold > 1
  ) {
    throw new Error("sharpMoveThreshold must be greater than 0 and at most 1");
  }
  if (
    !Number.isFinite(config.stabilityEpsilon) ||
    config.stabilityEpsilon < 0 ||
    config.stabilityEpsilon >= config.sharpMoveThreshold
  ) {
    throw new Error(
      "stabilityEpsilon must be non-negative and below sharpMoveThreshold",
    );
  }
  if (
    !Number.isInteger(config.stableUpdatesRequired) ||
    config.stableUpdatesRequired < 2
  ) {
    throw new Error("stableUpdatesRequired must be an integer of at least 2");
  }
  for (const [name, value] of [
    ["reopenDelayMs", config.reopenDelayMs],
    ["eventConfirmationWindowMs", config.eventConfirmationWindowMs],
    ["recoveryStableMs", config.recoveryStableMs],
  ] as const) {
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`${name} must be a non-negative integer`);
    }
  }
  if (
    config.postResolutionFreshQuotesRequired !== undefined &&
    typeof config.postResolutionFreshQuotesRequired !== "boolean"
  ) {
    throw new Error("postResolutionFreshQuotesRequired must be boolean");
  }
}

function quoteFollowsResolution(
  quote: ConsensusQuote,
  resolution: FixtureGovernorState["lastIncidentResolution"],
) {
  if (!resolution) return true;
  return (
    quote.sourceTs > resolution.sourceTs &&
    quote.receivedTs > resolution.observedTs
  );
}
