import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Link, useNavigate } from "react-router-dom";
import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import { apiFetch } from "./api";
import { getToken } from "./auth";
import {
  ArrowLeft,
  RotateCw,
  Unplug,
  TerminalSquare,
  Folder,
  Sparkles,
  ShieldCheck,
  PanelRightClose,
  PanelRightOpen,
  Keyboard,
} from "lucide-react";
import { SshShortcuts } from "./SshShortcuts";
import { MobileKeyBar } from "./MobileKeyBar";
import {
  applyMods,
  defaultKeyBarVisible,
  modsActive,
  NO_MODS,
  sendKey,
  type KeyButton,
  type Mods,
} from "./terminalKeys";
import { SplitHandle } from "./SplitHandle";
import { SPLIT_DEFAULT, storedSplit } from "./splitter";
import { workspaceError } from "./workspaceErrors";
import { storedTab, tabKey, type WorkspaceTab } from "./workspaceMemory";
const Files = lazy(() =>
  import("./FileWorkspace").then((m) => ({ default: m.FileWorkspace })),
);
const AI = lazy(() => import("./AiChat").then((m) => ({ default: m.AiChat })));
const AiDock = lazy(() =>
  import("./AiChatDock").then((m) => ({ default: m.AiChatDock })),
);

export const SPLIT_STORAGE = "yaws.workspace.split";
const KEY_BAR_STORAGE = "yaws.terminal.keys";

export type SshStatus = "idle" | "connecting" | "connected" | "closed";

/** Which tab of the SSH workspace was last open on this machine. */
function storedTabFor(machineId: number): WorkspaceTab {
  try {
    return storedTab(localStorage.getItem(tabKey(machineId)));
  } catch {
    return "terminal";
  }
}

function rememberTab(machineId: number, tab: WorkspaceTab) {
  try {
    localStorage.setItem(tabKey(machineId), tab);
  } catch {
    // private mode
  }
}

function storedSplitMain(): number {
  try {
    return storedSplit(localStorage.getItem(SPLIT_STORAGE), SPLIT_DEFAULT);
  } catch {
    return SPLIT_DEFAULT;
  }
}

function storedKeyBar(): boolean {
  try {
    return defaultKeyBarVisible(
      window.matchMedia?.("(pointer: coarse)").matches ?? false,
      window.innerWidth,
      window.localStorage.getItem(KEY_BAR_STORAGE),
    );
  } catch {
    return window.innerWidth <= 760;
  }
}

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

/**
 * One machine, one full workspace: terminal, files and assistant. Several of
 * these live side by side inside the multi-terminal page, so every pane keeps
 * its own state and stays connected while another pane is on screen.
 */
