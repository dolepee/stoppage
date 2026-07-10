import type { GovernorInput, StreamName } from "../domain/types.js";

export interface LiveWorkerStatus {
  running: boolean;
  fixturesLoaded: number;
  oddsMessages: number;
  scoreMessages: number;
  normalizedOdds: number;
  normalizedEvents: number;
  skippedOdds: number;
  reconnects: Record<StreamName, number>;
  fixtureRefreshes: number;
  fixtureRefreshFailures: number;
  lastFixtureRefreshAt: number | null;
  streamHealth: Record<StreamName, boolean>;
  lastMessageAt: Record<StreamName, number | null>;
  startedAt: string | null;
}

export interface LiveWorkerCallbacks {
  onInput: (input: GovernorInput) => void | Promise<void>;
  onStatus?: (status: LiveWorkerStatus) => void | Promise<void>;
}
