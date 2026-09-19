import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { placeMenu, type Placement } from "./floating";

/**
 * A popup rendered into `document.body` and positioned against `anchor`, so no
 * ancestor with `overflow: hidden` (docks, scroll panes, cards) can clip it.
 * The position follows the anchor while the window scrolls, resizes or the dock
 * is dragged, and the panel closes on an outside click or Escape.
 */
export function FloatingPanel({
  anchor,
  className,
  label,
  onClose,
  children,
}: {
  anchor: HTMLElement | null;
  className?: string;
  /** Accessible name of the popup. */
  label: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [style, setStyle] = useState<Placement | null>(null);

  useLayoutEffect(() => {
    let frame = 0;
    let last = "";
    const measure = () => {
      frame = window.requestAnimationFrame(measure);
      const panel = ref.current;
      if (!anchor || !panel) return;
      const rect = anchor.getBoundingClientRect();
      const box = panel.getBoundingClientRect();
      const next = placeMenu(
        { top: rect.top, bottom: rect.bottom, left: rect.left },
        // The measured height is the rendered one (already capped by max-height).
        { width: box.width || 260, height: box.height || 1 },
        { width: window.innerWidth, height: window.innerHeight },
      );
      const key = `${next.left}|${next.top}|${next.width}`;
      if (key === last) return;
      last = key;
      setStyle(next);
    };
    measure();
    return () => window.cancelAnimationFrame(frame);
  }, [anchor]);

  useEffect(() => {
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (ref.current?.contains(target) || anchor?.contains(target)) return;
      onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("pointerdown", onPointer, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [anchor, onClose]);

  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-label={label}
      className={className}
      style={{
        position: "fixed",
        left: style?.left ?? 0,
        top: style?.top ?? 0,
        width: style?.width,
        visibility: style ? "visible" : "hidden",
      }}
      data-open-up={style?.openUp ? "true" : undefined}
    >
      {children}
    </div>,
    document.body,
  );
}
