import { useCallback, useEffect, useRef, useState } from "react";
import { GripHorizontal, Move, Sparkles, X } from "lucide-react";
import { AiChat } from "./AiChat";
import {
  DOCK_KEY,
  clampBox,
  moveBox,
  parseBox,
  resizeBox,
  viewportOf,
  type Box,
} from "./dockBox";

function storedBox(): Box | null {
  try {
    return parseBox(localStorage.getItem(DOCK_KEY));
  } catch {
    return null;
  }
}

/**
 * Floating add-on panel: the assistant stays reachable while the terminal, the file editor or
 * any other tab owns the screen. Same machine context as the workspace underneath.
 *
 * The panel is dragged by its header and resized from its corner; both the
 * position and the size survive a reload, and a double click on the header
 * sends it back to the default corner.
 */
export function AiChatDock({
  machineId,
  initialRoot,
  open,
  onToggle,
  lifted = false,
}: {
  machineId: number;
  initialRoot: string;
  open: boolean;
  onToggle: (open: boolean) => void;
  /** Raised above the touch key bar so it never covers the terminal keys. */
  lifted?: boolean;
}) {
  const [box, setBox] = useState<Box | null>(storedBox);
  const [drag, setDrag] = useState<"move" | "size" | "">("");
  const panel = useRef<HTMLElement | null>(null);
  const origin = useRef({ x: 0, y: 0, box: null as Box | null });

  const save = useCallback((next: Box | null) => {
    try {
      if (next) localStorage.setItem(DOCK_KEY, JSON.stringify(next));
      else localStorage.removeItem(DOCK_KEY);
    } catch {
      // private mode
    }
  }, []);

  const rectOf = useCallback((): Box | null => {
    const node = panel.current;
    if (!node) return null;
    const rect = node.getBoundingClientRect();
    return { x: rect.left, y: rect.top, w: rect.width, h: rect.height };
  }, []);

  useEffect(() => {
    if (!drag) return;
    const move = (event: PointerEvent) => {
      const start = origin.current.box;
      if (!start) return;
      const dx = event.clientX - origin.current.x;
      const dy = event.clientY - origin.current.y;
      setBox(
        drag === "move"
          ? moveBox(start, dx, dy, viewportOf())
          : resizeBox(start, dx, dy, viewportOf()),
      );
    };
    const stop = () => {
      setDrag("");
      // The DOM already holds the final rect, so persist exactly what is seen.
      const rect = rectOf();
      if (!rect) return;
      const next = clampBox(rect, viewportOf());
      setBox(next);
      save(next);
    };
    document.body.classList.add(drag === "move" ? "dragging" : "resizing");
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    return () => {
      document.body.classList.remove("dragging", "resizing");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
  }, [drag, rectOf, save]);

  // Shrinking the window must not hide the panel behind the viewport edge.
  useEffect(() => {
    const fit = () =>
      setBox((current) => {
        if (!current) return current;
        const next = clampBox(current, viewportOf());
        if (
          next.x === current.x &&
          next.y === current.y &&
          next.w === current.w &&
          next.h === current.h
        )
          return current;
        save(next);
        return next;
      });
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [save]);

  if (!open)
    return (
      <button
        className={`ai-fab${lifted ? " lifted" : ""}`}
        title="AI 助手"
        aria-label="AI 助手"
        aria-expanded={false}
        onClick={() => onToggle(true)}
      >
        <Sparkles size={17} />
        AI 助手
      </button>
    );

  const start = (mode: "move" | "size") => (event: React.PointerEvent) => {
    if (event.button !== 0) return;
    const current = rectOf();
    if (!current) return;
    // Convert the CSS default placement into explicit coordinates first so the
    // panel does not jump when the drag starts.
    const placed = clampBox(current, viewportOf());
    setBox(placed);
    origin.current = { x: event.clientX, y: event.clientY, box: placed };
    setDrag(mode);
  };

  return (
    <aside
      ref={panel}
      className={`ai-dock${drag ? " dragging" : ""}`}
      aria-label="AI 助手"
      style={
        box
          ? {
              left: box.x,
              top: box.y,
              width: box.w,
              height: box.h,
              right: "auto",
              bottom: "auto",
            }
          : undefined
      }
    >
      <div
        className="ai-dock-head"
        title="拖动移动，双击回到默认位置"
        onPointerDown={(event) => {
          if ((event.target as HTMLElement).closest("button,input,select,a"))
            return;
          start("move")(event);
        }}
        onDoubleClick={() => {
          setBox(null);
          save(null);
        }}
        onKeyDown={(event) => {
          const step = event.shiftKey ? 48 : 16;
          const deltas: Record<string, [number, number]> = {
            ArrowLeft: [-step, 0],
            ArrowRight: [step, 0],
            ArrowUp: [0, -step],
            ArrowDown: [0, step],
          };
          const delta = deltas[event.key];
          if (!delta) return;
          event.preventDefault();
          setBox((current) => {
            const base = current ?? rectOf();
            if (!base) return current;
            const next = moveBox(base, delta[0], delta[1], viewportOf());
            save(next);
            return next;
          });
        }}
        tabIndex={0}
        role="toolbar"
        aria-label="AI 助手标题栏，方向键可移动面板"
      >
        <Move size={14} className="ai-dock-grip" />
        <strong className="flex-1 truncate text-sm">AI 助手</strong>
        <button
          className="icon-btn"
          title="收起 AI 助手"
          aria-label="收起 AI 助手"
          aria-expanded={true}
          onClick={() => onToggle(false)}
        >
          <X size={17} />
        </button>
      </div>
      <AiChat machineId={machineId} initialRoot={initialRoot} compact />
      <span
        className="ai-dock-resize"
        title="拖动调整大小"
        aria-hidden="true"
        onPointerDown={start("size")}
      >
        <GripHorizontal size={14} />
      </span>
    </aside>
  );
}
