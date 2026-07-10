import { readFile, readdir } from "node:fs/promises";
import { basename, resolve } from "node:path";

import {
  DEFAULT_GOVERNOR_CONFIG,
  QuoteGovernor,
} from "../src/domain/governor.js";
import { evaluateHoldout } from "../src/evaluation/holdout.js";
import { writePrivateCapture } from "../src/private/capture-store.js";
import {
  buildReplayInputs,
  type PrivateTxLineCapture,
} from "../src/replay/txline-capture.js";

const fixtureIds = readFixtureArguments();
const approvedConfigHash = readStringArgument("--approved-config-hash");
const expectedConfigHash = new QuoteGovernor(DEFAULT_GOVERNOR_CONFIG)
  .configHash;
if (approvedConfigHash !== expectedConfigHash) {
  throw new Error(
    `Approved config hash does not match the frozen policy: ${expectedConfigHash}`,
  );
}

const fixtures = [];
for (const fixtureId of fixtureIds) {
  const capturePath = await findLatestCapture(fixtureId);
  const capture = JSON.parse(
    await readFile(capturePath, "utf8"),
  ) as PrivateTxLineCapture;
  const evaluation = evaluateHoldout(
    buildReplayInputs(capture).inputs,
    DEFAULT_GOVERNOR_CONFIG,
  );
  fixtures.push({
    fixtureId,
    sourceCapture: basename(capturePath),
    ...evaluation,
  });
}

const report = {
  version: 1,
  status: "AWAITING_PUBLIC_CLAIM_APPROVAL",
  network: "solana-mainnet",
  approvedConfigHash,
  evaluatedAt: new Date().toISOString(),
  fixtures,
  aggregate: {
    fixtures: fixtures.length,
    completeProtectedWindows: sum(
      fixtures.map((fixture) => fixture.sample.completeProtectedWindows),
    ),
    staleQuoteSeconds: sum(
      fixtures.map((fixture) => fixture.metrics.staleQuoteSeconds),
    ),
    mispricingIntegral: sum(
      fixtures.map((fixture) => fixture.metrics.mispricingIntegral),
    ),
    eventSuspensions: sum(
      fixtures.map((fixture) => fixture.metrics.eventSuspensions),
    ),
    unconfirmedEventSuspensions: sum(
      fixtures.map((fixture) => fixture.metrics.unconfirmedEventSuspensions),
    ),
  },
};
const output = await writePrivateCapture(
  `holdout-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
  report,
);

console.log(
  JSON.stringify(
    {
      ok: true,
      status: report.status,
      approvedConfigHash,
      aggregate: report.aggregate,
      privateReport: output,
      publicClaimApprovalRequired: true,
    },
    null,
    2,
  ),
);

async function findLatestCapture(fixtureId: number) {
  const root = resolve("data/private");
  const latest = (await readdir(root))
    .filter(
      (name) =>
        name.startsWith(`fixture-${fixtureId}-`) && name.endsWith(".json"),
    )
    .sort()
    .at(-1);
  if (!latest) throw new Error(`No capture found for fixture ${fixtureId}`);
  return resolve(root, latest);
}

function readFixtureArguments() {
  const fixtures = process.argv.flatMap((value, index) =>
    value === "--fixture" ? [Number(process.argv[index + 1])] : [],
  );
  if (
    fixtures.length < 2 ||
    fixtures.some((fixture) => !Number.isInteger(fixture) || fixture <= 0)
  ) {
    throw new Error("Provide at least two positive --fixture values");
  }
  return [...new Set(fixtures)];
}

function readStringArgument(name: string) {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value || !/^0x[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${name} requires a lowercase 32-byte hash`);
  }
  return value;
}

function sum(values: number[]) {
  return values.reduce((total, value) => total + value, 0);
}
