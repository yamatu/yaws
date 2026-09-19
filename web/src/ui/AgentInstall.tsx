import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "./api";
import { getToken } from "./auth";
import { workspaceError } from "./workspaceErrors";

type Source = { provider: string; label: string; detail: string };

type InstallPlan = {
  order: string[];
  channel: string;
  githubRepo: string;
  giteeRepo: string;
  releaseTag: string;
  githubBase: string;
  giteeBase: string;
  controllerBase: string;
  targetVersion: string;
  sources: Source[];
};

export type AgentInstallInfo = {
  machineId: number;
  channel: string;
  channels: Array<{ id: "cn" | "global"; label: string; hint: string }>;
  bundledVersion: string;
  bundledBytes: number;
  credentialState: "ok" | "missing" | "undecryptable";
  hostTrusted: boolean;
  intervalSec: number;
  plan: InstallPlan;
  scriptUrl: string;
};

type LogLine = { stream: "out" | "err"; text: string };

function formatBytes(bytes: number) {
  if (!bytes) return "—";
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * "一键安装" for the agent: the panel opens SSH to the machine, runs the same
 * installer the manual script builds, and streams the log back. Two channels
 * only differ in the download order (domestic mirrors vs GitHub first).
 */
export function AgentInstall({ machineId, refreshKey }: { machineId: number; refreshKey?: number }) {
  const [info, setInfo] = useState<AgentInstallInfo | null>(null);
  const [channel, setChannel] = useState<"cn" | "global">("cn");
  const [lines, setLines] = useState<LogLine[]>([]);
  const [status, setStatus] = useState<"idle" | "running" | "ok" | "failed">("idle");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [infoError, setInfoError] = useState("");
  const [showScript, setShowScript] = useState(false);
  const [script, setScript] = useState("");
  const controller = useRef<AbortController | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);

  const loadInfo = useCallback(
    (which: "cn" | "global") =>
      apiFetch<AgentInstallInfo>(`/api/machines/${machineId}/agent/install?channel=${which}`),
    [machineId],
  );

  useEffect(() => {
    let alive = true;
    setInfoError("");
    void loadInfo(channel)
      .then((res) => {
        if (alive) setInfo(res);
      })
      .catch((e) => {
        if (!alive) return;
        setInfo(null);
        // A machine without an agent key answers 409 before anything else can
        // be shown; say so instead of pretending the SSH form is empty.
        setInfoError(workspaceError(e));
      });
    return () => {
      alive = false;
    };
  }, [loadInfo, channel, refreshKey]);

  useEffect(() => {
    const box = logRef.current;
    if (box) box.scrollTop = box.scrollHeight;
  }, [lines]);

  useEffect(() => () => controller.current?.abort(), []);

  async function run(which: "cn" | "global") {
    if (status === "running") return;
    setChannel(which);
    setLines([]);
    setError("");
    setMessage("");
    setStatus("running");
    const ac = new AbortController();
    controller.current = ac;
    try {
      const token = getToken();
      const response = await fetch(`/api/machines/${machineId}/agent/install`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ channel: which }),
        signal: ac.signal,
      });
      if (!response.ok || !response.body) {
        let text = `http_${response.status}`;
        try {
          const body = await response.json();
          if (body?.error) text = String(body.error);
        } catch {
          // ignore
        }
        throw new Error(text);
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let finished = false;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const chunks = buffer.split("\n");
        buffer = chunks.pop() ?? "";
        for (const chunk of chunks) {
          if (!chunk.trim()) continue;
          let event: any;
          try {
            event = JSON.parse(chunk);
          } catch {
            continue;
          }
          if (event.type === "log") {
            const line = { stream: event.stream, text: String(event.text ?? "") };
            setLines((old) => (old.length > 500 ? old : [...old, line]));
          } else if (event.type === "done") {
            finished = true;
            setStatus("ok");
            const parts = [event.version ? `：${event.version}` : ""];
            if (event.provider) parts.push(`（来源 ${event.provider}）`);
            setMessage(`安装完成${parts.join("")}`);
          } else if (event.type === "error") {
            finished = true;
            setError(workspaceError(new Error(String(event.error ?? "agent_install_failed"))));
            setStatus("failed");
          }
        }
      }
      if (!finished) {
        setStatus("idle");
        setMessage("安装已结束（连接被中断）");
      }
    } catch (e) {
      const aborted = ac.signal.aborted || (e as Error)?.name === "AbortError";
      if (aborted) {
        setMessage("已停止");
        setStatus("idle");
      } else {
        setError(workspaceError(e));
        setStatus("failed");
      }
    } finally {
      controller.current = null;
      void loadInfo(which)
        .then(setInfo)
        .catch(() => {});
    }
  }

  async function loadScript(which: "cn" | "global") {
    try {
      const token = getToken();
      const res = await fetch(`/api/machines/${machineId}/install-script?channel=${which}`, {
        headers: token ? { authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) throw new Error(`http_${res.status}`);
      setScript(await res.text());
      setShowScript(true);
    } catch (e) {
      setError(workspaceError(e));
    }
  }

  const ready = info?.credentialState === "ok" && info?.hostTrusted !== false;
  const busy = status === "running";

  return (
    <div className="grid gap-2">
      <div className="rounded-lg border border-white/[0.06] bg-black/20 p-3">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <div className="flex-1 text-xs text-white/50">
            一键安装：主控通过 SSH 登录被控端，自动下载并注册探针
          </div>
          <button
            className="yaws-btn-primary text-xs"
            disabled={busy || !ready}
            onClick={() => void run("cn")}
          >
            {busy && channel === "cn" ? "安装中…" : "国内一键安装"}
          </button>
          <button
            className="yaws-btn-primary text-xs"
            disabled={busy || !ready}
            onClick={() => void run("global")}
          >
            {busy && channel === "global" ? "安装中…" : "国外一键安装"}
          </button>
          {busy ? (
            <button className="yaws-btn text-xs" onClick={() => controller.current?.abort()}>
              停止
            </button>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-white/40">
          <span>
            主控自带探针：
            {info?.bundledVersion ? info.bundledVersion : "无"}（
            {formatBytes(info?.bundledBytes ?? 0)}）
          </span>
          <span>目标版本：{info?.plan.targetVersion || "最新发布版"}</span>
          <button className="yaws-btn text-xs" disabled={busy} onClick={() => void loadScript(channel)}>
            查看安装脚本
          </button>
        </div>

        {info ? (
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-white/40">
            <span className="text-white/30">下载顺序：</span>
            {(info.plan.sources ?? []).map((source, index) => (
              <span
                key={source.provider}
                className="rounded bg-white/[0.06] px-1.5 py-0.5"
                title={source.detail}
              >
                {index + 1}. {source.label}
              </span>
            ))}
          </div>
        ) : null}

        {infoError ? <div className="mt-2 text-xs text-rose-300/90">{infoError}</div> : null}

        {info && !ready ? (
          <div className="mt-2 text-xs text-amber-200/80">
            {info && !info.hostTrusted
              ? "这台机器的 SSH 主机指纹还没有确认（或指纹已变化），请先在 SSH 面板确认一次。"
              : "这台机器还没有可用的 SSH 登录信息，请先在上方填写 SSH 地址、账号和密码/密钥并保存。"}
          </div>
        ) : null}
        {info?.bundledVersion ? null : ready ? (
          <div className="mt-2 text-xs text-amber-200/80">
            主控没有内置探针二进制，安装时会直接走 Gitee/GitHub 发布版（可设置
            AGENT_BINARY_DIR 或把 agent/bin 打进镜像）。
          </div>
        ) : null}

        {message ? <div className="mt-2 text-xs text-emerald-300/90">{message}</div> : null}
        {error ? <div className="mt-2 text-xs text-rose-300/90">{error}</div> : null}

        {lines.length ? (
          <div
            ref={logRef}
            className="mt-2 max-h-64 overflow-auto rounded-lg border border-white/[0.06] bg-black/40 p-2 font-mono text-[11px] leading-5"
          >
            {lines.map((line, index) => (
              <div
                key={index}
                className={line.stream === "err" ? "text-rose-300/90" : "text-white/70"}
              >
                {line.text || " "}
              </div>
            ))}
          </div>
        ) : null}
      </div>

      {showScript ? (
        <div className="grid gap-2">
          <div className="flex items-center gap-2">
            <div className="flex-1 text-xs text-white/40">
              复制到被控端 root 执行（{channel === "cn" ? "国内线路" : "国外线路"}，会自动回退到其它来源）
            </div>
            <button
              className="yaws-btn text-xs"
              onClick={async () => {
                await navigator.clipboard.writeText(script);
                setMessage("脚本已复制");
              }}
            >
              复制脚本
            </button>
            <button className="yaws-btn text-xs" onClick={() => setShowScript(false)}>
              收起
            </button>
          </div>
          <pre className="max-h-96 overflow-auto rounded-lg border border-white/[0.06] bg-black/30 p-3 text-xs">
            <code>{script}</code>
          </pre>
        </div>
      ) : null}
    </div>
  );
}
