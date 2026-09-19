import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, Plug, Plus, Save } from "lucide-react";
import { apiFetch, type Machine } from "./api";
import { workspaceError } from "./workspaceErrors";
import { viaChildren } from "./sshVia";

type Draft = {
  name: string;
  host: string;
  port: number;
  user: string;
  authType: "password" | "key";
  secret: string;
};

const EMPTY: Draft = {
  name: "",
  host: "",
  port: 22,
  user: "root",
  authType: "password",
  secret: "",
};

/**
 * Internal hosts that are only reachable from this machine. They are ordinary
 * machines with `viaMachineId` set to this one, so opening one here is the same
 * WebSSH as everywhere else — the server just relays through this box.
 */
export function InternalHosts({
  machineId,
  onOpen,
}: {
  machineId: number;
  /** Navigate to another machine's terminal, keeping the multi-session page. */
  onOpen: (id: number) => void;
}) {
  const [hosts, setHosts] = useState<Machine[]>([]);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [created, setCreated] = useState<{ id: number; name: string } | null>(
    null,
  );

  const load = () =>
    apiFetch<{ machines: Machine[] }>("/api/machines")
      .then((r) => setHosts(r.machines))
      .catch(() => {});

  useEffect(() => {
    void load();
    setDraft(null);
    setCreated(null);
    setError("");
  }, [machineId]);

  const children = viaChildren(hosts, machineId);

  async function create() {
    if (!draft) return;
    setBusy(true);
    setError("");
    try {
      const res = await apiFetch<{ machine: Machine }>("/api/machines", {
        method: "POST",
        body: JSON.stringify({
          name: draft.name.trim(),
          viaMachineId: machineId,
          sshHost: draft.host.trim(),
          sshPort: draft.port,
          sshUser: draft.user.trim(),
          sshAuthType: draft.authType,
          ...(draft.authType === "key"
            ? { sshPrivateKey: draft.secret }
            : { sshPassword: draft.secret }),
        }),
      });
      await load();
      setCreated({ id: res.machine.id, name: res.machine.name });
      setDraft(null);
      setOpen(true);
    } catch (e) {
      setError(workspaceError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="shortcut-panel-section">
      <div className="workspace-toolbar">
        <button
          type="button"
          className="shortcut-toggle"
          aria-expanded={open}
          aria-controls="internal-host-list"
          title={open ? "收起内网主机" : "展开内网主机"}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          <span className="flex-1 text-sm font-semibold">内网 SSH</span>
          {children.length > 0 && (
            <span className="shortcut-count" title={`${children.length} 台内网主机`}>
              {children.length}
            </span>
          )}
        </button>
        <button
          className="icon-btn"
          title="添加内网机器"
          aria-label="添加内网机器"
          onClick={() => {
            setOpen(true);
            setCreated(null);
            setDraft({ ...EMPTY });
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
      <div id="internal-host-list" hidden={!open} className="shortcut-body">
        {open && created && (
          <div className="shortcut-note" role="status">
            已添加内网主机 {created.name}（#{created.id}）。
            <button
              type="button"
              className="yaws-btn tool-text"
              onClick={() => onOpen(created.id)}
            >
              连接
            </button>
          </div>
        )}
        {open && draft && (
          <form
            className="shortcut-form"
            onSubmit={(e) => {
              e.preventDefault();
              void create();
            }}
          >
            <input
              className="yaws-input"
              aria-label="内网机器名称"
              placeholder="名称"
              required
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
            <input
              className="yaws-input"
              aria-label="内网地址"
              placeholder="内网地址，例如 10.0.0.8"
              required
              autoComplete="off"
              value={draft.host}
              onChange={(e) => setDraft({ ...draft, host: e.target.value })}
            />
            <div className="flex gap-2">
              <input
                className="yaws-input"
                aria-label="端口"
                type="number"
                min={1}
                max={65535}
                value={draft.port}
                onChange={(e) =>
                  setDraft({ ...draft, port: Number(e.target.value) })
                }
              />
              <input
                className="yaws-input"
                aria-label="用户名"
                placeholder="用户名"
                required
                autoComplete="off"
                value={draft.user}
                onChange={(e) => setDraft({ ...draft, user: e.target.value })}
              />
            </div>
            <select
              className="yaws-select w-full text-sm"
              aria-label="认证方式"
              value={draft.authType}
              onChange={(e) =>
                setDraft({ ...draft, authType: e.target.value as any })
              }
            >
              <option value="password">密码</option>
              <option value="key">私钥</option>
            </select>
            {draft.authType === "password" ? (
              <input
                className="yaws-input"
                aria-label="密码"
                type="password"
                placeholder="密码"
                autoComplete="new-password"
                data-lpignore="true"
                value={draft.secret}
                onChange={(e) => setDraft({ ...draft, secret: e.target.value })}
              />
            ) : (
              <textarea
                className="yaws-input font-mono text-xs"
                aria-label="私钥"
                placeholder="粘贴私钥内容"
                rows={4}
                autoComplete="off"
                value={draft.secret}
                onChange={(e) => setDraft({ ...draft, secret: e.target.value })}
              />
            )}
            <div className="shortcut-hint">
              连接时会先经过 {`#${machineId}`}，第一次需要确认内网主机指纹。
            </div>
            <div className="flex gap-2">
              <button className="yaws-btn-primary tool-text" disabled={busy}>
                <Save size={15} />
                保存
              </button>
              <button
                type="button"
                className="yaws-btn"
                onClick={() => setDraft(null)}
              >
                取消
              </button>
            </div>
          </form>
        )}
        {open && children.length === 0 && !draft && !created && (
          <p className="shortcut-empty">
            还没有经由本机连接的内网主机，点右上角 + 添加一台。
          </p>
        )}
        {open &&
          children.map((host) => (
            <div className="shortcut-item" key={host.id}>
              <strong>{host.name}</strong>
              <pre>
                {host.sshUser || "—"}@{host.sshHost || "未配置"}:
                {host.sshPort ?? 22}
              </pre>
              <div className="flex gap-1">
                <button
                  className="yaws-btn tool-text"
                  title="打开终端"
                  onClick={() => onOpen(host.id)}
                >
                  <Plug size={15} />
                  连接
                </button>
              </div>
            </div>
          ))}
      </div>
    </section>
  );
}
