import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Plus, Search, TerminalSquare, X } from "lucide-react";
import { apiFetch, type Machine } from "./api";
import { useDocumentTitle } from "./documentTitle";
import { MachineWorkspace, type SshStatus } from "./MachineWorkspace";
import {
  MAX_SESSIONS,
  SESSIONS_KEY,
  addSession,
  closeSession,
  ensureSession,
  nextActiveSession,
  parseSessions,
  sessionRoom,
} from "./sshSessions";

function storedSessions(): number[] {
  try {
    return parseSessions(localStorage.getItem(SESSIONS_KEY));
  } catch {
    return [];
  }
}

function rememberSessions(ids: number[]) {
  try {
    localStorage.setItem(SESSIONS_KEY, JSON.stringify(ids));
  } catch {
    // private mode: the open terminals are simply not remembered
  }
}

/** A machine can host a terminal once the SSH credentials are saved. */
function sshReady(machine: Machine): boolean {
  return (
    !!machine.sshHost &&
    !!machine.sshUser &&
    (machine.sshAuthType === "key" ? !!machine.sshHasKey : !!machine.sshHasPassword)
  );
}

function statusDot(status: SshStatus | undefined) {
  return status === "connected"
    ? "bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.5)]"
    : status === "connecting"
      ? "bg-amber-400 shadow-[0_0_6px_rgba(251,191,36,0.5)]"
      : "bg-white/20";
}

/**
 * The SSH workspace drives several servers at once: every open terminal is a
 * session of its own, the strip above the workspace switches between them and
 * the open set is remembered per browser. Background terminals keep running
 * (and keep their files and assistant context) while another one is on screen.
 */
