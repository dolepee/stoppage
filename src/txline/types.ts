import { z } from "zod";

export const guestSessionSchema = z.object({
  token: z.string().min(1),
});

export const fixtureSchema = z
  .object({
    FixtureId: z.number().int(),
    StartTime: z.number().int(),
    Competition: z.string().optional(),
    CompetitionId: z.number().int().optional(),
    Participant1: z.string().optional(),
    Participant2: z.string().optional(),
    Participant1Id: z.number().int().optional(),
    Participant2Id: z.number().int().optional(),
    Participant1IsHome: z.boolean().optional(),
    Ts: z.number().int().optional(),
  })
  .passthrough();

export const oddsPayloadSchema = z
  .object({
    FixtureId: z.number().int(),
    MessageId: z.string(),
    Ts: z.number().int(),
    Bookmaker: z.string(),
    BookmakerId: z.number().int(),
    SuperOddsType: z.string(),
    GameState: z.string().nullish(),
    InRunning: z.boolean(),
    MarketParameters: z.string().nullish(),
    MarketPeriod: z.string().nullish(),
    PriceNames: z.array(z.string()).nullish(),
    Prices: z.array(z.number().int()).nullish(),
    Pct: z.array(z.string()).nullish(),
  })
  .passthrough();

export const scorePayloadSchema = z.preprocess(
  normalizeScoreWireKeys,
  z
    .object({
      fixtureId: z.number().int(),
      gameState: z.string(),
      startTime: z.number().int().nullish(),
      action: z.string(),
      id: z.number().int(),
      ts: z.number().int(),
      seq: z.number().int(),
      participant: z.number().int().nullish(),
      confirmed: z.boolean().nullish(),
      dataSoccer: z.record(z.string(), z.unknown()).nullish(),
      stats: z.record(z.string(), z.number()).nullish(),
    })
    .passthrough(),
);

export type Fixture = z.infer<typeof fixtureSchema>;
export type OddsPayload = z.infer<typeof oddsPayloadSchema>;
export type ScorePayload = z.infer<typeof scorePayloadSchema>;

export interface SseMessage {
  id?: string;
  event?: string;
  data: string;
  retry?: number;
}

function normalizeScoreWireKeys(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  if (!("FixtureId" in record)) return value;

  return {
    ...record,
    fixtureId: record["FixtureId"],
    gameState: record["GameState"],
    startTime: record["StartTime"],
    action: record["Action"],
    id: record["Id"],
    ts: record["Ts"],
    seq: record["Seq"],
    participant: record["Participant"],
    confirmed: record["Confirmed"],
    dataSoccer: record["DataSoccer"] ?? record["Data"],
    stats: record["Stats"],
  };
}
