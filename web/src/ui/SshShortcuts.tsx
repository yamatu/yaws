import { useEffect, useState } from "react";
import {
  Plus,
  Play,
  Pencil,
  Trash2,
  CornerDownLeft,
  Save,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import { apiFetch } from "./api";
import { workspaceError } from "./workspaceErrors";
import { ServerStatsPanel } from "./ServerStatsPanel";
type Shortcut = { id: number; name: string; command: string };

const OPEN_KEY = "yaws.shortcuts.open";

/** Remember the collapsed state so a deliberate choice survives a reload. */
function storedOpen(): boolean {
  try {
    return window.localStorage.getItem(OPEN_KEY) === "1";
  } catch {
    return false;
  }
}

export function SshShortcuts({
  machineId,
  connected,
  trusted,
  send,
}: {
  machineId: number;
  connected: boolean;
  trusted: boolean;
  send: (command: string) => void;
}) {
  const base = `/api/machines/${machineId}/workspace/shortcuts`;
  const [items, setItems] = useState<Shortcut[]>([]),
    [edit, setEdit] = useState<Partial<Shortcut> | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    // Collapsed by default: the sidebar is narrow and the resource panel below it
    // deserves the space until the user asks for the command list.
    [open, setOpen] = useState(storedOpen);
  const toggle = (next: boolean) => {
    setOpen(next);
    try {
      window.localStorage.setItem(OPEN_KEY, next ? "1" : "0");
    } catch {
      /* private mode: the choice is simply not remembered */
    }
  };
  useEffect(() => {
    const ac = new AbortController();
    void apiFetch<{ shortcuts: Shortcut[] }>(base, { signal: ac.signal })
      .then((r) => setItems(r.shortcuts))
      .catch((e: unknown) => {
        if (!ac.signal.aborted) setError(workspaceError(e));
      });
    return () => ac.abort();
  }, [base]);
  async function save() {
    if (!edit) return;
    setBusy(true);
    setError("");
    try {
      await apiFetch(edit.id ? `${base}/${edit.id}` : base, {
        method: edit.id ? "PUT" : "POST",
        body: JSON.stringify({ name: edit.name, command: edit.command }),
      });
      const r = await apiFetch<{ shortcuts: Shortcut[] }>(base);
      setItems(r.shortcuts);
      setEdit(null);
      toggle(true);
    } catch (e) {
      setError(workspaceError(e));
    } finally {
      setBusy(false);
    }
  }
  async function remove(item: Shortcut) {
    setError("");
    try {
      await apiFetch(`${base}/${item.id}`, { method: "DELETE" });
      setItems((v) => v.filter((i) => i.id !== item.id));
    } catch (e) {
      setError(workspaceError(e));
    }
  }
  return (
    <aside className="shortcut-panel">
      <div className="workspace-toolbar">
        <button
          type="button"
          className="shortcut-toggle"
          aria-expanded={open}
          aria-controls="shortcut-list"
          title={open ? "收起快捷指令" : "展开快捷指令"}
          onClick={() => toggle(!open)}
        >
          {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          <span className="flex-1 text-sm font-semibold">快捷指令</span>
          {items.length > 0 && (
            <span className="shortcut-count" title={`已保存 ${items.length} 条`}>
              {items.length}
            </span>
          )}
        </button>
        <button
          className="icon-btn"
          title="添加指令"
          aria-label="添加指令"
          onClick={() => {
            toggle(true);
            setEdit({ name: "", command: "" });
          }}
        >
          <Plus size={17} />
        </button>
      </div>
      {error && (
        <div role="alert" className="yaws-alert-error">
          {error}
        </div>
      )}
      <div id="shortcut-list" hidden={!open} className="shortcut-body">
        {open && edit && (
          <form
            className="shortcut-form"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <input
              className="yaws-input"
              aria-label="指令名称"
              placeholder="名称"
              required
              value={edit.name ?? ""}
              onChange={(e) => setEdit({ ...edit, name: e.target.value })}
            />
            <textarea
              className="yaws-input font-mono"
              aria-label="指令内容"
              placeholder="命令"
              rows={5}
              required
              value={edit.command ?? ""}
              onChange={(e) => setEdit({ ...edit, command: e.target.value })}
            />
            <div className="flex gap-2">
              <button className="yaws-btn-primary tool-text" disabled={busy}>
                <Save size={15} />
                保存
              </button>
              <button
                type="button"
                className="yaws-btn"
                onClick={() => setEdit(null)}
              >
                取消
              </button>
            </div>
          </form>
        )}
        {open && items.length === 0 && !edit && (
          <p className="shortcut-empty">
            还没有快捷指令，点右上角 + 添加一条，之后可一键插入或执行。
          </p>
        )}
        {open &&
          items.map((item) => (
            <div className="shortcut-item" key={item.id}>
              <strong>{item.name}</strong>
              <pre>{item.command}</pre>
              <div className="flex gap-1">
                <button
                  className="icon-btn"
                  title="插入终端"
                  aria-label={`插入 ${item.name}`}
                  disabled={!connected}
                  onClick={() => send(item.command)}
                >
                  <CornerDownLeft size={15} />
                </button>
                <button
                  className="icon-btn"
                  title="执行指令"
                  aria-label={`执行 ${item.name}`}
                  disabled={!connected}
                  onClick={() => {
                    if (window.confirm(`在当前机器执行？\n${item.command}`))
                      send(item.command + "\r");
                  }}
                >
                  <Play size={15} />
                </button>
                <button
                  className="icon-btn"
                  title="编辑指令"
                  aria-label={`编辑 ${item.name}`}
                  onClick={() => setEdit(item)}
                >
                  <Pencil size={15} />
                </button>
                <button
                  className="icon-btn"
                  title="删除指令"
                  aria-label={`删除 ${item.name}`}
                  onClick={() => void remove(item)}
                >
                  <Trash2 size={15} />
                </button>
              </div>
            </div>
          ))}
      </div>
      <ServerStatsPanel machineId={machineId} enabled={trusted} />
    </aside>
  );
}
