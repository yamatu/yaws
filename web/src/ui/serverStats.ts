/** Display helpers for the SSH workspace resource panel. */

export type UsageLevel = "ok" | "warn" | "high" | "unknown";

/** Thresholds are shared by the cpu/memory/disk bars so colours stay consistent. */
export function usageLevel(percent: number | null | undefined): UsageLevel {
  if (percent === null || percent === undefined || !Number.isFinite(percent))
    return "unknown";
  if (percent >= 90) return "high";
  if (percent >= 75) return "warn";
  return "ok";
}

/** The percentage a meter shows for a 0…1 fraction (home page / machine cards). */
export function meterValue(fraction: number | null | undefined): number | null {
  if (fraction === null || fraction === undefined || !Number.isFinite(fraction))
    return null;
  return Math.max(0, Math.min(100, Math.round(fraction * 100)));
}

/** `usageLevel` for a 0…1 fraction, so every meter shares the same thresholds. The
 *  level is derived from the rounded percentage that is displayed next to the bar,
 *  so a value never reads "75%" in green. */
export function fractionLevel(fraction: number | null | undefined): UsageLevel {
  const percent = meterValue(fraction);
  return percent === null ? "unknown" : usageLevel(percent);
}

export function formatUptime(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0)
    return "—";
  const total = Math.floor(seconds);
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (days > 0) return `${days} 天 ${hours} 小时`;
  if (hours > 0) return `${hours} 小时 ${minutes} 分`;
  if (minutes > 0) return `${minutes} 分`;
  return `${total} 秒`;
}
