/**
 * Pure math for the draggable workspace divider. The stored value is the share
 * of the container given to the main pane (left, or top on narrow screens); the
 * terminal gets whatever is left.
 */
export const SPLIT_MIN = 25;
export const SPLIT_MAX = 78;
export const SPLIT_DEFAULT = 64;

export function clampSplit(
  percent: number,
  min = SPLIT_MIN,
  max = SPLIT_MAX,
): number {
  if (!Number.isFinite(percent)) return SPLIT_DEFAULT;
  return Math.min(max, Math.max(min, Math.round(percent * 10) / 10));
}

export type Rect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

export type Orientation = "vertical" | "horizontal";

/** Where the divider would land for a pointer position, as a percentage. */
export function splitFromPointer(
  rect: Rect,
  clientX: number,
  clientY: number,
  orientation: Orientation,
): number {
  if (orientation === "horizontal")
    return rect.height ? ((clientY - rect.top) / rect.height) * 100 : SPLIT_DEFAULT;
  return rect.width ? ((clientX - rect.left) / rect.width) * 100 : SPLIT_DEFAULT;
}

/** One arrow-key step; larger jumps with shift or PageUp/PageDown. */
export function splitStep(key: string, shift: boolean): number | null {
  const size = shift ? 10 : 2;
  if (key === "ArrowLeft" || key === "ArrowUp") return -size;
  if (key === "ArrowRight" || key === "ArrowDown") return size;
  if (key === "PageUp") return 10;
  if (key === "PageDown") return -10;
  return null;
}

export function storedSplit(raw: string | null, fallback = SPLIT_DEFAULT): number {
  if (raw === null || raw === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? clampSplit(value) : fallback;
}
