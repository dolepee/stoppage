import { loadConfig } from "../src/config.js";
import { TxLineClient } from "../src/txline/client.js";

const config = loadConfig();
if (!config.txlineApiToken) {
  throw new Error(
    "TXLINE_API_TOKEN is required. Complete pnpm txline:activate first.",
  );
}

const now = Date.now();
const startEpochDay = Math.floor(now / 86_400_000) - 13;
const client = new TxLineClient({
  origin: config.txlineOrigin,
  apiToken: config.txlineApiToken,
});
const fixtures = await client.fetchFixtures({ startEpochDay });
const eligible = fixtures
  .filter(
    (fixture) =>
      fixture.StartTime <= now - 6 * 60 * 60_000 &&
      fixture.StartTime >= now - 14 * 24 * 60 * 60_000,
  )
  .sort((left, right) => right.StartTime - left.StartTime);

const probes = [];
for (const fixture of eligible) {
  try {
    const scores = await client.fetchHistoricalScores(fixture.FixtureId);
    const actions = [...new Set(scores.map((score) => score.action))].sort();
    probes.push({
      fixtureId: fixture.FixtureId,
      kickoff: new Date(fixture.StartTime).toISOString(),
      competition: fixture.Competition ?? null,
      participant1: fixture.Participant1 ?? null,
      participant2: fixture.Participant2 ?? null,
      scoreUpdates: scores.length,
      actions,
      available: scores.length > 0,
    });
  } catch (error) {
    probes.push({
      fixtureId: fixture.FixtureId,
      kickoff: new Date(fixture.StartTime).toISOString(),
      competition: fixture.Competition ?? null,
      participant1: fixture.Participant1 ?? null,
      participant2: fixture.Participant2 ?? null,
      scoreUpdates: 0,
      actions: [],
      available: false,
      error: (error as Error).message.slice(0, 200),
    });
  }
}

console.log(
  JSON.stringify(
    {
      ok: probes.some((probe) => probe.available),
      network: "solana-mainnet",
      startEpochDay,
      fixturesReturned: fixtures.length,
      eligibleFixtures: eligible.length,
      historical: probes,
    },
    null,
    2,
  ),
);
