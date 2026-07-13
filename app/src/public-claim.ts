import { z } from "zod";

const hashSchema = z.string().regex(/^0x[0-9a-f]{64}$/);

const decisionSchema = z.object({
  action: z.enum(["SUSPEND", "REPRICE", "INVALIDATE_REPRICE", "REOPEN"]),
  trigger: z.string().min(1),
  fromMode: z.string().min(1),
  toMode: z.string().min(1),
  elapsedMs: z.number().nonnegative(),
  receiptHash: hashSchema,
});

const publicClaimSchema = z
  .object({
    version: z.literal(3),
    status: z.literal("AVAILABLE"),
    network: z.literal("solana-mainnet"),
    approvedConfigHash: hashSchema,
    candidateHash: hashSchema,
    evaluatedAt: z.string().min(1),
    approvedAt: z.string().min(1),
    dataBoundary: z.string().min(1),
    holdout: z.object({
      fixtures: z.number().int().positive(),
      completeProtectedWindows: z.number().int().nonnegative(),
      staleQuoteSeconds: z.number().nonnegative(),
      mispricingIntegral: z.number().nonnegative(),
      eventLedProtectedWindows: z.number().int().nonnegative(),
      oddsLedProtectedWindows: z.number().int().nonnegative(),
      confirmedOddsLedProtectedWindows: z.number().int().nonnegative(),
      unconfirmedOddsLedProtectedWindows: z.number().int().nonnegative(),
      unconfirmedOddsLedSuspensionRate: z.number().min(0).max(1).nullable(),
      preResolutionRepricesInvalidated: z.number().int().nonnegative(),
      postResolutionCertifiedReopens: z.number().int().nonnegative(),
      confirmedResolutionCertifiedReopens: z.number().int().nonnegative(),
      discardedResolutionCertifiedReopens: z.number().int().nonnegative(),
    }),
    lifecycleEvidence: z.object({
      policyRevision: z.literal(2),
      lifecycleDurationMs: z.number().nonnegative(),
      maximumProbabilityMove: z.number().min(0).max(1),
      preResolutionRepricesInvalidated: z.number().int().positive(),
      txlineValidation: z.object({
        transactionSignature: z.string().min(32),
        explorer: z.string().url().startsWith("https://solscan.io/tx/"),
      }),
      decisions: z
        .array(decisionSchema)
        .min(5)
        .refine((decisions) => {
          const actions = decisions.map((decision) => decision.action);
          const invalidationIndex = actions.indexOf("INVALIDATE_REPRICE");
          return (
            actions[0] === "SUSPEND" &&
            actions.at(-1) === "REOPEN" &&
            invalidationIndex > 0 &&
            actions.slice(0, invalidationIndex).includes("REPRICE") &&
            actions.lastIndexOf("REPRICE") > invalidationIndex
          );
        }, "Lifecycle must invalidate a provisional reprice before the certified reopen"),
    }),
  })
  .superRefine((claim, context) => {
    const invalidations = claim.lifecycleEvidence.decisions.filter(
      (decision) => decision.action === "INVALIDATE_REPRICE",
    ).length;
    if (
      invalidations !== claim.lifecycleEvidence.preResolutionRepricesInvalidated
    ) {
      context.addIssue({
        code: "custom",
        path: ["lifecycleEvidence", "preResolutionRepricesInvalidated"],
        message: "Invalidation count does not match the decision path",
      });
    }
  });

export type PublicClaim = z.infer<typeof publicClaimSchema>;

export function parsePublicClaim(value: unknown): PublicClaim {
  return publicClaimSchema.parse(value);
}
