import type { GovernorInput, ProbabilityVector } from "../domain/types.js";

export interface ReplayMatch {
  fixtureId: number;
  home: string;
  away: string;
  competition: string;
  kickoffTs: number;
}

export interface ReplayStep {
  atMs: number;
  input: GovernorInput;
  label: string;
}

export interface ReplayScenario {
  id: string;
  label: string;
  dataMode: "SYNTHETIC" | "TXLINE_REPLAY";
  description: string;
  match: ReplayMatch;
  initialProbability: ProbabilityVector;
  steps: ReplayStep[];
}
