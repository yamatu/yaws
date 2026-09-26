/**
 * Several servers can be driven from the same SSH workspace: every open
 * terminal is a session, and the open sessions are remembered per browser so a
 * reload — or a detour through the dashboard — brings the same terminals back.
 *
 * These helpers are pure (no storage, no DOM) so the ordering rules can be
 * tested without a browser. The caller owns localStorage and React state.
 */
/**
 * The strip holds one session per server, so the bound is high enough that a
 * whole fleet opens at once with one click ("open every server"). The server
 * keeps the real limit (per user / in total) and reports `session_limit` when
 * more than one browser window opens terminals.
 */
export const MAX_SESSIONS = 32;
export const SESSIONS_KEY = "yaws.ssh.sessions";

/** Machine ids only: positive integers, unique, in the order tabs are shown. */
export function sanitizeSessions(value: unknown, max = MAX_SESSIONS): number[] {
  const list: number[] = [];
  if (!Array.isArray(value)) return list;
  for (const raw of value) {
    const id = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isInteger(id) || id <= 0) continue;
    if (list.includes(id)) continue;
    if (list.length >= max) break;
    list.push(id);
  }
  return list;
}

export function parseSessions(
  raw: string | null | undefined,
  max = MAX_SESSIONS,
): number[] {
  if (!raw) return [];
  try {
    return sanitizeSessions(JSON.parse(raw), max);
  } catch {
    return [];
  }
}

/** Opens one more tab. A full strip is left untouched: the caller reports it. */
export function addSession(
  ids: number[],
  id: number,
  max = MAX_SESSIONS,
): number[] {
  const list = sanitizeSessions(ids, max);
  if (!Number.isInteger(id) || id <= 0) return list;
  if (list.includes(id)) return list;
  if (list.length >= max) return list;
  return [...list, id];
}

/**
 * The machine in the address bar is always an open session, otherwise the page
 * would look empty after a bookmark or a link from the bastion page. A deep
 * link therefore wins over the tab limit instead of silently closing a session.
 */
export function ensureSession(
  ids: number[],
  id: number,
  max = MAX_SESSIONS,
): number[] {
  const list = sanitizeSessions(ids, max);
  if (!Number.isInteger(id) || id <= 0) return list;
  return list.includes(id) ? list : [...list, id];
}

export function closeSession(ids: number[], id: number): number[] {
  return sanitizeSessions(ids).filter((value) => value !== id);
}

/** How many more terminals fit; a negative value means a deep link overshot. */
export function sessionRoom(ids: number[], max = MAX_SESSIONS): number {
  return max - sanitizeSessions(ids, max).length;
}

/**
 * Which terminal takes over when the active one is closed: the next tab, then
 * the previous one, and only when nothing is left zero (the caller leaves the
 * workspace). Closing a background tab keeps the active terminal in place.
 *
 * Every tab carries a close button, so the strip can always be emptied — the
 * page then shows the server picker instead of refusing to let go of the last
 * server.
 */
export function nextActiveSession(
  ids: number[],
  closing: number,
  active: number,
): number {
  const rest = closeSession(ids, closing);
  if (rest.includes(active)) return active;
  const index = ids.indexOf(closing);
  if (index >= 0) {
    for (let i = index + 1; i < ids.length; i++)
      if (rest.includes(ids[i])) return ids[i];
    for (let i = index - 1; i >= 0; i--)
      if (rest.includes(ids[i])) return ids[i];
  }
  return rest[0] ?? 0;
}

/**
 * The URL only pins a terminal while one is open. With an empty strip the
 * address bar must not keep demanding a server, otherwise closing the active
 * terminal would immediately reopen it and the last tab could never close.
 */
export function shouldPinAddress(ids: number[]): boolean {
  return sanitizeSessions(ids).length > 0;
}
