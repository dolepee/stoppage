import { readFile, writeFile } from "node:fs/promises";

import { AnchorProvider, Program, Wallet } from "@coral-xyz/anchor";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import nacl from "tweetnacl";

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
  if (config.txlineOrigin !== TXLINE_MAINNET.apiOrigin) {
    throw new Error(`Mainnet activation requires ${TXLINE_MAINNET.apiOrigin}`);
  }
  if (config.txlineServiceLevel !== TXLINE_MAINNET.serviceLevel) {
    throw new Error(`Mainnet real-time activation requires service level 12`);
  }

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
  if (program.programId.toBase58() !== TXLINE_MAINNET.programId) {
    throw new Error("Loaded TxLINE IDL is not the mainnet program");
  }

  const balance = await connection.getBalance(keypair.publicKey, "confirmed");
  if (balance < 5_000_000) {
    throw new Error(
      `Wallet ${keypair.publicKey.toBase58()} has ${balance} lamports. Fund at least 0.005 SOL for ATA rent and transaction fees.`,
    );
  }

  const tokenMint = new PublicKey(TXLINE_MAINNET.txlTokenMint);
  const userTokenAccount = getAssociatedTokenAddressSync(
    tokenMint,
    keypair.publicKey,
    false,
    TOKEN_2022_PROGRAM_ID,
  );
  if (!(await connection.getAccountInfo(userTokenAccount, "confirmed"))) {
    const createAta = new Transaction().add(
      createAssociatedTokenAccountInstruction(
        keypair.publicKey,
        userTokenAccount,
        keypair.publicKey,
        tokenMint,
        TOKEN_2022_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID,
      ),
    );
    await sendAndConfirmTransaction(connection, createAta, [keypair], {
      commitment: "confirmed",
    });
  }

  const [pricingMatrix] = PublicKey.findProgramAddressSync(
    [Buffer.from("pricing_matrix")],
    program.programId,
  );
  const [tokenTreasuryPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("token_treasury_v2")],
    program.programId,
  );
  const tokenTreasuryVault = getAssociatedTokenAddressSync(
    tokenMint,
    tokenTreasuryPda,
    true,
    TOKEN_2022_PROGRAM_ID,
  );

  const txSignature = await program.methods
    .subscribe(config.txlineServiceLevel, config.txlineSubscriptionWeeks)
    .accounts({
      user: keypair.publicKey,
      pricingMatrix,
      tokenMint,
      userTokenAccount,
      tokenTreasuryVault,
      tokenTreasuryPda,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
    })
    .rpc();

  const guestResponse = await fetch(`${config.txlineOrigin}/auth/guest/start`, {
    method: "POST",
  });
  if (!guestResponse.ok)
    throw new Error(`Guest auth failed: ${guestResponse.status}`);
  const guest = (await guestResponse.json()) as { token: string };
  const message = new TextEncoder().encode(`${txSignature}::${guest.token}`);
  const walletSignature = Buffer.from(
    nacl.sign.detached(message, keypair.secretKey),
  ).toString("base64");

  const activationResponse = await fetch(
    `${config.txlineOrigin}/api/token/activate`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${guest.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        txSig: txSignature,
        walletSignature,
        leagues: [],
      }),
    },
  );
  if (!activationResponse.ok) {
    throw new Error(
      `TxLINE activation failed with HTTP ${activationResponse.status}: ${await activationResponse.text()}`,
    );
  }
  const activation = (await activationResponse.json()) as
    { token: string } | string;
  const apiToken =
    typeof activation === "string" ? activation : activation.token;
  const envPath = new URL("../.env", import.meta.url);
  await writeFile(
    envPath,
    [
      `SOLANA_RPC_URL=${config.solanaRpcUrl}`,
      `TXLINE_ORIGIN=${config.txlineOrigin}`,
      `TXLINE_KEYPAIR_PATH=${config.txlineKeypairPath}`,
      `TXLINE_SERVICE_LEVEL=${config.txlineServiceLevel}`,
      `TXLINE_SUBSCRIPTION_WEEKS=${config.txlineSubscriptionWeeks}`,
      `TXLINE_API_TOKEN=${apiToken}`,
      "",
    ].join("\n"),
    { mode: 0o600 },
  );

  console.log(
    JSON.stringify(
      {
        ok: true,
        network: "solana-mainnet",
        wallet: keypair.publicKey.toBase58(),
        txSignature,
        serviceLevel: config.txlineServiceLevel,
        apiTokenStored: true,
      },
      null,
      2,
    ),
  );
}

await main();
