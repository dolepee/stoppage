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
    GameState: z.string().optional(),
    InRunning: z.boolean(),
    MarketParameters: z.string().optional(),
    MarketPeriod: z.string().optional(),
    PriceNames: z.array(z.string()).optional(),
    Prices: z.array(z.number().int()).optional(),
    Pct: z.array(z.string()).optional(),
  })
  .passthrough();

export const scorePayloadSchema = z
  .object({
    fixtureId: z.number().int(),
    gameState: z.string(),
    action: z.string(),
    id: z.number().int(),
    ts: z.number().int(),
    seq: z.number().int(),
    participant: z.number().int().optional(),
    confirmed: z.boolean().optional(),
    dataSoccer: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

export type Fixture = z.infer<typeof fixtureSchema>;
export type OddsPayload = z.infer<typeof oddsPayloadSchema>;
export type ScorePayload = z.infer<typeof scorePayloadSchema>;

export interface SseMessage {
  id?: string;
  event?: string;
  data: string;
  retry?: number;
}
