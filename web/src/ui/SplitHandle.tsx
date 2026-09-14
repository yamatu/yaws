import { useCallback, useEffect, useRef, useState } from "react";
import {
  SPLIT_DEFAULT,
  SPLIT_MAX,
  SPLIT_MIN,
  clampSplit,
  splitFromPointer,
  splitStep,
  type Orientation,
} from "./splitter";

const NARROW = "(max-width: 760px)";

/** True while the panes are stacked, which swaps the divider orientation. */
function useOrientation(): Orientation {
  const [orientation, setOrientation] = useState<Orientation>(() =>
    typeof window === "undefined" || !window.matchMedia?.(NARROW).matches
      ? "vertical"
      : "horizontal",
  );
  useEffect(() => {
    const query = window.matchMedia?.(NARROW);
    if (!query) return;
    const update = () =>
      setOrientation(query.matches ? "horizontal" : "vertical");
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return orientation;
}

/**
 * The divider between the workspace panes. Dragging it, using the arrow keys
 * or double clicking (reset) all funnel into the same `onChange`.
 */
export function SplitHandle({
  value,
  onChange,
  label,
}: {
  value: number;
  onChange: (percent: number) => void;
  label: string;
}) {
  const orientation = useOrientation();
  const handle = useRef<HTMLDivElement | null>(null);
  const [active, setActive] = useState(false);

  const apply = useCallback(
    (percent: number) => onChange(clampSplit(percent)),
    [onChange],
  );

  useEffect(() => {
    if (!active) return;
    const move = (event: PointerEvent) => {
      const container = handle.current?.parentElement;
      if (!container) return;
      apply(
        splitFromPointer(
          container.getBoundingClientRect(),
          event.clientX,
          event.clientY,
          orientation,
        ),
      );
    };
    const stop = () => setActive(false);
    document.body.classList.add("splitting");
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    return () => {
      document.body.classList.remove("splitting");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
  }, [active, apply, orientation]);

  return (
    <div
      ref={handle}
      className={`workspace-splitter${active ? " active" : ""}`}
      role="separator"
      aria-orientation={orientation}
      aria-label={label}
      aria-valuenow={Math.round(value)}
      aria-valuemin={SPLIT_MIN}
      aria-valuemax={SPLIT_MAX}
      tabIndex={0}
      title="拖动调整比例，双击恢复默认"
      onPointerDown={(event) => {
        // Only the primary button drags; the arrow keys keep working for keyboards.
        if (event.button !== 0) return;
        event.preventDefault();
        setActive(true);
      }}
      onDoubleClick={() => apply(SPLIT_DEFAULT)}
      onKeyDown={(event) => {
        if (event.key === "Home" || event.key === "End") {
          event.preventDefault();
          apply(event.key === "Home" ? SPLIT_MIN : SPLIT_MAX);
          return;
        }
        const step = splitStep(event.key, event.shiftKey);
        if (step === null) return;
        event.preventDefault();
        apply(value + step);
      }}
    >
      <span className="workspace-splitter-grip" aria-hidden="true" />
    </div>
  );
}
