import { describe, expect, it } from "vitest";

import { fiveMinuteIntervals } from "./intervals.js";

describe("fiveMinuteIntervals", () => {
  it("crosses UTC hour and day boundaries without duplicate buckets", () => {
    const start = Date.UTC(2026, 6, 9, 23, 57);
    const end = Date.UTC(2026, 6, 10, 0, 7);
    expect(fiveMinuteIntervals(start, end)).toEqual([
      {
        epochDay: Math.floor(Date.UTC(2026, 6, 9, 23, 55) / 86_400_000),
        hourOfDay: 23,
        interval: 11,
        startTs: Date.UTC(2026, 6, 9, 23, 55),
      },
      {
        epochDay: Math.floor(Date.UTC(2026, 6, 10, 0, 0) / 86_400_000),
        hourOfDay: 0,
        interval: 0,
        startTs: Date.UTC(2026, 6, 10, 0, 0),
      },
      {
        epochDay: Math.floor(Date.UTC(2026, 6, 10, 0, 5) / 86_400_000),
        hourOfDay: 0,
        interval: 1,
        startTs: Date.UTC(2026, 6, 10, 0, 5),
      },
    ]);
  });
});
