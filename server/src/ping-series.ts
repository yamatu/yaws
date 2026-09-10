import type { Db } from "./db.js";

export function pingSeries(
  db: Db,
  monitorId: number,
  rangeMin: number,
  intervalSec: number,
  now = Date.now(),
) {
  const endAt = now,
    startAt = now - rangeMin * 60000;
  const bucketMs = Math.max(
    intervalSec * 1000,
    Math.ceil((rangeMin * 60000) / 240),
  );
  // Agent failures mean no measurement took place. They are not packet loss.
  const window = `SELECT at, latency_ms as latency, error,
      CASE WHEN latency_ms IS NOT NULL AND error IS NULL THEN 1 ELSE 0 END as received,
      CASE WHEN error = 'timeout_or_unreachable' THEN 1 ELSE 0 END as lost
    FROM ping_samples WHERE monitor_id = ? AND at >= ? AND at <= ?`;
  const points = db
    .prepare(
      `WITH samples AS (${window})
    SELECT MIN(at) as at, MAX(at) as endAt, COUNT(*) as count,
      SUM(received) as received, SUM(lost) as lost, SUM(1-received-lost) as unavailable,
      AVG(CASE WHEN received=1 THEN latency END) as latencyMs,
      MIN(CASE WHEN received=1 THEN latency END) as minMs,
      MAX(CASE WHEN received=1 THEN latency END) as maxMs
    FROM samples GROUP BY CAST((at - ?) / ? AS INTEGER) ORDER BY at`,
    )
    .all(monitorId, startAt, endAt, startAt, bucketMs);
  const summary = db
    .prepare(
      `WITH samples AS (${window}), pairs AS (
      SELECT *, LAG(latency) OVER (ORDER BY at) as previous,
        LAG(received) OVER (ORDER BY at) as previousReceived,
        LAG(at) OVER (ORDER BY at) as previousAt FROM samples
    ) SELECT COUNT(*) as count, COALESCE(SUM(received),0) as received,
      COALESCE(SUM(lost),0) as lost, COALESCE(SUM(1-received-lost),0) as unavailable,
      MIN(CASE WHEN received=1 THEN latency END) as minMs,
      MAX(CASE WHEN received=1 THEN latency END) as maxMs,
      AVG(CASE WHEN received=1 THEN latency END) as avgMs,
      AVG(CASE WHEN received=1 AND previousReceived=1 AND at-previousAt <= ? THEN ABS(latency-previous) END) as jitterMs
    FROM pairs`,
    )
    .get(monitorId, startAt, endAt, intervalSec * 3000) as {
    count: number;
    received: number;
    lost: number;
    unavailable: number;
    minMs: number | null;
    maxMs: number | null;
    avgMs: number | null;
    jitterMs: number | null;
  };
  return {
    startAt,
    endAt,
    bucketMs,
    points,
    summary: {
      ...summary,
      lossPct:
        summary.received + summary.lost
          ? (summary.lost / (summary.received + summary.lost)) * 100
          : null,
    },
  };
}
