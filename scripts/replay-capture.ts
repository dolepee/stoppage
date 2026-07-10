import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

import { QuoteGovernor } from "../src/domain/governor.js";
import { maximumProbabilityMove } from "../src/domain/probability.js";
import type {
  ConsensusQuote,
  DecisionReceipt,
  GovernorInput,
  MatchEvent,
} from "../src/domain/types.js";
import { writePrivateCapture } from "../src/private/capture-store.js";
import {
  normalize1x2Quote,
  normalizeEventResolution,
  normalizeMatchEvent,
} from "../src/txline/normalize.js";
import { oddsPayloadSchema, scorePayloadSchema } from "../src/txline/types.js";

const fixtureId = readIntegerArgument("--fixture");
const capturePath = await findCapturePath(fixtureId);
const capture = JSON.parse(await readFile(capturePath, "utf8")) as {
  fixtureId: number;
  scores: unknown[];
  odds: unknown[];
};
if (capture.fixtureId !== fixtureId) {
  throw new Error("Capture fixture ID does not match the requested fixture");
}

const scores = capture.scores.map((score) => scorePayloadSchema.parse(score));
const odds = capture.odds.map((quote) => oddsPayloadSchema.parse(quote));
const participant1IsHome =
  (scores[0] as Record<string, unknown> | undefined)?.["Participant1IsHome"] !==
  false;
const participants = participant1IsHome
  ? { home: "part1", away: "part2" }
  : { home: "part2", away: "part1" };

const quoteIds = new Set<string>();
const quotes = odds
  .filter(
    (quote) =>
      quote.SuperOddsType === "1X2_PARTICIPANT_RESULT" &&
      quote.InRunning &&
      quote.MarketPeriod == null,
  )
  .filter((quote) => {
    if (quoteIds.has(quote.MessageId)) return false;
    quoteIds.add(quote.MessageId);
    return true;
  })
  .map((quote) => normalize1x2Quote(quote, participants, quote.Ts))
  .filter((quote) => quote !== null);

const events = scores
  .map((score) => normalizeMatchEvent(score, score.ts))
  .filter((event) => event !== null);
const resolutions = scores
  .map((score) => normalizeEventResolution(score, score.ts))
  .filter((resolution) => resolution !== null);
const inputs: GovernorInput[] = [...quotes, ...events, ...resolutions].sort(
  (left, right) => {
    const timeDifference = inputTimestamp(left) - inputTimestamp(right);
    if (timeDifference !== 0) return timeDifference;
    if (left.kind === right.kind) return 0;
    return left.kind === "match-event" ? -1 : 1;
  },
);

const governor = new QuoteGovernor();
const receipts: DecisionReceipt[] = [];
for (const input of inputs) receipts.push(...governor.process(input));
if (inputs.length) {
  receipts.push(
    ...governor.process({
      kind: "tick",
      observedTs: inputTimestamp(inputs.at(-1)!) + 60_000,
    }),
  );
}

