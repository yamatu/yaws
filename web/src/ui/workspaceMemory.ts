/**
 * Remembers where you were on the SSH workspace: which tab, which directory,
 * which file and where the caret sat inside it. Everything here is pure so the
 * storage contract can be unit tested without a browser.
 */

export type WorkspaceTab = "terminal" | "files" | "ai";

export type CursorState = { anchor: number; head: number; scrollTop: number };

export type FileView = { dir: string; file: string | null };

const TABS: WorkspaceTab[] = ["terminal", "files", "ai"];

const MAX_PATH = 4096;

/** How many files per machine keep a remembered caret. */
export const MAX_CURSOR_FILES = 20;

const MAX_SCROLL = 10_000_000;

export const tabKey = (machineId: number | string) => `yaws.ssh.tab.${machineId}`;

export const viewKey = (machineId: number | string) =>
  `yaws.workspace.view.${machineId}`;

export const cursorKey = (machineId: number | string) =>
  `yaws.workspace.cursor.${machineId}`;

/** A path we are willing to remember: absolute, POSIX, no traversal. */
export function storedPath(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  if (!raw.startsWith("/") || raw.length > MAX_PATH) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(raw)) return null;
  const parts = raw.split("/");
  if (parts.some((part) => part === ".." || part === ".")) return null;
  return raw;
}

export function storedTab(raw: unknown): WorkspaceTab {
  return TABS.includes(raw as WorkspaceTab) ? (raw as WorkspaceTab) : "terminal";
}

/** `/srv/app/config.json` → `/srv/app`; `/srv` → `/`; `/` → `/`. */
export function dirname(path: string): string {
  const cut = path.replace(/\/+$/, "").replace(/\/[^/]*$/, "");
  return cut.startsWith("/") ? cut || "/" : "/";
}

/** True when `path` is the directory itself or something inside it. */
export function isInside(
  path: string | null | undefined,
  dir: string,
): boolean {
  if (typeof path !== "string" || !path) return false;
  const base = dir.replace(/\/+$/, "");
  return base === "" ? path.startsWith("/") : path.startsWith(`${base}/`);
}

export function readView(raw: string | null | undefined): FileView {
  const fallback: FileView = { dir: "/", file: null };
  if (typeof raw !== "string" || !raw) return fallback;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fallback;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return fallback;
  }
  const record = parsed as { dir?: unknown; file?: unknown };
  const dir = storedPath(record.dir) ?? "/";
  const file = storedPath(record.file);
  return { dir, file };
}

export function writeView(dir: string, file: string | null): string {
  return JSON.stringify({ dir, file });
}

function clampOffset(value: unknown, length: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  const limit = Math.max(0, Math.trunc(length));
  return Math.min(Math.max(Math.trunc(value), 0), limit);
}

function clampScroll(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.min(Math.max(Math.trunc(value), 0), MAX_SCROLL);
}

type CursorMap = Record<string, CursorState>;

function parseCursorMap(raw: string | null | undefined): CursorMap {
  const map: CursorMap = {};
  if (typeof raw !== "string" || !raw) return map;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return map;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return map;
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    const path = storedPath(key);
    if (!path) continue;
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const entry = value as Partial<CursorState>;
    map[path] = {
      anchor: clampOffset(entry.anchor, MAX_SCROLL),
      head: clampOffset(entry.head, MAX_SCROLL),
      scrollTop: clampScroll(entry.scrollTop),
    };
  }
  return map;
}

/** Returns the remembered caret for `path`, clamped to the current document. */
export function readCursor(
  raw: string | null | undefined,
  path: string,
  length: number,
): CursorState | null {
  const map = parseCursorMap(raw);
  const entry = map[path];
  if (!entry) return null;
  const anchor = clampOffset(entry.anchor, length);
  const head = clampOffset(entry.head, length);
  const scrollTop = clampScroll(entry.scrollTop);
  if (anchor === 0 && head === 0 && scrollTop === 0) return null;
  return { anchor, head, scrollTop };
}

/** Stores the caret for one file, keeping the newest `limit` files. */
export function writeCursor(
  raw: string | null | undefined,
  path: string,
  cursor: CursorState,
  length: number,
  limit: number = MAX_CURSOR_FILES,
): string {
  const map = parseCursorMap(raw);
  delete map[path];
  map[path] = {
    anchor: clampOffset(cursor?.anchor, length),
    head: clampOffset(cursor?.head, length),
    scrollTop: clampScroll(cursor?.scrollTop),
  };
  const keys = Object.keys(map);
  const keep = Math.max(1, Math.trunc(limit) || MAX_CURSOR_FILES);
  for (const stale of keys.slice(0, Math.max(0, keys.length - keep))) {
    delete map[stale];
  }
  return JSON.stringify(map);
}
