import { Sparkles, X } from "lucide-react";
import { AiChat } from "./AiChat";

/**
 * Floating add-on panel: the assistant stays reachable while the terminal, the file editor or
 * any other tab owns the screen. Same machine context as the workspace underneath.
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
  return (
    <aside className="ai-dock" aria-label="AI 助手">
      <div className="ai-dock-head">
        <Sparkles size={16} />
        <strong className="flex-1 text-sm">AI 助手</strong>
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
    </aside>
  );
}
