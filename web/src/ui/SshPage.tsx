import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import { apiFetch, type Machine } from "./api";
import { getToken } from "./auth";
import {
  ArrowLeft,
  RotateCw,
  Unplug,
  TerminalSquare,
  Folder,
  Sparkles,
  ShieldCheck,
} from "lucide-react";
import { SshShortcuts } from "./SshShortcuts";
import { workspaceError } from "./workspaceErrors";
const Files = lazy(() =>
  import("./FileWorkspace").then((m) => ({ default: m.FileWorkspace })),
);
const AI = lazy(() =>
  import("./AiWorkspace").then((m) => ({ default: m.AiWorkspace })),
);

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

export function SshPage() {
  const { id } = useParams();
  const machineId = Number(id);
  const [machine, setMachine] = useState<Machine | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<
    "idle" | "connecting" | "connected" | "closed"
  >("idle");
  const [termReady, setTermReady] = useState(false);
  const [connectNonce, setConnectNonce] = useState(0);
  const [tab, setTab] = useState<"terminal" | "files" | "ai">("terminal");
  const [visited, setVisited] = useState({ files: false, ai: false });
  const [root, setRoot] = useState("/");
  const [trusted, setTrusted] = useState(false);
  const [hostKey, setHostKey] = useState<{
    address: string;
    fingerprint: string;
  } | null>(null);
  const [trustBusy, setTrustBusy] = useState(false);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  const isBadId = useMemo(
    () => !Number.isInteger(machineId) || machineId <= 0,
    [machineId],
  );

  useEffect(() => {
    if (isBadId) return;
    let alive = true;
    const ac = new AbortController();
    (async () => {
      try {
        const res = await apiFetch<{ machine: Machine }>(
          `/api/machines/${machineId}`,
          { signal: ac.signal },
        );
        if (!alive) return;
        setMachine(res.machine);
      } catch (e: any) {
        if (!alive) return;
        setError(e?.message ?? "加载失败");
      }
    })();
    return () => {
      alive = false;
      ac.abort();
    };
  }, [isBadId, machineId]);

  useEffect(() => {
    const ac = new AbortController();
    setTrusted(false);
    void apiFetch<{ address: string; fingerprint: string }>(
      `/api/machines/${machineId}/workspace/host-key`,
      { signal: ac.signal },
    )
      .then((r) => setTrusted(!!r.fingerprint))
      .catch((e: unknown) => {
        if (!ac.signal.aborted) setError(workspaceError(e));
      });
    return () => ac.abort();
  }, [machineId]);
  async function inspect() {
    setTrustBusy(true);
    setError(null);
    try {
      setHostKey(
        await apiFetch(
          `/api/machines/${machineId}/workspace/host-key/inspect`,
          { method: "POST" },
        ),
      );
    } catch (e) {
      setError(workspaceError(e));
    } finally {
      setTrustBusy(false);
    }
  }
  async function trust() {
    if (!hostKey) return;
    setTrustBusy(true);
    try {
      await apiFetch(`/api/machines/${machineId}/workspace/host-key`, {
        method: "PUT",
        body: JSON.stringify(hostKey),
      });
      setTrusted(true);
      setHostKey(null);
      setConnectNonce((v) => v + 1);
    } catch (e) {
      setError(workspaceError(e));
    } finally {
      setTrustBusy(false);
    }
  }

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    if (termRef.current) return;

    let alive = true;
    (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
        import("@xterm/xterm/css/xterm.css"),
      ]);
      if (!alive) return;

      const fit = new FitAddon();
      const term = new Terminal({
        cursorBlink: true,
        scrollback: 3000,
        fontSize: 14,
        fontFamily:
          'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
        theme: {
          background: "#060810",
          foreground: "#d0dae8",
          cursor: "#d0dae8",
          selectionBackground: "rgba(56, 189, 248, 0.25)",
        },
      });
      term.loadAddon(fit);
      term.open(el);
      fit.fit();

      term.writeln("YAWS WebSSH");

      termRef.current = term;
      fitRef.current = fit;
      setTermReady(true);
    })().catch(() => {
      setError("terminal_init_failed");
    });

    return () => {
      alive = false;
      setTermReady(false);
      try {
        termRef.current?.dispose();
      } catch {
        // ignore
      }
      termRef.current = null;
      fitRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (isBadId || !trusted) return;
    const token = getToken();
    if (!token) return;
    const term = termRef.current;
    const fit = fitRef.current;
    if (!termReady || !term || !fit) return;

    setError(null);
    setStatus("connecting");

    const url = new URL("/ws/ssh", window.location.origin);
    const ws = new WebSocket(url.toString().replace(/^http/, "ws"), [
      "yaws",
      `bearer.${token}`,
    ]);
    wsRef.current = ws;
    let alive = true;
    let outputBytes = 0;
    const timeout = window.setTimeout(() => {
      if (alive) {
        setError("连接超时");
        ws.close();
        setStatus("closed");
      }
    }, 25000);

    const sendResize = () => {
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.send(
        JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }),
      );
    };

    const onWindowResize = () => {
      try {
        fit.fit();
        sendResize();
      } catch {
        // ignore
      }
    };
    const resizeObserver = new ResizeObserver(onWindowResize);
    if (containerRef.current) resizeObserver.observe(containerRef.current);

    const onTermResize = term.onResize(() => sendResize());
    const onTermData = term.onData((s) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      const bytes = new TextEncoder().encode(s);
      ws.send(JSON.stringify({ type: "input", dataB64: bytesToBase64(bytes) }));
    });

    ws.onopen = () => {
      try {
        fit.fit();
        ws.send(
          JSON.stringify({
            type: "connect",
            machineId,
            cols: term.cols,
            rows: term.rows,
          }),
        );
      } catch {
        // ignore
      }
    };

    ws.onmessage = (e) => {
      if (!alive) return;
      try {
        const msg = JSON.parse(String(e.data ?? "{}"));
        if (msg.type === "ready") {
          clearTimeout(timeout);
          setStatus("connected");
          term.focus();
          return;
        }
        if (msg.type === "output" && typeof msg.dataB64 === "string") {
          const bytes = base64ToBytes(msg.dataB64);
          outputBytes += bytes.length;
          if (outputBytes > 1024 * 1024) {
            setError("终端输出过快，连接已关闭");
            ws.close();
            return;
          }
          term.write(bytes, () => {
            outputBytes -= bytes.length;
          });
          return;
        }
        if (msg.type === "exit") {
          setStatus("closed");
          return;
        }
        if (msg.type === "error") {
          clearTimeout(timeout);
          setError(workspaceError(new Error(String(msg.error ?? "ssh_error"))));
          setStatus("closed");
          return;
        }
      } catch {
        // ignore
      }
    };

    ws.onclose = () => {
      if (wsRef.current === ws) setStatus("closed");
    };
    ws.onerror = () => {
      setError("ws_error");
      if (wsRef.current === ws) setStatus("closed");
    };

    return () => {
      alive = false;
      clearTimeout(timeout);
      resizeObserver.disconnect();
      try {
        onTermResize.dispose();
        onTermData.dispose();
      } catch {
        // ignore
      }
      try {
        ws.close();
      } catch {
        // ignore
      }
      wsRef.current = null;
    };
  }, [isBadId, machineId, termReady, connectNonce, trusted]);

  if (isBadId) {
    return <div className="yaws-card p-4">bad machine id</div>;
  }

  return (
    <div className="remote-workspace">
      <div className="workspace-toolbar workspace-header">
        <Link
          className="icon-btn"
          title="返回堡垒机"
          aria-label="返回堡垒机"
          to="/app/bastion"
        >
          <ArrowLeft size={18} />
        </Link>
        <div className="flex-1 min-w-0">
          <div className="font-bold tracking-wide">
            SSH {machine ? `· ${machine.name}` : ""}
          </div>
          <div className="flex items-center gap-1.5 text-xs text-white/40">
            <span
              className={`inline-block h-1.5 w-1.5 rounded-full ${
                status === "connected"
                  ? "bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.5)]"
                  : status === "connecting"
                    ? "bg-amber-400 shadow-[0_0_6px_rgba(251,191,36,0.5)]"
                    : "bg-white/20"
              }`}
            />
            {status === "connected"
              ? "已连接"
              : status === "connecting"
                ? "连接中..."
                : status === "closed"
                  ? "已断开"
                  : ""}
          </div>
        </div>
        <button
          className="icon-btn"
          title="主机指纹"
          aria-label="主机指纹"
          disabled={trustBusy}
          onClick={() => void inspect()}
        >
          <ShieldCheck size={18} />
        </button>
        <button
          className="icon-btn"
          title="重新连接"
          aria-label="重新连接"
          disabled={!trusted || status === "connecting"}
          onClick={() => {
            wsRef.current?.close();
            setStatus("closed");
            setConnectNonce((n) => n + 1);
          }}
        >
          <RotateCw size={18} />
        </button>
        <button
          className="icon-btn"
          title="断开"
          aria-label="断开"
          disabled={status === "closed" || status === "idle"}
          onClick={() => {
            wsRef.current?.close();
            setStatus("closed");
          }}
        >
          <Unplug size={18} />
        </button>
      </div>

      {error ? (
        <div className="mx-4 mt-3 yaws-alert-error">
          {error === "ssh_not_configured"
            ? "未配置 SSH（请先在机器详情页填写 SSH Host/User/认证信息）"
            : `连接失败：${error}`}
        </div>
      ) : null}

      {(!trusted || hostKey) && (
        <div className="host-key-prompt">
          <strong>SSH 主机身份</strong>
          {hostKey ? (
            <>
              <code>
                {hostKey.address}
                <br />
                {hostKey.fingerprint}
              </code>
              <span>请与服务器的 SSH 主机指纹核对后保存。</span>
              <button
                className="yaws-btn-primary"
                disabled={trustBusy}
                onClick={() => void trust()}
              >
                确认并信任此指纹
              </button>
            </>
          ) : (
            <button
              className="yaws-btn-primary"
              disabled={trustBusy}
              onClick={() => void inspect()}
            >
              {trustBusy ? "读取中…" : "读取主机指纹"}
            </button>
          )}
        </div>
      )}
      <div className="workspace-tabs" role="tablist">
        {(
          [
            ["terminal", "终端", TerminalSquare],
            ["files", "文件", Folder],
            ["ai", "AI", Sparkles],
          ] as const
        ).map(([key, label, Icon]) => (
          <button
            role="tab"
            aria-selected={tab === key}
            key={key}
            onClick={() => {
              setTab(key);
              if (key !== "terminal")
                setVisited((v) => ({ ...v, [key]: true }));
            }}
          >
            <Icon size={16} />
            {label}
          </button>
        ))}
      </div>
      <div
        className="terminal-workspace"
        style={{ display: tab === "terminal" ? "grid" : "none" }}
      >
        <SshShortcuts
          machineId={machineId}
          connected={status === "connected"}
          send={(command) => {
            if (command.endsWith("\r")) {
              wsRef.current?.send(
                JSON.stringify({
                  type: "input",
                  dataB64: bytesToBase64(new TextEncoder().encode(command)),
                }),
              );
            } else termRef.current?.paste(command);
            termRef.current?.focus();
          }}
        />
        <div className="terminal-pane">
          <div ref={containerRef} className="h-full w-full" />
        </div>
      </div>
      {trusted && visited.files && (
        <div className="workspace-tab-body" hidden={tab !== "files"}>
          <Suspense fallback={<div className="p-4">加载文件…</div>}>
            <Files machineId={machineId} onRoot={setRoot} />
          </Suspense>
        </div>
      )}
      {trusted && visited.ai && (
        <div className="workspace-tab-body" hidden={tab !== "ai"}>
          <Suspense fallback={<div className="p-4">加载 AI…</div>}>
            <AI machineId={machineId} initialRoot={root} />
          </Suspense>
        </div>
      )}
    </div>
  );
}