const lifecycles = completeLifecycles(receipts, inputs);
const strongestLifecycle = [...lifecycles].sort(
  (left, right) =>
    (right.maximumProbabilityMove ?? -1) - (left.maximumProbabilityMove ?? -1),
)[0];
const replayResult = {
  version: 1,
  dataMode: "TXLINE_REPLAY",
  timingMode: "SOURCE_TIMESTAMP_ORDER",
  fixtureId,
  sourceCapture: basename(capturePath),
  configHash: governor.configHash,
  normalizedQuotes: quotes.length,
  normalizedHighImpactEvents: events.length,
  normalizedEventResolutions: resolutions.length,
  receiptCount: receipts.length,
  lifecycles,
  receipts,
};
const output = await writePrivateCapture(
  `replay-${fixtureId}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
  replayResult,
);

console.log(
  JSON.stringify(
    {
      ok: lifecycles.length > 0,
      g2LifecycleComplete: lifecycles.length > 0,
      dataMode: replayResult.dataMode,
      timingMode: replayResult.timingMode,
      fixtureId,
      normalizedQuotes: quotes.length,
      normalizedHighImpactEvents: events.length,
      normalizedEventResolutions: resolutions.length,
      receiptCount: receipts.length,
      actionCounts: countBy(receipts, (receipt) => receipt.body.action),
      triggerCounts: countBy(receipts, (receipt) => receipt.body.trigger),
      completeLifecycles: lifecycles.length,
      firstLifecycle: lifecycles[0] ?? null,
      strongestLifecycle: strongestLifecycle ?? null,
      configHash: governor.configHash,
      privateReplay: output,
    },
    null,
    2,
  ),
);

function completeLifecycles(
  receipts: DecisionReceipt[],
  inputs: GovernorInput[],
) {
  const quoteInputs = inputs.filter(
    (input): input is ConsensusQuote => input.kind === "quote",
  );
  const eventInputs = new Map(
    inputs
      .filter((input): input is MatchEvent => input.kind === "match-event")
      .map((event) => [event.eventId, event]),
  );
  const completed: Array<{
    trigger: string;
    eventType: string | null;
    sourceEventId: string | null;
    suspendTs: number;
    repriceTs: number;
    reopenTs: number;
    suspensionMs: number;
    repriceToReopenMs: number;
    maximumProbabilityMove: number | null;
    suspendHash: string;
    repriceHash: string;
    reopenHash: string;
  }> = [];
  let suspended: DecisionReceipt | null = null;
  let repriced: DecisionReceipt | null = null;

  for (const receipt of receipts) {
    if (receipt.body.action === "SUSPEND") {
      suspended = receipt;
      repriced = null;
    } else if (receipt.body.action === "REPRICE" && suspended) {
      repriced = receipt;
    } else if (receipt.body.action === "REOPEN" && suspended && repriced) {
      const sourceEventId =
        suspended.body.sourceIds.find((sourceId) =>
          eventInputs.has(sourceId),
        ) ?? null;
      const event = sourceEventId ? eventInputs.get(sourceEventId) : undefined;
      const preTriggerQuote = [...quoteInputs]
        .reverse()
        .find((quote) => quote.receivedTs <= suspended!.body.observedTs);
      const probabilityMove =
        preTriggerQuote && repriced.body.quote
          ? maximumProbabilityMove(
              preTriggerQuote.probabilities,
              repriced.body.quote,
            )
          : null;
      completed.push({
        trigger: suspended.body.trigger,
        eventType: event?.eventType ?? null,
        sourceEventId,
        suspendTs: suspended.body.observedTs,
        repriceTs: repriced.body.observedTs,
        reopenTs: receipt.body.observedTs,
        suspensionMs: receipt.body.observedTs - suspended.body.observedTs,
        repriceToReopenMs: receipt.body.observedTs - repriced.body.observedTs,
        maximumProbabilityMove: probabilityMove,
        suspendHash: suspended.hash,
        repriceHash: repriced.hash,
        reopenHash: receipt.hash,
      });
      suspended = null;
      repriced = null;
    }
  }
  return completed;
}

function countBy<T>(values: T[], key: (value: T) => string) {
  return Object.fromEntries(
    Object.entries(
      values.reduce<Record<string, number>>((counts, value) => {
        const name = key(value);
        counts[name] = (counts[name] ?? 0) + 1;
        return counts;
      }, {}),
    ).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function inputTimestamp(input: GovernorInput) {
  return input.kind === "quote" ||
    input.kind === "match-event" ||
    input.kind === "event-resolution"
    ? input.receivedTs
    : input.observedTs;
}

async function findCapturePath(id: number) {
  const { readdir } = await import("node:fs/promises");
  const root = resolve("data/private");
  const files = (await readdir(root))
    .filter(
      (name) => name.startsWith(`fixture-${id}-`) && name.endsWith(".json"),
    )
    .sort();
  const latest = files.at(-1);
  if (!latest) throw new Error(`No private capture found for fixture ${id}`);
  return resolve(root, latest);
}

function readIntegerArgument(name: string): number {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? Number(process.argv[index + 1]) : Number.NaN;
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Usage: pnpm g2:replay -- --fixture <positive fixture id>`);
  }
  return value;
}
