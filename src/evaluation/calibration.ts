import { maximumProbabilityMove } from "../domain/probability.js";
import type {
  ConsensusQuote,
  EventResolution,
  GovernorConfig,
  GovernorInput,
  MatchEvent,
} from "../domain/types.js";

export function calibratePolicy(
  inputs: GovernorInput[],
  policy: GovernorConfig,
) {
  const quotes = inputs.filter(
    (input): input is ConsensusQuote => input.kind === "quote",
  );
  const events = inputs.filter(
    (input): input is MatchEvent => input.kind === "match-event",
  );
  const resolutions = inputs.filter(
    (input): input is EventResolution => input.kind === "event-resolution",
  );

  const quoteCadenceMs = positiveDifferences(
    quotes.map((quote) => quote.receivedTs),
  );
  const quoteMoves = quotes
    .slice(1)
    .map((quote, index) =>
      maximumProbabilityMove(quotes[index]!.probabilities, quote.probabilities),
    );
  const incidents = new Map<
    string,
    { firstTs: number; confirmedTs: number | null; discardedTs: number | null }
  >();
  for (const event of events) {
    const incident = incidents.get(event.incidentId) ?? {
      firstTs: event.receivedTs,
      confirmedTs: null,
      discardedTs: null,
    };
    incident.firstTs = Math.min(incident.firstTs, event.receivedTs);
    if (event.confirmed) {
      incident.confirmedTs =
        incident.confirmedTs === null
          ? event.receivedTs
          : Math.min(incident.confirmedTs, event.receivedTs);
    }
    incidents.set(event.incidentId, incident);
  }
  for (const resolution of resolutions) {
    const incident = incidents.get(resolution.incidentId);
    if (incident) incident.discardedTs = resolution.receivedTs;
  }

  const confirmationDelays = [...incidents.values()]
    .filter((incident) => incident.confirmedTs !== null)
    .map((incident) => incident.confirmedTs! - incident.firstTs)
    .filter((delay) => delay >= 0);
  const resolvedIncidents = [...incidents.values()].filter(
    (incident) =>
      incident.confirmedTs !== null || incident.discardedTs !== null,
  ).length;

  return {
    status: "PROVISIONAL_CALIBRATION_ONLY" as const,
    policy,
    sample: {
      quotes: quotes.length,
      highImpactRecords: events.length,
      uniqueIncidents: incidents.size,
      resolvedIncidents,
      unresolvedIncidents: incidents.size - resolvedIncidents,
      discardRecords: resolutions.length,
    },
    quoteCadenceMs: distribution(quoteCadenceMs),
    consecutiveProbabilityMove: distribution(quoteMoves),
    confirmationDelayMs: distribution(confirmationDelays),
    stability: {
      epsilon: policy.stabilityEpsilon,
      updatesAtOrBelowEpsilon: quoteMoves.filter(
        (move) => move <= policy.stabilityEpsilon,
      ).length,
      shareAtOrBelowEpsilon:
        quoteMoves.length === 0
          ? null
          : quoteMoves.filter((move) => move <= policy.stabilityEpsilon)
              .length / quoteMoves.length,
    },
  };
}

function positiveDifferences(values: number[]) {
  return values
    .slice(1)
    .map((value, index) => value - values[index]!)
    .filter((difference) => difference > 0);
}

function distribution(values: number[]) {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    count: sorted.length,
    min: sorted[0] ?? null,
    p50: quantile(sorted, 0.5),
    p90: quantile(sorted, 0.9),
    p95: quantile(sorted, 0.95),
    p99: quantile(sorted, 0.99),
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