export function SshPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const machineId = Number(id);
  const isBadId = !Number.isInteger(machineId) || machineId <= 0;

  const [ids, setIds] = useState<number[]>(storedSessions);
  const [machines, setMachines] = useState<Machine[]>([]);
  const [statuses, setStatuses] = useState<Record<number, SshStatus>>({});
  const [picker, setPicker] = useState(false);
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");

  const labelFor = useCallback(
    (value: number) =>
      machines.find((m) => m.id === value)?.name ??
      (machines.length ? `#${value}` : "SSH"),
    [machines],
  );

  // The browser tab names the server that is connected.
  useDocumentTitle(isBadId ? "SSH" : labelFor(machineId));

  useEffect(() => {
    let alive = true;
    apiFetch<{ machines: Machine[] }>("/api/machines")
      .then((r) => {
        if (alive) setMachines(r.machines);
      })
      .catch(() => {
        // The workspace still works from the remembered session list.
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    rememberSessions(ids);
  }, [ids]);

  // The machine in the address bar is always open, so a bookmark or a link from
  // the bastion page never lands on an empty workspace.
  useEffect(() => {
    if (isBadId) return;
    setIds((old) => {
      const next = ensureSession(old, machineId);
      return next.length === old.length ? old : next;
    });
  }, [isBadId, machineId]);

  const open = useCallback(
    (value: number, activate = true) => {
      const next = addSession(ids, value);
      if (next.length === ids.length && !ids.includes(value)) {
        setError(`最多同时打开 ${MAX_SESSIONS} 个终端，请先关闭不用的终端`);
        return false;
      }
      setError("");
      if (next.length !== ids.length) setIds(next);
      if (activate) navigate(`/app/machines/${value}/ssh`, { replace: true });
      return true;
    },
    [ids, navigate],
  );

  const close = (value: number) => {
    const next = closeSession(ids, value);
    setIds(next);
    if (value !== machineId) return;
    const target = nextActiveSession(ids, value, machineId);
    if (target) navigate(`/app/machines/${target}/ssh`, { replace: true });
    else navigate("/app/bastion", { replace: true });
  };

  const room = sessionRoom(ids);
  const filtered = useMemo(() => {
    const text = query.trim().toLowerCase();
    return machines.filter((m) =>
      text
        ? `${m.id} ${m.name} ${m.groupName} ${m.sshHost}`
            .toLowerCase()
            .includes(text)
        : true,
    );
  }, [machines, query]);
  const closed = filtered.filter((m) => sshReady(m) && !ids.includes(m.id));
  const onStatus = useCallback((value: number, status: SshStatus) => {
    setStatuses((old) =>
      old[value] === status ? old : { ...old, [value]: status },
    );
  }, []);

  function openAll() {
    let next = ids;
    let added = 0;
    for (const machine of closed) {
      const grown = addSession(next, machine.id);
      if (grown.length === next.length) break;
      next = grown;
      added += 1;
    }
    if (!added) {
      setError(`最多同时打开 ${MAX_SESSIONS} 个终端，请先关闭不用的终端`);
      return;
    }
    setIds(next);
    setPicker(false);
    // Every connectable server opens in one go; only a completely full strip can
    // leave some behind, and then the operator is told exactly how many.
    const skipped = closed.length - added;
    setError(
      skipped
        ? `已打开 ${added} 台，还有 ${skipped} 台没打开：最多同时打开 ${MAX_SESSIONS} 个终端，请先关闭不用的终端`
        : "",
    );
    const first = next[ids.length];
    if (first) navigate(`/app/machines/${first}/ssh`, { replace: true });
  }

  if (isBadId) {
    return <div className="yaws-card p-4">bad machine id</div>;
  }

  return (
    <div className="ssh-multi">
      <div className="ssh-session-bar">
        <div className="ssh-session-list" role="tablist" aria-label="终端会话">
          {ids.map((value) => (
            <div
              key={value}
              className={`ssh-session${value === machineId ? " active" : ""}`}
            >
              <button
                role="tab"
                aria-selected={value === machineId}
                className="ssh-session-name"
                title={`切换到 ${labelFor(value)}`}
                onClick={() => {
                  if (value !== machineId)
                    navigate(`/app/machines/${value}/ssh`, { replace: true });
                }}
              >
                <span
                  className={`inline-block h-1.5 w-1.5 flex-none rounded-full ${statusDot(
                    statuses[value],
                  )}`}
                />
                <span className="truncate">{labelFor(value)}</span>
              </button>
              <button
                className="ssh-session-close"
                aria-label={`关闭 ${labelFor(value)} 的终端`}
                title="关闭这个终端"
                onClick={() => close(value)}
              >
                <X size={13} />
              </button>
            </div>
          ))}
          <button
            className="ssh-session-add"
            aria-label="打开其他服务器的终端"
            title="打开其他服务器的终端"
            aria-haspopup="dialog"
            onClick={() => {
              setQuery("");
              setPicker(true);
            }}
          >
            <Plus size={15} />
          </button>
        </div>
        <span className="ssh-session-count">
          {ids.length}/{MAX_SESSIONS} 个终端
        </span>
      </div>

      {error ? (
        <div className="mx-4 mt-3 yaws-alert-error" role="alert">
          {error}
        </div>
      ) : null}

      {picker ? (
        <>
          <div
            className="ssh-picker-backdrop"
            aria-hidden="true"
            onClick={() => setPicker(false)}
          />
          <div className="ssh-picker" role="dialog" aria-label="选择服务器">
            <div className="workspace-toolbar">
              <TerminalSquare size={16} />
              <strong className="flex-1 min-w-0 truncate text-sm">
                打开终端
              </strong>
              <span className="text-xs text-white/40">
                还能打开 {Math.max(0, room)} 个
              </span>
              <button
                className="icon-btn"
                aria-label="关闭选择面板"
                onClick={() => setPicker(false)}
              >
                <X size={17} />
              </button>
            </div>
            <label className="ssh-picker-search">
              <Search size={15} />
              <input
                className="yaws-input"
                autoFocus
                aria-label="搜索服务器"
                placeholder="搜索主机名称、分组或地址"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </label>
            <div className="ssh-picker-list">
              {filtered.map((machine) => {
                const already = ids.includes(machine.id);
                const ready = sshReady(machine);
                return (
                  <button
                    key={machine.id}
                    className="ssh-picker-item"
                    disabled={already || !ready || room <= 0}
                    onClick={() => {
                      if (open(machine.id)) setPicker(false);
                    }}
                  >
                    <span
                      className={`inline-block h-1.5 w-1.5 flex-none rounded-full ${
                        machine.online
                          ? "bg-emerald-400"
                          : "bg-white/20"
                      }`}
                    />
                    <span className="min-w-0 flex-1 truncate">{machine.name}</span>
                    <span className="ssh-picker-host">
                      {machine.sshUser || "—"}@{machine.sshHost || "未配置"}:
                      {machine.sshPort ?? 22}
                    </span>
                    <span className="ssh-picker-tag">
                      {already
                        ? "已打开"
                        : !ready
                          ? "未配置 SSH"
                          : room <= 0
                            ? "已达上限"
                            : "打开"}
                    </span>
                  </button>
                );
              })}
              {!filtered.length ? (
                <div className="ssh-picker-empty">没有匹配的服务器</div>
              ) : null}
            </div>
            <div className="ssh-picker-foot">
              <button
                className="yaws-btn tool-text"
                disabled={!closed.length || room <= 0}
                onClick={openAll}
              >
                <Plus size={15} />
                打开全部可连接的服务器（{closed.length}）
              </button>
              {room <= 0 ? (
                <span className="text-xs text-amber-300">
                  已达上限，请先关闭不用的终端
                </span>
              ) : null}
            </div>
          </div>
        </>
      ) : null}

      <div className="ssh-multi-body">
        {ids.map((value) => (
          <MachineWorkspace
            key={value}
            machineId={value}
            label={labelFor(value)}
            active={value === machineId}
            onStatus={onStatus}
            hidden={value !== machineId}
          />
        ))}
      </div>
    </div>
  );
}
