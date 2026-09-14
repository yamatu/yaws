import type { Database } from "better-sqlite3";
import { memo } from "./db.js";

export type UptimeBucketState = "up" | "warn" | "down";

export type UptimeOptions = {
  machineId: number;
  hours: number;
  bucketMin: number;
  offlineAfterMin: number;
};

/**
 * Bucket a machine's metric samples into up/warn/down points.
 *
 * The previous implementation loaded every sample inside the window into memory
 * (`SELECT at ... ORDER BY at ASC`) which meant a public, unauthenticated request for
 * 30 days with 1 minute buckets had to materialize hundreds of thousands of rows. The
 * state of a bucket only depends on the newest sample at or before its end, so each
 * bucket is now a single indexed `MAX(at)` lookup instead.
 */
export function computeUptimeBuckets(
  db: Database,
  opts: UptimeOptions,
  now = Date.now(),
) {
  const hours = Math.max(1, Math.min(24 * 30, Math.floor(opts.hours || 24)));
  const bucketMin = Math.max(1, Math.min(60, Math.floor(opts.bucketMin || 5)));
  const offlineAfterMin = Math.max(1, Math.min(24 * 60, Math.floor(opts.offlineAfterMin || 5)));

  const endAt = now;
  const bucketMs = bucketMin * 60_000;
  const startAt = endAt - hours * 60 * 60_000;
  const bucketsCount = Math.floor((endAt - startAt) / bucketMs);

  const previous = memo(db, "SELECT at FROM metrics WHERE machine_id = ? AND at < ? ORDER BY at DESC LIMIT 1").get(
    opts.machineId,
    startAt,
  ) as { at: number } | undefined;
  const latestInWindow = memo(
    db,
    "SELECT MAX(at) AS at FROM metrics WHERE machine_id = ? AND at >= ? AND at <= ?",
  );

  const offlineAfterMs = offlineAfterMin * 60_000;
  let lastAt: number | null = previous?.at ? Number(previous.at) : null;

  let upCount = 0;
  let warnCount = 0;
  let downCount = 0;

  const buckets: Array<{ at: number; state: UptimeBucketState }> = [];
  for (let i = 0; i < bucketsCount; i++) {
    const bucketEnd = startAt + (i + 1) * bucketMs;
    const hit = latestInWindow.get(opts.machineId, startAt, bucketEnd) as { at: number | null } | undefined;
    if (hit?.at != null) lastAt = Number(hit.at);

    let state: UptimeBucketState = "down";
    if (lastAt != null) {
      const delta = bucketEnd - lastAt;
      if (delta <= offlineAfterMs) state = "up";
      else if (delta <= offlineAfterMs * 3) state = "warn";
      else state = "down";
    }

    if (state === "up") upCount++;
    else if (state === "warn") warnCount++;
    else downCount++;

    buckets.push({ at: bucketEnd, state });
  }

  const total = Math.max(1, buckets.length);
  return {
    machineId: opts.machineId,
    startAt,
    endAt,
    bucketMin,
    hours,
    offlineAfterMin,
    upPct: upCount / total,
    counts: { up: upCount, warn: warnCount, down: downCount, total },
    buckets,
  };
}
