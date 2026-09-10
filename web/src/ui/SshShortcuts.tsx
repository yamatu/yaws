import { useEffect, useState } from "react";
import { Plus, Play, Pencil, Trash2, CornerDownLeft, Save } from "lucide-react";
import { apiFetch } from "./api";
import { workspaceError } from "./workspaceErrors";
type Shortcut = { id: number; name: string; command: string };
export function SshShortcuts({
  machineId,
  connected,
  send,
}: {
  machineId: number;
  connected: boolean;
  send: (command: string) => void;
}) {
  const base = `/api/machines/${machineId}/workspace/shortcuts`;
  const [items, setItems] = useState<Shortcut[]>([]),
    [edit, setEdit] = useState<Partial<Shortcut> | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
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
        <h2 className="flex-1 text-sm font-semibold">快捷指令</h2>
        <button
          className="icon-btn"
          title="添加指令"
          aria-label="添加指令"
          onClick={() => setEdit({ name: "", command: "" })}
        >
          <Plus size={17} />
        </button>
      </div>
      {error && (
        <div role="alert" className="yaws-alert-error">
          {error}
        </div>
      )}
      {edit && (
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
      {items.map((item) => (
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
    </aside>
  );
}
