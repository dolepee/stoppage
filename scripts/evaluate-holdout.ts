import { readFile, readdir } from "node:fs/promises";
import { basename, resolve } from "node:path";

import {
  DEFAULT_GOVERNOR_CONFIG,
  QuoteGovernor,
} from "../src/domain/governor.js";
import { evaluateHoldout } from "../src/evaluation/holdout.js";
import { validatePublicFeaturedMatchLabel } from "../src/evidence/public-claim.js";
import { writePrivateCapture } from "../src/private/capture-store.js";
import {
  buildReplayInputs,
  type PrivateTxLineCapture,
} from "../src/replay/txline-capture.js";

const fixtureIds = readFixtureArguments();
const approvedConfigHash = readStringArgument("--approved-config-hash");
const featuredFixtureId = readOptionalIntegerArgument("--featured-fixture");
const featuredLabelArgument = readOptionalStringArgument("--featured-label");
const featuredLabel =
  featuredLabelArgument === null
    ? null
    : validatePublicFeaturedMatchLabel(featuredLabelArgument);
if ((featuredFixtureId === null) !== (featuredLabel === null)) {
  throw new Error(
    "--featured-fixture and --featured-label must be provided together",
  );
}
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

const oddsLedProtectedWindows = sum(
  fixtures.map((fixture) => fixture.metrics.oddsLedProtectedWindows),
);
const unconfirmedOddsLedProtectedWindows = sum(
  fixtures.map((fixture) => fixture.metrics.unconfirmedOddsLedProtectedWindows),
);
const featuredFixture =
  featuredFixtureId === null
    ? null
    : fixtures.find((fixture) => fixture.fixtureId === featuredFixtureId);
if (featuredFixtureId !== null && !featuredFixture) {
  throw new Error("The featured fixture must be part of this holdout");
}

const report = {
  version: 2,
  status: "AWAITING_PUBLIC_CLAIM_APPROVAL",
  network: "solana-mainnet",
  approvedConfigHash,
  evaluatedAt: new Date().toISOString(),
  fixtures,
  featuredMatch:
    featuredFixture && featuredLabel
      ? {
          evidenceType: "DERIVED_MATCH_ADDENDUM",
          label: featuredLabel,
          dataMode: "TXLINE_REPLAY",
          finalState: "TXLINE_GAME_FINALISED",
          completeProtectedWindows:
            featuredFixture.sample.completeProtectedWindows,
          protectedWindowSeconds: featuredFixture.metrics.staleQuoteSeconds,
          preResolutionRepricesInvalidated:
            featuredFixture.metrics.preResolutionRepricesInvalidated,
          postResolutionCertifiedReopens:
            featuredFixture.metrics.postResolutionCertifiedReopens,
          confirmedResolutionCertifiedReopens:
            featuredFixture.metrics.confirmedResolutionCertifiedReopens,
          dataBoundary:
            "Derived aggregate only; no fixture ID, raw TxLINE record, odds vector or source timestamp.",
        }
      : undefined,
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
    eventLedProtectedWindows: sum(
      fixtures.map((fixture) => fixture.metrics.eventLedProtectedWindows),
    ),
    oddsLedProtectedWindows,
    confirmedOddsLedProtectedWindows: sum(
      fixtures.map(
        (fixture) => fixture.metrics.confirmedOddsLedProtectedWindows,
      ),
    ),
    unconfirmedOddsLedProtectedWindows,
    unconfirmedOddsLedSuspensionRate:
      oddsLedProtectedWindows === 0
        ? null
        : unconfirmedOddsLedProtectedWindows / oddsLedProtectedWindows,
    failsafeProtectedWindows: sum(
      fixtures.map((fixture) => fixture.metrics.failsafeProtectedWindows),
    ),
    provisionalEventProtectedWindows: sum(
      fixtures.map(
        (fixture) => fixture.metrics.provisionalEventProtectedWindows,
      ),
    ),
    preResolutionRepricesInvalidated: sum(
      fixtures.map(
        (fixture) => fixture.metrics.preResolutionRepricesInvalidated,
      ),
    ),
    postResolutionCertifiedReopens: sum(
      fixtures.map((fixture) => fixture.metrics.postResolutionCertifiedReopens),
    ),
    confirmedResolutionCertifiedReopens: sum(
      fixtures.map(
        (fixture) => fixture.metrics.confirmedResolutionCertifiedReopens,
      ),
    ),
    discardedResolutionCertifiedReopens: sum(
      fixtures.map(
        (fixture) => fixture.metrics.discardedResolutionCertifiedReopens,
      ),
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
      featuredMatch: report.featuredMatch ?? null,
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

function readOptionalIntegerArgument(name: string) {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  const value = Number(process.argv[index + 1]);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} requires a positive integer`);
  }
  return value;
}

function readOptionalStringArgument(name: string) {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  const value = process.argv[index + 1]?.trim();
  if (!value || value.length < 3 || value.length > 80) {
    throw new Error(`${name} requires 3–80 characters`);
  }
  return value;
}

function sum(values: number[]) {
  return values.reduce((total, value) => total + value, 0);
}
