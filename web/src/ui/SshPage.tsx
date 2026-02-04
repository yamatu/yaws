import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { Terminal } from "xterm";
import type { FitAddon } from "xterm-addon-fit";
import { apiFetch, type Machine } from "./api";
import { getToken } from "./auth";

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
  const [status, setStatus] = useState<"idle" | "connecting" | "connected" | "closed">("idle");
  const [termReady, setTermReady] = useState(false);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  const isBadId = useMemo(() => !Number.isInteger(machineId) || machineId <= 0, [machineId]);

  useEffect(() => {
    if (isBadId) return;
    let alive = true;
    const ac = new AbortController();
    (async () => {
      try {
        const res = await apiFetch<{ machines: Machine[] }>("/api/machines", { signal: ac.signal });
        if (!alive) return;
        const m = res.machines.find((x) => x.id === machineId) ?? null;
        setMachine(m);
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
    const el = containerRef.current;
    if (!el) return;
    if (termRef.current) return;

    let alive = true;
    (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import("xterm"),
        import("xterm-addon-fit"),
        import("xterm/css/xterm.css"),
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
          background: "#06080b",
          foreground: "#d7e0ea",
          cursor: "#d7e0ea",
        },
      });
      term.loadAddon(fit);
      term.open(el);
      fit.fit();

      term.writeln("YAWS WebSSH");
      term.writeln("提示：点击终端区域后输入。\r\n");

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
    if (isBadId) return;
    const token = getToken();
    if (!token) return;
    const term = termRef.current;
    const fit = fitRef.current;
    if (!termReady || !term || !fit) return;

    setError(null);
    setStatus("connecting");

    const url = new URL("/ws/ssh", window.location.origin);
    url.searchParams.set("token", token);
    const ws = new WebSocket(url.toString().replace(/^http/, "ws"));
    wsRef.current = ws;

    const sendResize = () => {
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
    };

    const onWindowResize = () => {
      try {
        fit.fit();
        sendResize();
      } catch {
        // ignore
      }
    };
    window.addEventListener("resize", onWindowResize);

    const onTermResize = term.onResize(() => sendResize());
    const onTermData = term.onData((s) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      const bytes = new TextEncoder().encode(s);
      ws.send(JSON.stringify({ type: "input", dataB64: bytesToBase64(bytes) }));
    });

    ws.onopen = () => {
      try {
        fit.fit();
        ws.send(JSON.stringify({ type: "connect", machineId, cols: term.cols, rows: term.rows }));
      } catch {
        // ignore
      }
    };

    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(String(e.data ?? "{}"));
        if (msg.type === "ready") {
          setStatus("connected");
          return;
        }
        if (msg.type === "output" && typeof msg.dataB64 === "string") {
          term.write(base64ToBytes(msg.dataB64));
          return;
        }
        if (msg.type === "exit") {
          setStatus("closed");
          return;
        }
        if (msg.type === "error") {
          setError(String(msg.error ?? "ssh_error"));
          return;
        }
      } catch {
        // ignore
      }
    };

    ws.onclose = () => {
      setStatus((s) => (s === "connected" ? "closed" : s));
    };
    ws.onerror = () => {
      setError("ws_error");
    };

    return () => {
      window.removeEventListener("resize", onWindowResize);
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
  }, [isBadId, machineId, termReady]);

  if (isBadId) {
    return <div className="rounded-2xl border border-white/15 bg-white/10 p-4 backdrop-blur">bad machine id</div>;
  }

  return (
    <div className="flex min-h-[100vh] h-[100dvh] flex-col">
      <div className="flex items-center gap-2 border-b border-white/10 bg-black/20 px-4 py-3">
        <Link className="rounded-xl border border-white/15 bg-white/10 px-3 py-2 text-sm hover:bg-white/15" to={"../"}>
          返回
        </Link>
        <div className="flex-1">
          <div className="font-extrabold">SSH {machine ? `· ${machine.name}` : ""}</div>
          <div className="text-xs text-white/60">{status === "connected" ? "已连接" : status === "connecting" ? "连接中..." : status === "closed" ? "已断开" : ""}</div>
        </div>
      </div>

      {error ? (
        <div className="mx-4 mt-3 rounded-2xl border border-rose-400/40 bg-rose-500/10 p-3 text-sm">
          {error === "ssh_not_configured" ? "未配置 SSH（请先在机器详情页填写 SSH Host/User/认证信息）" : `连接失败：${error}`}
        </div>
      ) : null}

      <div className="flex-1 min-h-0 p-4">
        <div className="h-full w-full overflow-hidden rounded-2xl border border-white/10 bg-black/60">
          <div ref={containerRef} className="h-full w-full" />
        </div>
      </div>
    </div>
  );
}
