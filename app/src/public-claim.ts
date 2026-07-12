import { z } from "zod";

const hashSchema = z.string().regex(/^0x[0-9a-f]{64}$/);

const decisionSchema = z.object({
  action: z.enum(["SUSPEND", "REPRICE", "REOPEN"]),
  trigger: z.string().min(1),
  fromMode: z.string().min(1),
  toMode: z.string().min(1),
  elapsedMs: z.number().nonnegative(),
  receiptHash: hashSchema,
});

const publicClaimSchema = z.object({
  status: z.literal("AVAILABLE"),
  network: z.literal("solana-mainnet"),
  approvedConfigHash: hashSchema,
  candidateHash: hashSchema.optional(),
  evaluatedAt: z.string().min(1),
  approvedAt: z.string().min(1),
  dataBoundary: z.string().min(1),
  holdout: z.object({
    fixtures: z.number().int().positive(),
    completeProtectedWindows: z.number().int().nonnegative(),
    staleQuoteSeconds: z.number().nonnegative(),
    mispricingIntegral: z.number().nonnegative(),
  }),
  lifecycleEvidence: z.object({
    lifecycleDurationMs: z.number().nonnegative(),
    maximumProbabilityMove: z.number().min(0).max(1),
    txlineValidation: z.object({
      transactionSignature: z.string().min(32),
      explorer: z.string().url().startsWith("https://solscan.io/tx/"),
    }),
    decisions: z
      .array(decisionSchema)
      .length(3)
      .refine(
        (decisions) =>
          decisions.map((decision) => decision.action).join(",") ===
          "SUSPEND,REPRICE,REOPEN",
        "Lifecycle must be SUSPEND, REPRICE, REOPEN",
      ),
  }),
});

export type PublicClaim = z.infer<typeof publicClaimSchema>;

export function parsePublicClaim(value: unknown): PublicClaim {
  return publicClaimSchema.parse(value);
}