export function MachineWorkspace({
  machineId,
  label,
  active,
  hidden,
  onStatus,
}: {
  machineId: number;
  label: string;
  /** Only the active pane is visible and may take the keyboard focus. */
  active: boolean;
  /** Background panes stay mounted and connected, but are not rendered. */
  hidden?: boolean;
  onStatus?: (machineId: number, status: SshStatus) => void;
}) {
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<SshStatus>("idle");
  const [termReady, setTermReady] = useState(false);
  const [connectNonce, setConnectNonce] = useState(0);
  const [tab, setTab] = useState<WorkspaceTab>(() => storedTabFor(machineId));
  const [visited, setVisited] = useState(() => {
    const initial = storedTabFor(machineId);
    return { files: initial === "files", ai: initial === "ai" };
  });
  // While browsing or editing files the SSH session stays visible in a side panel, so
  // commands can be run next to the file that is being worked on.
  const [dockTerminal, setDockTerminal] = useState(true);
  const [split, setSplitState] = useState(storedSplitMain);
  const setSplit = useCallback((percent: number) => {
    setSplitState(percent);
    try {
      localStorage.setItem(SPLIT_STORAGE, String(percent));
    } catch {
      // private mode
    }
  }, []);
  const [root, setRoot] = useState("/");
  // Escape/Tab/arrows do not exist on a touch keyboard, so the terminal can show a key bar.
  const [keyBar, setKeyBar] = useState(storedKeyBar);
  // The assistant is an add-on: it can float over the terminal or the file editor.
  const [chatDock, setChatDock] = useState(false);
  const [mods, setMods] = useState<Mods>(NO_MODS);
  // The terminal data handler lives inside an effect, so it reads the modifiers from a ref.
  const modsRef = useRef<Mods>(NO_MODS);
  const [notice, setNotice] = useState("");
  const [trusted, setTrusted] = useState(false);
  // Until the host key has been checked, the machine is not *known* to be
  // untrusted: rendering the trust prompt before that check made it flash on
  // every open of an already trusted server (and the disappearing button ate
  // real clicks).
  const [keyChecked, setKeyChecked] = useState(false);
  const [hostKey, setHostKey] = useState<{
    address: string;
    fingerprint: string;
  } | null>(null);
  const [trustBusy, setTrustBusy] = useState(false);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  const docked = dockTerminal && trusted && tab !== "terminal";

  // The session bar shows at a glance which servers are connected.
  useEffect(() => {
    onStatus?.(machineId, status);
  }, [machineId, onStatus, status]);

  useEffect(() => {
    const ac = new AbortController();
    setTrusted(false);
    setKeyChecked(false);
    void apiFetch<{ address: string; fingerprint: string }>(
      `/api/machines/${machineId}/workspace/host-key`,
      { signal: ac.signal },
    )
      .then((r) => setTrusted(!!r.fingerprint))
      .catch((e: unknown) => {
        if (!ac.signal.aborted) setError(workspaceError(e));
      })
      .finally(() => {
        if (!ac.signal.aborted) setKeyChecked(true);
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

  /** Fitting a hidden pane would push bogus window sizes into the remote pty. */
  const fitSafely = () => {
    const el = containerRef.current;
    if (!el || el.clientWidth < 40 || el.clientHeight < 30) return false;
    try {
      fitRef.current?.fit();
      return true;
    } catch {
      return false;
    }
  };

  const sendRaw = (data: string) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(
      JSON.stringify({
        type: "input",
        dataB64: bytesToBase64(new TextEncoder().encode(data)),
      }),
    );
  };
  const clearMods = () => {
    modsRef.current = NO_MODS;
    setMods(NO_MODS);
  };
  const toggleKeyBar = (next: boolean) => {
    setKeyBar(next);
    try {
      window.localStorage.setItem(KEY_BAR_STORAGE, next ? "1" : "0");
    } catch {
      /* private mode: the choice is simply not remembered */
    }
    // The terminal keeps its size until the bar is (un)mounted, so ask xterm to re-fit.
    window.setTimeout(() => window.dispatchEvent(new Event("resize")), 0);
  };
  const pressKey = (key: KeyButton) => {
    sendRaw(sendKey(key, modsRef.current));
    if (modsActive(modsRef.current)) clearMods();
    termRef.current?.focus();
  };
  const pasteClipboard = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) sendRaw(text);
    } catch {
      setNotice("浏览器不允许读取剪贴板，可长按终端手动粘贴");
    }
  };

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

  // A terminal that finished connecting in the background must not steal the
  // keyboard from the pane the operator is looking at.
  useEffect(() => {
    if (active && status === "connected") termRef.current?.focus();
  }, [active, status]);

  useEffect(() => {
    if (!trusted) return;
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
      if (fitSafely()) sendResize();
    };
    const resizeObserver = new ResizeObserver(onWindowResize);
    if (containerRef.current) resizeObserver.observe(containerRef.current);

    const onTermResize = term.onResize(() => sendResize());
    const onTermData = term.onData((s) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      // Sticky Ctrl/Alt from the key bar also apply to the soft keyboard.
      const pending = modsRef.current;
      const data = modsActive(pending) ? applyMods(s, pending) : s;
      if (modsActive(pending)) {
        modsRef.current = NO_MODS;
        setMods(NO_MODS);
      }
      const bytes = new TextEncoder().encode(data);
      ws.send(JSON.stringify({ type: "input", dataB64: bytesToBase64(bytes) }));
    });

    ws.onopen = () => {
      fitSafely();
      ws.send(
        JSON.stringify({
          type: "connect",
          machineId,
          cols: term.cols,
          rows: term.rows,
        }),
      );
    };

    ws.onmessage = (e) => {
      if (!alive) return;
      try {
        const msg = JSON.parse(String(e.data ?? "{}"));
        if (msg.type === "ready") {
          clearTimeout(timeout);
          setStatus("connected");
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
  }, [machineId, termReady, connectNonce, trusted]);

  const tabs = useMemo(
    () =>
      [
        ["terminal", "终端", TerminalSquare],
        ["files", "文件", Folder],
        ["ai", "AI", Sparkles],
      ] as const,
    [],
  );

  return (
    <div className="remote-workspace" hidden={hidden}>
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
          <div className="font-bold tracking-wide">SSH · {label}</div>
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
      {notice ? (
        <div className="mx-4 mt-3 workspace-notice" role="status">
          {notice}
        </div>
      ) : null}

      {((!trusted && keyChecked) || hostKey) && (
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
        {tabs.map(([key, tabLabel, Icon]) => (
          <button
            role="tab"
            aria-selected={tab === key}
            key={key}
            onClick={() => {
              setTab(key);
              rememberTab(machineId, key);
              if (key !== "terminal")
                setVisited((v) => ({ ...v, [key]: true }));
            }}
          >
            <Icon size={16} />
            {tabLabel}
          </button>
        ))}
        <div className="flex-1" />
        {tab !== "terminal" ? (
          <button
            className="icon-btn workspace-dock-toggle"
            title={dockTerminal ? "隐藏终端面板" : "在文件编辑时显示终端"}
            aria-label={dockTerminal ? "隐藏终端面板" : "在文件编辑时显示终端"}
            aria-pressed={dockTerminal}
            onClick={() => {
              setDockTerminal((v) => !v);
              // The terminal was collapsed while hidden, so let xterm re-measure itself.
              window.setTimeout(() => window.dispatchEvent(new Event("resize")), 0);
            }}
          >
            {dockTerminal ? (
              <PanelRightClose size={17} />
            ) : (
              <PanelRightOpen size={17} />
            )}
          </button>
        ) : null}
        {tab === "terminal" || docked ? (
          <button
            className="icon-btn workspace-dock-toggle"
            title={keyBar ? "隐藏按键栏" : "显示 Esc/Tab/Ctrl 按键栏"}
            aria-label={keyBar ? "隐藏按键栏" : "显示按键栏"}
            aria-pressed={keyBar}
            onClick={() => toggleKeyBar(!keyBar)}
          >
            <Keyboard size={17} />
          </button>
        ) : null}
      </div>
      <div
        className={`workspace-body${docked ? " docked" : ""}`}
        style={{ ["--split-main" as string]: `${split}%` }}
      >
        <div
          className={`terminal-workspace${docked ? " docked-mini" : ""}`}
          style={{ display: tab === "terminal" || docked ? "grid" : "none" }}
        >
          <SshShortcuts
            machineId={machineId}
            connected={status === "connected"}
            trusted={trusted}
            onOpen={(target) =>
              navigate(`/app/machines/${target}/ssh`, { replace: true })
            }
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
            <div ref={containerRef} className="terminal-host" />
            {keyBar ? (
              <MobileKeyBar
                mods={mods}
                onMod={(next) => {
                  modsRef.current = next;
                  setMods(next);
                  termRef.current?.focus();
                }}
                onSend={pressKey}
                onPaste={() => void pasteClipboard()}
                onHide={() => toggleKeyBar(false)}
                disabled={status !== "connected"}
              />
            ) : null}
          </div>
        </div>
        {docked ? (
          <SplitHandle
            value={split}
            onChange={setSplit}
            label="调整终端面板比例"
          />
        ) : null}
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
      {trusted && tab !== "ai" ? (
        <Suspense fallback={null}>
          <AiDock
            machineId={machineId}
            initialRoot={root}
            open={chatDock}
            onToggle={setChatDock}
            lifted={keyBar && (tab === "terminal" || docked)}
          />
        </Suspense>
      ) : null}
    </div>
  );
}
