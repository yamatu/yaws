/**
 * Geometry for the floating assistant panel. Everything is kept inside the
 * viewport so a drag can never lose the panel off-screen.
 */
export type Box = { x: number; y: number; w: number; h: number };
export type Viewport = { width: number; height: number };

export const DOCK_KEY = "yaws.ai.dock";
export const MIN_DOCK_W = 320;
// Tall enough for the header, the composer and a usable transcript.
export const MIN_DOCK_H = 360;
export const DOCK_EDGE = 8;

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export function clampSize(
  w: number,
  h: number,
  viewport: Viewport,
): { w: number; h: number } {
  return {
    w: clamp(w, MIN_DOCK_W, Math.max(MIN_DOCK_W, viewport.width - DOCK_EDGE * 2)),
    h: clamp(h, MIN_DOCK_H, Math.max(MIN_DOCK_H, viewport.height - DOCK_EDGE * 2)),
  };
}

export function clampBox(box: Box, viewport: Viewport): Box {
  const { w, h } = clampSize(box.w, box.h, viewport);
  return {
    w,
    h,
    x: clamp(box.x, DOCK_EDGE, Math.max(DOCK_EDGE, viewport.width - w - DOCK_EDGE)),
    y: clamp(
      box.y,
      DOCK_EDGE,
      Math.max(DOCK_EDGE, viewport.height - h - DOCK_EDGE),
    ),
  };
}

export function moveBox(
  box: Box,
  dx: number,
  dy: number,
  viewport: Viewport,
): Box {
  return clampBox({ ...box, x: box.x + dx, y: box.y + dy }, viewport);
}

export function resizeBox(
  box: Box,
  dx: number,
  dy: number,
  viewport: Viewport,
): Box {
  // The top-left corner is the anchor, so growing never shifts the panel; the
  // remaining space to the right/bottom edge is the limit.
  const maxW = Math.max(MIN_DOCK_W, viewport.width - box.x - DOCK_EDGE);
  const maxH = Math.max(MIN_DOCK_H, viewport.height - box.y - DOCK_EDGE);
  return {
    x: box.x,
    y: box.y,
    w: clamp(box.w + dx, MIN_DOCK_W, maxW),
    h: clamp(box.h + dy, MIN_DOCK_H, maxH),
  };
}

export function parseBox(raw: string | null): Box | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<Box>;
    if (
      typeof value?.x !== "number" ||
      typeof value?.y !== "number" ||
      typeof value?.w !== "number" ||
      typeof value?.h !== "number" ||
      ![value.x, value.y, value.w, value.h].every(Number.isFinite)
    )
      return null;
    return { x: value.x, y: value.y, w: value.w, h: value.h };
  } catch {
    return null;
  }
}

export function viewportOf(): Viewport {
  if (typeof window === "undefined") return { width: 1280, height: 800 };
  return {
    width: window.innerWidth || 1280,
    height: window.innerHeight || 800,
  };
}
