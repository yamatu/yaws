export type AnchorRect = { top: number; bottom: number; left: number };
export type MenuSize = { width: number; height: number };
export type Placement = {
  left: number;
  top: number;
  width: number;
  openUp: boolean;
};

const EDGE = 8;
const GAP = 6;

function clamp(value: number, low: number, high: number) {
  if (high < low) return low;
  return Math.min(Math.max(value, low), high);
}

/**
 * Places a popup next to its button so that it always fits in the window.
 *
 * The host picker hangs off the assistant composer at the bottom of a fixed
 * dock, where an `absolute` menu is cut off by the dock's own `overflow: hidden`
 * and a below-the-button menu falls off-screen. This keeps the panel inside the
 * viewport: it flips above the button when there is no room below.
 */
export function placeMenu(
  anchor: AnchorRect,
  menu: MenuSize,
  viewport: MenuSize,
  gap = GAP,
): Placement {
  const width = Math.min(menu.width, Math.max(0, viewport.width - EDGE * 2));
  const left = clamp(anchor.left, EDGE, viewport.width - width - EDGE);
  const roomBelow = viewport.height - anchor.bottom - gap;
  const roomAbove = anchor.top - gap;
  const openUp = roomBelow < menu.height && roomAbove > roomBelow;
  const maxTop = Math.max(EDGE, viewport.height - menu.height - EDGE);
  const top = openUp
    ? clamp(anchor.top - gap - menu.height, EDGE, maxTop)
    : clamp(anchor.bottom + gap, EDGE, maxTop);
  return { left, top, width, openUp };
}
