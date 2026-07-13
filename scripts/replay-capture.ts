import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

import { QuoteGovernor } from "../src/domain/governor.js";
import type { DecisionReceipt } from "../src/domain/types.js";
import { writePrivateCapture } from "../src/private/capture-store.js";
import { completeLifecycles } from "../src/replay/lifecycles.js";
import {
  buildReplayInputs,
  inputTimestamp,
  type PrivateTxLineCapture,
} from "../src/replay/txline-capture.js";

const fixtureId = readIntegerArgument("--fixture");
const capturePath = await findCapturePath(fixtureId);
const capture = JSON.parse(
  await readFile(capturePath, "utf8"),
) as PrivateTxLineCapture;
if (capture.fixtureId !== fixtureId) {
  throw new Error("Capture fixture ID does not match the requested fixture");
}

const { quotes, events, resolutions, inputs } = buildReplayInputs(capture);

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
const reopenProofs = governor.getReopenProofs(fixtureId);
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
  reopenProofCount: reopenProofs.length,
  lifecycles,
  receipts,
  reopenProofs,
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
      reopenProofCount: reopenProofs.length,
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
