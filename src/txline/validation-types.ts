import { z } from "zod";

const bytes32Schema = z.union([
  z.string().min(1),
  z.array(z.number().int().min(0).max(255)).length(32),
]);

const proofNodeSchema = z.object({
  hash: bytes32Schema,
  isRightSibling: z.boolean(),
});

const scoreStatSchema = z.object({
  key: z.number().int(),
  value: z.number().int(),
  period: z.number().int(),
});

export const scoreStatValidationSchema = z.object({
  ts: z.number().int(),
  statToProve: scoreStatSchema,
  eventStatRoot: bytes32Schema,
  summary: z.object({
    fixtureId: z.number().int(),
    updateStats: z.object({
      updateCount: z.number().int(),
      minTimestamp: z.number().int(),
      maxTimestamp: z.number().int(),
    }),
    eventStatsSubTreeRoot: bytes32Schema,
  }),
  statProof: z.array(proofNodeSchema),
  subTreeProof: z.array(proofNodeSchema),
  mainTreeProof: z.array(proofNodeSchema),
});

export type ScoreStatValidation = z.infer<typeof scoreStatValidationSchema>;
