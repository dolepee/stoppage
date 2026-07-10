import { readFile } from "node:fs/promises";

import { AnchorProvider, BN, Program, Wallet } from "@coral-xyz/anchor";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
} from "@solana/web3.js";

import { loadConfig } from "../src/config.js";
import { TxLineClient } from "../src/txline/client.js";
import { TXLINE_MAINNET } from "../src/txline/constants.js";
import type { ScoreStatValidation } from "../src/txline/validation-types.js";
import type { Txoracle } from "../vendor/txodds/txoracle-mainnet.js";

const fixtureId = readIntegerArgument("--fixture");
const seq = readIntegerArgument("--seq");
const statKey = readIntegerArgument("--stat-key");
const sendTransaction = process.argv.includes("--send");
const config = loadConfig();

if (!config.txlineApiToken) {
  throw new Error(
    "TXLINE_API_TOKEN is required. Complete pnpm txline:activate first.",
  );
}

const walletBytes = JSON.parse(
  await readFile(config.txlineKeypairPath, "utf8"),
) as number[];
const keypair = Keypair.fromSecretKey(Uint8Array.from(walletBytes));
const connection = new Connection(config.solanaRpcUrl, "confirmed");
const provider = new AnchorProvider(connection, new Wallet(keypair), {
  commitment: "confirmed",
});
const idl = JSON.parse(
  await readFile(
    new URL("../vendor/txodds/txoracle-mainnet.json", import.meta.url),
    "utf8",
  ),
) as Txoracle;
const program = new Program<Txoracle>(idl, provider);
if (program.programId.toBase58() !== TXLINE_MAINNET.programId) {
  throw new Error("Loaded TxLINE IDL is not the mainnet program");
}

const client = new TxLineClient({
  origin: config.txlineOrigin,
  apiToken: config.txlineApiToken,
});
const validation = await client.fetchScoreStatValidation({
  fixtureId,
  seq,
  statKey,
});
const targetTs = validation.summary.updateStats.minTimestamp;
const epochDay = Math.floor(targetTs / 86_400_000);
const [dailyScoresMerkleRoots] = PublicKey.findProgramAddressSync(
  [
    Buffer.from("daily_scores_roots"),
    new BN(epochDay).toArrayLike(Buffer, "le", 2),
  ],
  program.programId,
);

const fixtureSummary = {
  fixtureId: new BN(validation.summary.fixtureId),
  updateStats: {
    updateCount: validation.summary.updateStats.updateCount,
    minTimestamp: new BN(validation.summary.updateStats.minTimestamp),
    maxTimestamp: new BN(validation.summary.updateStats.maxTimestamp),
  },
  eventsSubTreeRoot: toBytes32(validation.summary.eventStatsSubTreeRoot),
};
const statA = {
  statToProve: validation.statToProve,
  eventStatRoot: toBytes32(validation.eventStatRoot),
  statProof: toProofNodes(validation.statProof),
};
const predicate = {
  threshold: validation.statToProve.value,
  comparison: { equalTo: {} },
};
const method = program.methods
  .validateStat(
    new BN(targetTs),
    fixtureSummary,
    toProofNodes(validation.subTreeProof),
    toProofNodes(validation.mainTreeProof),
    predicate,
    statA,
    null,
    null,
  )
  .accounts({ dailyScoresMerkleRoots })
  .preInstructions([
    ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
  ]);

const viewResult = await method.view();
if (!viewResult)
  throw new Error("TxLINE on-chain score validation returned false");

let transactionSignature: string | null = null;
if (sendTransaction) transactionSignature = await method.rpc();

console.log(
  JSON.stringify(
    {
      ok: true,
      network: "solana-mainnet",
      fixtureId,
      seq,
      stat: validation.statToProve,
      targetTs,
      epochDay,
      dailyScoresMerkleRoots: dailyScoresMerkleRoots.toBase58(),
      viewResult,
      transactionSignature,
    },
    null,
    2,
  ),
);

function toBytes32(value: string | number[]): number[] {
  const bytes = Array.isArray(value)
    ? Uint8Array.from(value)
    : value.startsWith("0x")
      ? Buffer.from(value.slice(2), "hex")
      : Buffer.from(value, "base64");
  if (bytes.length !== 32)
    throw new Error(`Expected 32 bytes, received ${bytes.length}`);
  return Array.from(bytes);
}

function toProofNodes(nodes: ScoreStatValidation["statProof"]) {
  return nodes.map((node) => ({
    hash: toBytes32(node.hash),
    isRightSibling: node.isRightSibling,
  }));
}

function readIntegerArgument(name: string): number {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? Number(process.argv[index + 1]) : Number.NaN;
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(
      "Usage: pnpm txline:validate-score -- --fixture <id> --seq <seq> --stat-key <key> [--send]",
    );
  }
  return value;
}
