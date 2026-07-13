import { QuoteGovernor } from "../domain/governor.js";
import { evaluateSuspendedWindow } from "../domain/metrics.js";
import { maximumProbabilityMove } from "../domain/probability.js";
import type {
  ConsensusQuote,
  DecisionReceipt,
  GovernorConfig,
  GovernorInput,
  ProbabilityVector,
  TriggerCode,
} from "../domain/types.js";

const horizonsMs = [5_000, 15_000, 30_000, 60_000] as const;

interface ActiveWindow {
  startedAt: number;
  segmentStartedAt: number;
  segments: Array<{
    startTs: number;
    endTs: number;
    baselineProbability: ProbabilityVector;
  }>;
  initialTrigger: TriggerCode;
  provisionalEventAtSuspend: boolean;
  suspendHash: string;
  repriceReceipt: DecisionReceipt | null;
}

export interface HoldoutWindow {
  initialTrigger: TriggerCode;
  finalTrigger: TriggerCode;
  staleQuoteSeconds: number;
  mispricingIntegral: number;
  maximumProbabilityDivergence: number;
  reopenLatencyMs: number;
  provisionalEventAtSuspend: boolean;
  repricingError: Record<string, number | null>;
  suspendHash: string;
  repriceHash: string;
  reopenHash: string;
}

export function evaluateHoldout(
  inputs: GovernorInput[],
  config: GovernorConfig,
) {
  const orderedInputs = [...inputs].sort(compareInputs);
  const quotes = orderedInputs.filter(
    (input): input is ConsensusQuote => input.kind === "quote",
  );
  const governor = new QuoteGovernor(config);
  const windows: HoldoutWindow[] = [];
  const receipts: DecisionReceipt[] = [];
  let baselineQuote: ConsensusQuote | null = null;
  let activeWindow: ActiveWindow | null = null;

  const processInput = (input: GovernorInput) => {
    const timestamp = inputTimestamp(input);
    if (input.kind === "quote") {
      if (activeWindow) {
        if (baselineQuote && timestamp > activeWindow.segmentStartedAt) {
          activeWindow.segments.push({
            startTs: activeWindow.segmentStartedAt,
            endTs: timestamp,
            baselineProbability: baselineQuote.probabilities,
          });
        }
        activeWindow.segmentStartedAt = timestamp;
      }
      baselineQuote = input;
    }

    const emitted = governor.process(input);
    receipts.push(...emitted);
    for (const receipt of emitted) {
      if (
        receipt.body.action === "SUSPEND" ||
        receipt.body.action === "ENTER_FAILSAFE"
      ) {
        if (!activeWindow) {
          const eventTriggered = input.kind === "match-event";
          activeWindow = {
            startedAt: receipt.body.observedTs,
            segmentStartedAt: receipt.body.observedTs,
            segments: [],
            initialTrigger: receipt.body.trigger,
            provisionalEventAtSuspend: eventTriggered && !input.confirmed,
            suspendHash: receipt.hash,
            repriceReceipt: null,
          };
        }
        continue;
      }

      if (receipt.body.action === "REPRICE" && activeWindow) {
        activeWindow.repriceReceipt = receipt;
        continue;
      }

      if (receipt.body.action !== "REOPEN" || !activeWindow) continue;
      const repriceReceipt = activeWindow.repriceReceipt;
      const stableReference = repriceReceipt?.body.quote;
      const reopenQuote = receipt.body.quote;
      if (
        !baselineQuote ||
        !repriceReceipt ||
        !stableReference ||
        !reopenQuote
      ) {
        throw new Error("Complete holdout window lacks a quote-backed reprice");
      }
      if (receipt.body.observedTs > activeWindow.segmentStartedAt) {
        activeWindow.segments.push({
          startTs: activeWindow.segmentStartedAt,
          endTs: receipt.body.observedTs,
          baselineProbability: baselineQuote.probabilities,
        });
      }
      const evaluated = evaluateSuspendedWindow(
        activeWindow.segments,
        stableReference,
      );
      windows.push({
        initialTrigger: activeWindow.initialTrigger,
        finalTrigger: repriceReceipt.body.trigger,
        ...evaluated,
        reopenLatencyMs: receipt.body.observedTs - activeWindow.startedAt,
        provisionalEventAtSuspend: activeWindow.provisionalEventAtSuspend,
        repricingError: Object.fromEntries(
          horizonsMs.map((horizon) => [
            String(horizon),
            errorAtHorizon(
              quotes,
              receipt.body.observedTs,
              horizon,
              reopenQuote,
            ),
          ]),
        ),
        suspendHash: activeWindow.suspendHash,
        repriceHash: repriceReceipt.hash,
        reopenHash: receipt.hash,
      });
      activeWindow = null;
    }
  };

  for (const input of orderedInputs) processInput(input);
  if (orderedInputs.length) {
    processInput({
      kind: "tick",
      observedTs: inputTimestamp(orderedInputs.at(-1)!) + 60_000,
    });
  }

  const reopenProofs = [...fixtureIds(orderedInputs)].flatMap((fixtureId) =>
    governor.getReopenProofs(fixtureId),
  );
  const postResolutionChecks = reopenProofs.flatMap((proof) => {
    if (proof.body.version !== 2) return [];
    const checks = proof.body.checks;
    return checks.freshQuoteRequired &&
      checks.freshQuoteObserved &&
      checks.resolutionOutcome !== "NOT_REQUIRED"
      ? [checks]
      : [];
  });

  const horizonMetrics = Object.fromEntries(
    horizonsMs.map((horizon) => {
      const values = windows
        .map((window) => window.repricingError[String(horizon)])
        .filter((value): value is number => value !== null);
      return [
        String(horizon),
        {
          observed: values.length,
          coverage: windows.length ? values.length / windows.length : null,
          error: distribution(values),
        },
      ];
    }),
  );

  const eventLedProtectedWindows = windows.filter(
    (window) => window.initialTrigger === "EVENT_BEFORE_REPRICE",
  ).length;
  const oddsLedProtectedWindows = windows.filter(
    (window) => window.initialTrigger === "UNBACKED_MOVE",
  );
  const unconfirmedOddsLedProtectedWindows = oddsLedProtectedWindows.filter(
    (window) => window.finalTrigger === "UNBACKED_MOVE",
  ).length;
  const confirmedOddsLedProtectedWindows = oddsLedProtectedWindows.filter(
    (window) => window.finalTrigger === "EVENT_CONFIRMED_MOVE",
  ).length;
  const failsafeProtectedWindows = windows.filter(
    (window) => window.initialTrigger === "STREAM_UNHEALTHY",
  ).length;
  const provisionalEventProtectedWindows = windows.filter(
    (window) => window.provisionalEventAtSuspend,
  ).length;

  return {
    status: "PRIVATE_HOLDOUT_EVALUATION" as const,
    configHash: governor.configHash,
    sample: {
      inputs: orderedInputs.length,
      quotes: quotes.length,
      receipts: receipts.length,
      completeProtectedWindows: windows.length,
      incompleteProtectedWindow: activeWindow !== null,
    },
    metrics: {
      staleQuoteSeconds: sum(windows.map((window) => window.staleQuoteSeconds)),
      mispricingIntegral: sum(
        windows.map((window) => window.mispricingIntegral),
      ),
      maximumProbabilityDivergence: windows.length
        ? Math.max(
            ...windows.map((window) => window.maximumProbabilityDivergence),
          )
        : null,
      reopenLatencyMs: distribution(
        windows.map((window) => window.reopenLatencyMs),
      ),
      eventLedProtectedWindows,
      oddsLedProtectedWindows: oddsLedProtectedWindows.length,
      confirmedOddsLedProtectedWindows,
      unconfirmedOddsLedProtectedWindows,
      unconfirmedOddsLedSuspensionRate:
        oddsLedProtectedWindows.length === 0
          ? null
          : unconfirmedOddsLedProtectedWindows / oddsLedProtectedWindows.length,
      failsafeProtectedWindows,
      provisionalEventProtectedWindows,
      preResolutionRepricesInvalidated: receipts.filter(
        (receipt) => receipt.body.action === "INVALIDATE_REPRICE",
      ).length,
      postResolutionCertifiedReopens: postResolutionChecks.length,
      confirmedResolutionCertifiedReopens: postResolutionChecks.filter(
        (checks) => checks.resolutionOutcome === "CONFIRMED",
      ).length,
      discardedResolutionCertifiedReopens: postResolutionChecks.filter(
        (checks) => checks.resolutionOutcome === "DISCARDED",
      ).length,
      repricingError: horizonMetrics,
    },
    windows,
  };
}

