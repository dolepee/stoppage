import { describe, expect, it } from "vitest";

import { DEFAULT_GOVERNOR_CONFIG } from "../domain/governor.js";
import type { GovernorInput } from "../domain/types.js";
import { calibratePolicy } from "./calibration.js";

describe("calibratePolicy", () => {
  it("summarizes cadence, movement, and incident resolution deterministically", () => {
    const inputs: GovernorInput[] = [
      quote("q1", 1_000, 0.4),
      quote("q2", 2_000, 0.405),
      event("goal", 2_100, false),
      quote("q3", 3_000, 0.5),
      event("goal", 3_100, true),
    ];

    const result = calibratePolicy(inputs, DEFAULT_GOVERNOR_CONFIG);

    expect(result.sample).toMatchObject({
      quotes: 3,
      uniqueIncidents: 1,
      resolvedIncidents: 1,
    });
    expect(result.quoteCadenceMs.p50).toBe(1_000);
    expect(result.confirmationDelayMs.p50).toBe(1_000);
  });
});

function quote(id: string, timestamp: number, home: number) {
  return {
    kind: "quote" as const,
    fixtureId: 1,
    market: "1X2" as const,
    messageId: id,
    sourceTs: timestamp,
    receivedTs: timestamp,
    probabilities: { HOME: home, DRAW: 0.3, AWAY: 0.7 - home },
  };
}

function event(id: string, timestamp: number, confirmed: boolean) {
  return {
    kind: "match-event" as const,
    fixtureId: 1,
    eventId: `${id}:${timestamp}`,
    incidentId: id,
    eventType: "GOAL" as const,
    sourceTs: timestamp,
    receivedTs: timestamp,
    confirmed,
  };
}
