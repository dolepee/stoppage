import { readFile } from "node:fs/promises";

import { AnchorProvider, Program, Wallet } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";

import { loadConfig } from "../src/config.js";
import { TXLINE_MAINNET } from "../src/txline/constants.js";
import type { Txoracle } from "../vendor/txodds/txoracle-mainnet.js";

const config = loadConfig();

async function loadWallet(): Promise<Keypair> {
  const bytes = JSON.parse(
    await readFile(config.txlineKeypairPath, "utf8"),
  ) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(bytes));
}

async function main() {
  const keypair = await loadWallet();
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
  const [pricingMatrixPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("pricing_matrix")],
    program.programId,
  );
  const pricingMatrix =
    await program.account.pricingMatrix.fetch(pricingMatrixPda);
  const balance = await connection.getBalance(keypair.publicKey, "confirmed");

  console.log(
    JSON.stringify(
      {
        network: "solana-mainnet",
        wallet: keypair.publicKey.toBase58(),
        balanceLamports: balance,
        programId: program.programId.toBase58(),
        expectedProgramId: TXLINE_MAINNET.programId,
        serviceLevel: config.txlineServiceLevel,
        serviceRow:
          pricingMatrix.rows.find(
            (row) => row.rowId === config.txlineServiceLevel,
          ) ?? null,
      },
      null,
      2,
    ),
  );
}

await main();
