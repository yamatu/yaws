import { useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  History,
  MessageSquarePlus,
  Pencil,
  RefreshCw,
  Search,
  Trash2,
  X,
} from "lucide-react";
import {
  filterConversations,
  groupConversations,
  relativeTime,
  type Conversation,
} from "./conversations";

/**
 * Conversation browser: search, day buckets, model and turn count on every row,
 * inline rename and delete. It replaces the plain `<select>` so a long history
 * stays usable.
 */
export function ConversationPicker({
  conversations,
  currentId,
  busy,
  onSelect,
  onNew,
  onRename,
  onDelete,
  onRefresh,
}: {
  conversations: Conversation[];
  currentId: string;
  busy: boolean;
  onSelect: (id: string) => void;
  onNew: () => void;
  onRename: (id: string, title: string) => Promise<void> | void;
  onDelete: (id: string) => Promise<void> | void;
  onRefresh: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const [renaming, setRenaming] = useState("");
  const [confirming, setConfirming] = useState("");
  const [draft, setDraft] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const root = useRef<HTMLDivElement | null>(null);
  const search = useRef<HTMLInputElement | null>(null);

  const current = conversations.find((item) => item.id === currentId);
  const groups = useMemo(
    () => groupConversations(filterConversations(conversations, query), now),
    [conversations, query, now],
  );
  const visible = useMemo(() => groups.flatMap((group) => group.items), [groups]);

  useEffect(() => {
    if (!open) return;
    setNow(Date.now());
    setCursor(
      Math.max(
        0,
        visible.findIndex((item) => item.id === currentId),
      ),
    );
    const focus = window.setTimeout(() => search.current?.focus(), 0);
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    // Escape closes from anywhere: rows can vanish while they hold the focus.
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setRenaming("");
      setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      window.clearTimeout(focus);
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
    // The cursor is only recomputed when the popover opens, on purpose.
  }, [open]);
  const active = Math.min(cursor, Math.max(0, visible.length - 1));

  function commitRename() {
    const title = draft.trim();
    const id = renaming;
    setRenaming("");
    if (title && id) void onRename(id, title);
  }

  return (
    <div className="ai-conv" ref={root}>
      <button
        type="button"
        className="ai-conv-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="选择对话"
        title={current?.title || "新对话"}
        disabled={busy}
        onClick={() => setOpen((value) => !value)}
      >
        <History size={14} />
        <span className="ai-conv-title">{current?.title || "新对话"}</span>
        <ChevronDown size={14} />
      </button>
      {open && (
        <div
          className="ai-conv-pop"
          role="dialog"
          aria-label="对话历史"
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setCursor(Math.min(visible.length - 1, active + 1));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setCursor(Math.max(0, active - 1));
            } else if (event.key === "Enter" && !renaming) {
              const item = visible[active];
              if (item) {
                event.preventDefault();
                onSelect(item.id);
                setOpen(false);
              }
            }
          }}
        >
          <div className="ai-conv-top">
            <label className="ai-conv-search">
              <Search size={14} />
              <input
                ref={search}
                className="yaws-input"
                value={query}
                placeholder="搜索标题、目录或内容"
                aria-label="搜索对话"
                onChange={(event) => setQuery(event.target.value)}
              />
              {query ? (
                <button
                  type="button"
                  className="icon-btn"
                  aria-label="清除搜索"
                  onClick={() => setQuery("")}
                >
                  <X size={13} />
                </button>
              ) : null}
            </label>
            <button
              type="button"
              className="icon-btn"
              title="刷新"
              aria-label="刷新对话列表"
              onClick={onRefresh}
            >
              <RefreshCw size={15} />
            </button>
          </div>
          <button
            type="button"
            className="ai-conv-new"
            onClick={() => {
              onNew();
              setOpen(false);
            }}
          >
            <MessageSquarePlus size={15} />
            新对话
          </button>
          <div className="ai-conv-list">
            {visible.length === 0 ? (
              <p className="ai-conv-empty">
                {conversations.length ? "没有匹配的对话" : "还没有历史对话"}
              </p>
            ) : null}
            {groups.map((group) => (
              <div key={group.key} className="ai-conv-group">
                <div className="ai-conv-group-label">{group.label}</div>
                {group.items.map((item) => {
                  const index = visible.indexOf(item);
                  const isCurrent = item.id === currentId;
                  if (item.id === renaming)
                    return (
                      <div key={item.id} className="ai-conv-rename">
                        <input
                          className="yaws-input"
                          value={draft}
                          aria-label="对话名称"
                          autoFocus
                          onChange={(event) => setDraft(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") {
                              event.preventDefault();
                              commitRename();
                            } else if (event.key === "Escape") {
                              event.preventDefault();
                              setRenaming("");
                            }
                          }}
                        />
                        <button
                          type="button"
                          className="icon-btn"
                          aria-label="保存名称"
                          onClick={commitRename}
                        >
                          <Check size={14} />
                        </button>
                        <button
                          type="button"
                          className="icon-btn"
                          aria-label="取消重命名"
                          onClick={() => setRenaming("")}
                        >
                          <X size={14} />
                        </button>
                      </div>
                    );
                  if (item.id === confirming)
                    return (
                      <div key={item.id} className="ai-conv-confirm">
                        <span>删除「{item.title || "未命名"}」？</span>
                        <button
                          type="button"
                          className="icon-btn"
                          aria-label="确认删除"
                          onClick={() => {
                            setConfirming("");
                            void onDelete(item.id);
                          }}
                        >
                          <Check size={14} />
                        </button>
                        <button
                          type="button"
                          className="icon-btn"
                          aria-label="取消删除"
                          onClick={() => setConfirming("")}
                        >
                          <X size={14} />
                        </button>
                      </div>
                    );
                  return (
                    <div
                      key={item.id}
                      className={`ai-conv-row${isCurrent ? " active" : ""}${
                        index === active ? " cursor" : ""
                      }`}
                    >
                      <button
                        type="button"
                        className="ai-conv-pick"
                        onClick={() => {
                          onSelect(item.id);
                          setOpen(false);
                        }}
                      >
                        <span className="ai-conv-line">
                          <span className="ai-conv-name">
                            {item.title || "未命名"}
                          </span>
                          <span className="ai-conv-time">
                            {relativeTime(now, item.updatedAt)}
                          </span>
                        </span>
                        <span className="ai-conv-meta">
                          {item.turns} 轮 · {item.root}
                          {item.model ? ` · ${item.model}` : ""}
                          {item.hosts?.length
                            ? ` · 主机 ${item.hosts.length + 1} 台`
                            : ""}
                          {item.lastStatus === "failed" ? " · 上次失败" : ""}
                        </span>
                        {item.preview ? (
                          <span className="ai-conv-preview">{item.preview}</span>
                        ) : null}
                      </button>
                      <span className="ai-conv-actions">
                        <button
                          type="button"
                          className="icon-btn"
                          title="重命名"
                          aria-label={`重命名 ${item.title || "未命名"}`}
                          onClick={() => {
                            setRenaming(item.id);
                            setDraft(item.title || "");
                          }}
                        >
                          <Pencil size={13} />
                        </button>
                        <button
                          type="button"
                          className="icon-btn"
                          title="删除"
                          aria-label={`删除 ${item.title || "未命名"}`}
                          onClick={() => setConfirming(item.id)}
                        >
                          <Trash2 size={13} />
                        </button>
                      </span>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
          <div className="ai-conv-foot">
            共 {conversations.length} 个对话 · ↑↓ 选择，Enter 进入，Esc 关闭
          </div>
        </div>
      )}
    </div>
  );
}
