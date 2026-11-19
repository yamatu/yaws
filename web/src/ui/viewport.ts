import { useEffect, useState } from "react";

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(
    () => typeof window !== "undefined" && (window.matchMedia?.(query).matches ?? false),
  );
  useEffect(() => {
    const list = window.matchMedia?.(query);
    if (!list) return;
    const update = () => setMatches(list.matches);
    update();
    list.addEventListener("change", update);
    return () => list.removeEventListener("change", update);
  }, [query]);
  return matches;
}

export type VisibleArea = { top: number; height: number };

function readArea(): VisibleArea {
  const vv = window.visualViewport;
  return vv
    ? { top: Math.max(0, vv.offsetTop), height: vv.height }
    : { top: 0, height: window.innerHeight };
}

/**
 * The part of the page the on-screen keyboard leaves visible. iOS Safari does
 * not shrink the layout for the keyboard, so a fixed sheet sized from this is
 * the only way to keep its input above the keys.
 */
export function useVisibleArea(enabled: boolean): VisibleArea | null {
  const [area, setArea] = useState<VisibleArea | null>(() =>
    enabled && typeof window !== "undefined" ? readArea() : null,
  );
  useEffect(() => {
    if (!enabled) {
      setArea(null);
      return;
    }
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setArea(readArea()));
    };
    update();
    const vv = window.visualViewport;
    vv?.addEventListener("resize", update);
    vv?.addEventListener("scroll", update);
    window.addEventListener("resize", update);
    return () => {
      cancelAnimationFrame(frame);
      vv?.removeEventListener("resize", update);
      vv?.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, [enabled]);
  return area;
}

/**
 * iOS leaves the page scrolled after the keyboard closes, which cuts off the
 * top of a full-height layout. Reset it now, over the next two frames, and once
 * more after the keyboard animation.
 */
export function repairViewportScroll() {
  const reset = () => {
    if (window.scrollY !== 0 || document.documentElement.scrollTop !== 0)
      window.scrollTo(0, 0);
  };
  reset();
  requestAnimationFrame(() => {
    reset();
    requestAnimationFrame(reset);
  });
  window.setTimeout(reset, 250);
}
