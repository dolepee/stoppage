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
    ok: false,
    infrastructureOk:
      Boolean(programAccount?.executable) && guestToken.length > 0,
    g1Complete: false,
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

    const [oddsStream, scoresStream] = await Promise.all([
      probeStream("odds", (callbacks, signal) =>
        client.streamOdds(callbacks, signal),
      ),
      probeStream("scores", (callbacks, signal) =>
        client.streamScores(callbacks, signal),
      ),
    ]);
    result.streams = { odds: oddsStream, scores: scoresStream };
    result.g1Complete =
      fixtures.length > 0 && oddsStream.connected && scoresStream.connected;
    result.ok = result.g1Complete;
  } else {
    result.blockedReason = "TXLINE_API_TOKEN is not configured";
  }

  console.log(JSON.stringify(result, null, 2));
}

await main();

async function probeStream<T>(
  name: "odds" | "scores",
  start: (
    callbacks: {
      onOpen: () => void;
      onData: (payload: T) => void;
      onHeartbeat: (timestamp: number | null) => void;
    },
    signal: AbortSignal,
  ) => Promise<void>,
) {
  const controller = new AbortController();
  const startedAt = Date.now();
  let connected = false;
  let heartbeatCount = 0;
  let dataCount = 0;
  let lastHeartbeatTs: number | null = null;
  let error: string | null = null;

  const stream = start(
    {
      onOpen: () => {
        connected = true;
      },
      onData: () => {
        dataCount += 1;
      },
      onHeartbeat: (timestamp) => {
        heartbeatCount += 1;
        lastHeartbeatTs = timestamp;
      },
    },
    controller.signal,
  ).catch((caught: unknown) => {
    if ((caught as Error).name !== "AbortError")
      error = (caught as Error).message;
  });

  await new Promise((resolve) => setTimeout(resolve, 12_000));
  controller.abort();
  await stream;

  return {
    name,
    connected,
    heartbeatCount,
    dataCount,
    lastHeartbeatTs,
    actualDataObserved: dataCount > 0,
    durationMs: Date.now() - startedAt,
    error,
  };
}
