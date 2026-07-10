import { loadConfig } from "../src/config.js";
import { writePrivateCapture } from "../src/private/capture-store.js";
import { TxLineClient } from "../src/txline/client.js";
import { fiveMinuteIntervals } from "../src/txline/intervals.js";

const fixtureId = readIntegerArgument("--fixture");
const config = loadConfig();
if (!config.txlineApiToken) {
  throw new Error(
    "TXLINE_API_TOKEN is required. Complete pnpm txline:activate first.",
  );
}

const client = new TxLineClient({
  origin: config.txlineOrigin,
  apiToken: config.txlineApiToken,
});

const scores = await client.fetchHistoricalScores(fixtureId);
if (!scores.length)
  throw new Error(`No historical scores returned for fixture ${fixtureId}`);

const scoreTimestamps = scores.map((score) => score.ts);
const kickoffTs = scores.find((score) => score.startTime)?.startTime;
if (!kickoffTs) {
  throw new Error(`Historical scores for fixture ${fixtureId} lack StartTime`);
}
const finalTs = Math.max(
  ...scores
    .filter((score) => score.action === "game_finalised")
    .map((score) => score.ts),
  kickoffTs + 3 * 60 * 60_000,
);
const startTs = kickoffTs - 30 * 60_000;
const endTs = Math.min(finalTs + 15 * 60_000, kickoffTs + 4 * 60 * 60_000);
const odds = [];

for (const interval of fiveMinuteIntervals(startTs, endTs)) {
  const updates = await client.fetchHistoricalOddsInterval({
    epochDay: interval.epochDay,
    hourOfDay: interval.hourOfDay,
    interval: interval.interval,
    fixtureId,
  });
  odds.push(...updates);
}

const capturedAt = new Date().toISOString();
const path = await writePrivateCapture(
  `fixture-${fixtureId}-${capturedAt.replace(/[:.]/g, "-")}.json`,
  {
    version: 1,
    network: "solana-mainnet",
    source: "TxLINE",
    fixtureId,
    capturedAt,
    scores,
    odds,
  },
);

const scoreActions = Object.entries(
  scores.reduce<Record<string, number>>((counts, score) => {
    counts[score.action] = (counts[score.action] ?? 0) + 1;
    return counts;
  }, {}),
)
  .sort((left, right) => right[1] - left[1])
  .slice(0, 12);

console.log(
  JSON.stringify(
    {
      ok: true,
      fixtureId,
      scoreUpdates: scores.length,
      oddsUpdates: odds.length,
      scoreActions,
      firstScoreTs: Math.min(...scoreTimestamps),
      lastScoreTs: Math.max(...scoreTimestamps),
      oddsWindowStartTs: startTs,
      oddsWindowEndTs: endTs,
      oddsIntervals: fiveMinuteIntervals(startTs, endTs).length,
      privateCapture: path,
    },
    null,
    2,
  ),
);

function readIntegerArgument(name: string): number {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? Number(process.argv[index + 1]) : Number.NaN;
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(
      `Usage: pnpm g2:capture -- --fixture <positive fixture id>`,
    );
  }
  return value;
}
