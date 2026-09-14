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
