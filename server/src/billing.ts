// Billing-cycle helpers shared by the HTTP API and the WebSocket ingestion path.
// Kept dependency free so both can import them without cycles.

export function daysInMonthUtc(year: number, month0: number) {
  return new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
}

export function pad2(n: number) {
  return String(n).padStart(2, "0");
}

export function billingMonthBoundsUtc(atMs: number, anchorDay: number) {
  const at = new Date(atMs);
  let year = at.getUTCFullYear();
  let month0 = at.getUTCMonth();
  const a = Math.min(31, Math.max(1, anchorDay || 1));

  const mkStart = (y: number, m0: number) => {
    const d = Math.min(a, daysInMonthUtc(y, m0));
    return Date.UTC(y, m0, d, 0, 0, 0, 0);
  };
  let startAt = mkStart(year, month0);
  if (atMs < startAt) {
    month0 -= 1;
    if (month0 < 0) {
      month0 = 11;
      year -= 1;
    }
    startAt = mkStart(year, month0);
  }

  let endYear = year;
  let endMonth0 = month0 + 1;
  if (endMonth0 > 11) {
    endMonth0 = 0;
    endYear += 1;
  }
  const endAt = mkStart(endYear, endMonth0);
  const s = new Date(startAt);
  const periodKey = `${s.getUTCFullYear()}-${pad2(s.getUTCMonth() + 1)}-${pad2(s.getUTCDate())}`;
  return { periodKey, startAt, endAt, anchorDay: a };
}
