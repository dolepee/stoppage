export interface FiveMinuteInterval {
  epochDay: number;
  hourOfDay: number;
  interval: number;
  startTs: number;
}

const intervalMs = 5 * 60_000;

export function fiveMinuteIntervals(
  startTs: number,
  endTs: number,
): FiveMinuteInterval[] {
  if (!Number.isFinite(startTs) || !Number.isFinite(endTs) || endTs < startTs) {
    throw new Error("Invalid historical interval range");
  }

  const first = Math.floor(startTs / intervalMs) * intervalMs;
  const last = Math.floor(endTs / intervalMs) * intervalMs;
  const intervals: FiveMinuteInterval[] = [];

  for (let timestamp = first; timestamp <= last; timestamp += intervalMs) {
    const date = new Date(timestamp);
    intervals.push({
      epochDay: Math.floor(timestamp / 86_400_000),
      hourOfDay: date.getUTCHours(),
      interval: Math.floor(date.getUTCMinutes() / 5),
      startTs: timestamp,
    });
  }

  return intervals;
}
