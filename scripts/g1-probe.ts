import { Connection, PublicKey } from "@solana/web3.js";

import { loadConfig } from "../src/config.js";
import { TXLINE_MAINNET } from "../src/txline/constants.js";
import { TxLineClient } from "../src/txline/client.js";

const config = loadConfig();

async function main() {
  const startedAt = Date.now();
  const client = new TxLineClient({
    origin: config.txlineOrigin,
    apiToken: config.txlineApiToken,
  });
  const connection = new Connection(config.solanaRpcUrl, "confirmed");

  const [guestToken, programAccount, blockHeight] = await Promise.all([
    client.startGuestSession(),
    connection.getAccountInfo(new PublicKey(TXLINE_MAINNET.programId)),
    connection.getBlockHeight("confirmed"),
  ]);

  const result: Record<string, unknown> = {
    ok: true,
    network: "solana-mainnet",
    txlineOrigin: config.txlineOrigin,
    programId: TXLINE_MAINNET.programId,
    programDeployed: Boolean(programAccount?.executable),
    blockHeight,
    guestAuth: guestToken.length > 0,
    apiTokenConfigured: client.hasApiToken,
    checkedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
  };

  if (client.hasApiToken) {
    const fixtures = await client.fetchFixtures();
    result.fixtures = fixtures.length;
    result.fixtureSample = fixtures.slice(0, 3).map((fixture) => ({
      fixtureId: fixture.FixtureId,
      startTime: fixture.StartTime,
      participant1: fixture.Participant1 ?? null,
      participant2: fixture.Participant2 ?? null,
    }));
  }

  console.log(JSON.stringify(result, null, 2));
}

await main();
