import type {
  FixtureGovernorState,
  GovernorInput,
  ReopenProof,
} from "../domain/types.js";
import type { QuoteGovernor } from "../domain/governor.js";
import {
  readRuntimeState,
  writeRuntimeState,
} from "../private/runtime-store.js";
import { hashExecutionSubject } from "./execution-gate.js";
import type { ExecutionGateContext } from "./types.js";

export const LIVE_EXECUTION_CONTEXT_FILE = "live-execution-contexts.json";
export const LIVE_EXECUTION_CONTEXT_MAX_AGE_MS = 5_000;

export interface PersistedExecutionGateContext {
  version: 1;
  subjectHash: string;
  configHash: string;
  sequence: number;
  observedTs: number;
  state: FixtureGovernorState;
  reopenProofs: ReopenProof[];
  updatedAt: string;
}

export interface PersistedLiveExecutionState {
  version: 1;
  updatedAt: string;
  contexts: PersistedExecutionGateContext[];
}

export class LiveExecutionContextTracker {
  readonly #fixtureSequences = new Map<number, number>();
  readonly #fixtureObservedAt = new Map<number, number>();
  readonly #fixtureUpdatedAt = new Map<number, string>();

  observe(input: GovernorInput, updatedAt = new Date().toISOString()) {
    const affectedFixtures = this.#affectedFixtureIds(input);
    const inputAt = inputTimestamp(input);
    for (const fixtureId of affectedFixtures) {
      this.#fixtureSequences.set(
        fixtureId,
        (this.#fixtureSequences.get(fixtureId) ?? 0) + 1,
      );
      this.#fixtureObservedAt.set(fixtureId, inputAt);
      this.#fixtureUpdatedAt.set(fixtureId, updatedAt);
    }
  }

  contexts(governor: QuoteGovernor): PersistedExecutionGateContext[] {
    return [...this.#fixtureSequences.keys()].map((fixtureId) => ({
      version: 1,
      subjectHash: hashExecutionSubject({ fixtureId }),
      configHash: governor.configHash,
      sequence: this.#fixtureSequences.get(fixtureId) ?? 0,
      observedTs: this.#fixtureObservedAt.get(fixtureId) ?? Date.now(),
      state: governor.getState(fixtureId),
      reopenProofs: [...governor.getReopenProofs(fixtureId)],
      updatedAt:
        this.#fixtureUpdatedAt.get(fixtureId) ?? new Date().toISOString(),
    }));
  }

  #affectedFixtureIds(input: GovernorInput) {
    if (
      input.kind === "quote" ||
      input.kind === "match-event" ||
      input.kind === "event-resolution"
    ) {
      if (!this.#fixtureSequences.has(input.fixtureId)) {
        this.#fixtureSequences.set(input.fixtureId, 0);
      }
      return [input.fixtureId];
    }
    return [...this.#fixtureSequences.keys()];
  }
}

export async function writeLiveExecutionState(
  contexts: PersistedExecutionGateContext[],
) {
  return writeRuntimeState(LIVE_EXECUTION_CONTEXT_FILE, {
    version: 1,
    updatedAt: new Date().toISOString(),
    contexts,
  } satisfies PersistedLiveExecutionState);
}

export async function readLiveExecutionState() {
  return readRuntimeState<PersistedLiveExecutionState>(
    LIVE_EXECUTION_CONTEXT_FILE,
  );
}

export function executionContextFromPersisted(
  persisted: PersistedExecutionGateContext,
  observedTs = persisted.observedTs,
): ExecutionGateContext {
  return {
    subjectHash: persisted.subjectHash,
    configHash: persisted.configHash,
    sequence: persisted.sequence,
    observedTs,
    state: structuredClone(persisted.state),
    reopenProofs: structuredClone(persisted.reopenProofs),
  };
}

function inputTimestamp(input: GovernorInput) {
  if (
    input.kind === "quote" ||
    input.kind === "match-event" ||
    input.kind === "event-resolution"
  ) {
    return input.receivedTs;
  }
  return input.observedTs;
}