function fixtureIds(inputs: GovernorInput[]) {
  return new Set(
    inputs.flatMap((input) =>
      input.kind === "quote" ||
      input.kind === "match-event" ||
      input.kind === "event-resolution"
        ? [input.fixtureId]
        : [],
    ),
  );
}

function errorAtHorizon(
  quotes: ConsensusQuote[],
  reopenedAt: number,
  horizonMs: number,
  reopenQuote: ProbabilityVector,
) {
  const comparison = quotes.find(
    (quote) => quote.receivedTs >= reopenedAt + horizonMs,
  );
  return comparison
    ? maximumProbabilityMove(reopenQuote, comparison.probabilities)
    : null;
}

function compareInputs(left: GovernorInput, right: GovernorInput) {
  const difference = inputTimestamp(left) - inputTimestamp(right);
  if (difference !== 0) return difference;
  if (left.kind === right.kind) return 0;
  return left.kind === "match-event" ? -1 : 1;
}

function inputTimestamp(input: GovernorInput) {
  return input.kind === "quote" ||
    input.kind === "match-event" ||
    input.kind === "event-resolution"
    ? input.receivedTs
    : input.observedTs;
}

function distribution(values: number[]) {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    count: sorted.length,
    min: sorted[0] ?? null,
    p50: quantile(sorted, 0.5),
    p90: quantile(sorted, 0.9),
    p95: quantile(sorted, 0.95),
    max: sorted.at(-1) ?? null,
  };
}

function quantile(sorted: number[], probability: number) {
  if (!sorted.length) return null;
  const index = (sorted.length - 1) * probability;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower]!;
  const weight = index - lower;
  return sorted[lower]! * (1 - weight) + sorted[upper]! * weight;
}

function sum(values: number[]) {
  return values.reduce((total, value) => total + value, 0);
}
