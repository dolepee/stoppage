import { resolve } from "node:path";

import { z } from "zod";

try {
  process.loadEnvFile();
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

const environmentSchema = z.object({
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(4173),
  SOLANA_RPC_URL: z.url().default("https://api.mainnet-beta.solana.com"),
  TXLINE_ORIGIN: z.url().default("https://txline.txodds.com"),
  TXLINE_API_TOKEN: z.string().min(1).optional(),
  TXLINE_KEYPAIR_PATH: z.string().default(".secrets/solana-mainnet.json"),
  TXLINE_SERVICE_LEVEL: z.coerce.number().int().positive().default(12),
  TXLINE_SUBSCRIPTION_WEEKS: z.coerce.number().int().positive().default(4),
  STOPPAGE_LIVE_TAPE_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
});

export type AppConfig = ReturnType<typeof loadConfig>;

export function loadConfig(environment: NodeJS.ProcessEnv = process.env) {
  const parsed = environmentSchema.parse(environment);

  return {
    host: parsed.HOST,
    port: parsed.PORT,
    solanaRpcUrl: parsed.SOLANA_RPC_URL,
    txlineOrigin: parsed.TXLINE_ORIGIN.replace(/\/$/, ""),
    txlineApiToken: parsed.TXLINE_API_TOKEN,
    txlineKeypairPath: resolve(parsed.TXLINE_KEYPAIR_PATH),
    txlineServiceLevel: parsed.TXLINE_SERVICE_LEVEL,
    txlineSubscriptionWeeks: parsed.TXLINE_SUBSCRIPTION_WEEKS,
    liveDecisionTapeEnabled: parsed.STOPPAGE_LIVE_TAPE_ENABLED,
  };
}
