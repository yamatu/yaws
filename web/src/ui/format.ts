export function formatBytes(bytes: number) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function pct(used: number, total: number) {
  if (total <= 0) return 0;
  return Math.max(0, Math.min(1, used / total));
}

export function formatBps(bytesPerSec: number) {
  if (!Number.isFinite(bytesPerSec) || bytesPerSec <= 0) return "0 B/s";
  return `${formatBytes(bytesPerSec)}/s`;
}

export function fmtTime(ts: number | null) {
  if (!ts) return "—";
  return new Date(ts).toLocaleString();
}

export function daysLeft(expiresAt: number | null) {
  if (!expiresAt) return null;
  const ms = expiresAt - Date.now();
  return Math.ceil(ms / (24 * 3600 * 1000));
}

export function formatMoneyCents(cents: number) {
  const v = (cents ?? 0) / 100;
  return `¥${v.toFixed(2)}`;
}

export function cycleLabel(cycle: "month" | "quarter" | "year") {
  if (cycle === "month") return "月付";
  if (cycle === "quarter") return "季付";
  return "年付";
}

export function calcRateBps(prev: { at: number; v: number } | null, cur: { at: number; v: number } | null) {
  if (!prev || !cur) return 0;
  const dt = (cur.at - prev.at) / 1000;
  if (dt <= 0) return 0;
  const dv = cur.v - prev.v;
  if (dv <= 0) return 0;
  return dv / dt;
}
