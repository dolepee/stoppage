import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { Keypair } from "@solana/web3.js";

import { loadConfig } from "../src/config.js";

const config = loadConfig();

async function main() {
  try {
    const existing = JSON.parse(
      await readFile(config.txlineKeypairPath, "utf8"),
    ) as number[];
    const keypair = Keypair.fromSecretKey(Uint8Array.from(existing));
    console.log(`Existing Stoppage wallet: ${keypair.publicKey.toBase58()}`);
    return;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw error;
  }

  const keypair = Keypair.generate();
  await mkdir(dirname(config.txlineKeypairPath), {
    recursive: true,
    mode: 0o700,
  });
  await writeFile(
    config.txlineKeypairPath,
    `${JSON.stringify(Array.from(keypair.secretKey))}\n`,
    { mode: 0o600 },
  );
  await chmod(config.txlineKeypairPath, 0o600);

  console.log(`Created Stoppage wallet: ${keypair.publicKey.toBase58()}`);
  console.log(`Keypair stored at ${config.txlineKeypairPath} with mode 0600.`);
}

await main();
