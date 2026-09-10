import { useEffect, useRef, useState } from "react";
import { Check, Play, Save, Send, Square, Settings2 } from "lucide-react";
import { diffLines } from "diff";
import { apiFetch } from "./api";
import { workspaceError } from "./workspaceErrors";
type Config = {
  baseUrl: string;
  model: string;
  protocol: "chat" | "responses";
  reasoning: string;
  allowPrivate: boolean;
  hasKey?: boolean;
};
type Proposal = {
  id: string;
  kind: "file" | "command";
  path: string;
  before: string;
  after: string;
  status: string;
};
type Answer = {
  runId: string;
  answer: string;
  proposals: Proposal[];
  trace: Array<{ tool: string; path: string }>;
};
export function AiWorkspace({
  machineId,
  initialRoot,
}: {
  machineId: number;
  initialRoot: string;
}) {
  const [config, setConfig] = useState<Config>({
    baseUrl: "",
    model: "",
    protocol: "chat",
    reasoning: "",
    allowPrivate: false,
  });
  const [apiKey, setApiKey] = useState("");
  const [settings, setSettings] = useState(false);
  const [root, setRoot] = useState(initialRoot);
  const [prompt, setPrompt] = useState("");
  const [result, setResult] = useState<Answer | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [applying, setApplying] = useState<string | null>(null);
  const [commandOutput, setCommandOutput] = useState("");
  const [notice, setNotice] = useState("");
  const [runs, setRuns] = useState<
    Array<{ id: string; prompt: string; createdAt: number }>
  >([]);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => {
    const ac = new AbortController();
    void apiFetch<Config>("/api/ai/settings", { signal: ac.signal })
      .then((r) => {
        setConfig(r);
        if (!r.baseUrl) setSettings(true);
      })
      .catch((e: unknown) => {
        if (!ac.signal.aborted) setError(workspaceError(e));
      });
    return () => {
      ac.abort();
      controller.current?.abort();
    };
  }, []);
  useEffect(() => setRoot(initialRoot), [initialRoot]);
  useEffect(() => {
    const ac = new AbortController();
    void apiFetch<{
      runs: Array<{ id: string; prompt: string; createdAt: number }>;
    }>(`/api/ai/machines/${machineId}/runs`, { signal: ac.signal })
      .then((r) => setRuns(r.runs))
      .catch((e: unknown) => {
        if (!ac.signal.aborted) setError(workspaceError(e));
      });
    return () => ac.abort();
  }, [machineId, result?.runId]);
  async function history(id: string) {
    if (!id) return;
    setError("");
    try {
      const r = await apiFetch<Answer & { root: string; prompt: string }>(
        `/api/ai/machines/${machineId}/runs/${id}`,
      );
      setRoot(r.root);
      setPrompt(r.prompt);
      setResult(r);
    } catch (e) {
      setError(workspaceError(e));
    }
  }
  async function saveSettings() {
    setBusy(true);
    setError("");
    try {
      await apiFetch("/api/ai/settings", {
        method: "PUT",
        body: JSON.stringify({ ...config, ...(apiKey ? { apiKey } : {}) }),
      });
      setApiKey("");
      setSettings(false);
      setNotice("AI 设置已保存");
    } catch (e) {
      setError(workspaceError(e));
    } finally {
      setBusy(false);
    }
  }
  async function run() {
    const ac = new AbortController();
    controller.current = ac;
    setBusy(true);
    setError("");
    setResult(null);
    setNotice("");
    try {
      setResult(
        await apiFetch<Answer>(`/api/ai/machines/${machineId}/run`, {
          method: "POST",
          body: JSON.stringify({ root, prompt }),
          signal: ac.signal,
        }),
      );
    } catch (e) {
      setError(ac.signal.aborted ? "已取消" : workspaceError(e));
    } finally {
      setBusy(false);
    }
  }
  async function apply(proposal: Proposal) {
    if (
      !window.confirm(
        proposal.kind === "command"
          ? `在当前机器执行以下命令？\n目录：${proposal.path}\n${proposal.after}`
          : `保存修改到 ${proposal.path}？`,
      )
    )
      return;
    setApplying(proposal.id);
    setError("");
    try {
      const r = await apiFetch<{
        result: { output?: string; code?: number; backup?: string };
      }>(`/api/ai/machines/${machineId}/proposals/${proposal.id}/apply`, {
        method: "POST",
        body: JSON.stringify({ confirm: true }),
      });
      setResult((old) =>
        old
          ? {
              ...old,
              proposals: old.proposals.map((p) =>
                p.id === proposal.id ? { ...p, status: "applied" } : p,
              ),
            }
          : old,
      );
      if (proposal.kind === "command")
        setCommandOutput(
          `${r.result.output ?? ""}\n退出码：${r.result.code ?? "未知"}`,
        );
      else
        setNotice(
          `已保存 ${proposal.path}${r.result.backup ? ` · 备份 ${r.result.backup}` : ""}`,
        );
    } catch (e) {
      setError(workspaceError(e));
    } finally {
      setApplying(null);
    }
  }
  return (
    <div className="ai-workspace">
      <div className="workspace-toolbar">
        <h2 className="flex-1 font-semibold">AI 工作区</h2>
        <span className="text-xs text-white/50">
          {config.model || "未配置模型"}
        </span>
        <button
          className="icon-btn"
          title="AI 设置"
          aria-label="AI 设置"
          onClick={() => setSettings((v) => !v)}
        >
          <Settings2 size={18} />
        </button>
      </div>
      {settings && (
        <form
          className="ai-settings"
          onSubmit={(e) => {
            e.preventDefault();
            void saveSettings();
          }}
        >
          <label>
            API 地址
            <input
              className="yaws-input"
              type="url"
              value={config.baseUrl}
              required
              placeholder="https://api.example.com/v1"
              onChange={(e) =>
                setConfig({ ...config, baseUrl: e.target.value })
              }
            />
          </label>
          <label>
            模型
            <input
              className="yaws-input"
              value={config.model}
              required
              onChange={(e) => setConfig({ ...config, model: e.target.value })}
            />
          </label>
          <label>
            协议
            <select
              className="yaws-select w-full"
              value={config.protocol}
              onChange={(e) =>
                setConfig({
                  ...config,
                  protocol: e.target.value as Config["protocol"],
                })
              }
            >
              <option value="chat">Chat Completions</option>
              <option value="responses">Responses</option>
            </select>
          </label>
          <label>
            推理级别
            <input
              list="reasoning-levels"
              className="yaws-input"
              value={config.reasoning}
              placeholder="默认"
              onChange={(e) =>
                setConfig({ ...config, reasoning: e.target.value })
              }
            />
            <datalist id="reasoning-levels">
              {["low", "medium", "high", "xhigh", "max"].map((v) => (
                <option key={v} value={v} />
              ))}
            </datalist>
          </label>
          <label>
            API Key
            <input
              className="yaws-input"
              type="password"
              autoComplete="new-password"
              value={apiKey}
              placeholder={config.hasKey ? "已保存，留空不修改" : "可选"}
              onChange={(e) => setApiKey(e.target.value)}
            />
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={config.allowPrivate}
              onChange={(e) =>
                setConfig({ ...config, allowPrivate: e.target.checked })
              }
            />
            允许内网 / HTTP 接口
          </label>
          <button className="yaws-btn-primary tool-text" disabled={busy}>
            <Save size={16} />
            保存设置
          </button>
        </form>
      )}
      <select
        aria-label="AI 历史任务"
        className="yaws-select w-full mt-3"
        value=""
        disabled={busy}
        onChange={(e) => void history(e.target.value)}
      >
        <option value="">历史任务</option>
        {runs.map((run) => (
          <option key={run.id} value={run.id}>
            {new Date(run.createdAt).toLocaleString()} ·{" "}
            {run.prompt.slice(0, 80)}
          </option>
        ))}
      </select>
      <form
        className="ai-prompt"
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
      >
        <label>
          工作目录
          <input
            className="yaws-input font-mono"
            required
            value={root}
            onChange={(e) => setRoot(e.target.value)}
            disabled={busy}
          />
        </label>
        <label>
          任务
          <textarea
            className="yaws-input"
            rows={4}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            required
            placeholder="例如：检查 Nginx 配置，生成开启 gzip 的修改方案"
            disabled={busy}
          />
        </label>
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-xs text-white/50 flex-1">
            目录内读取的文件将发送到已配置的模型接口
          </span>
          {busy ? (
            <button
              type="button"
              className="yaws-btn tool-text"
              onClick={() => controller.current?.abort()}
            >
              <Square size={16} />
              停止
            </button>
          ) : (
            <button
              className="yaws-btn-primary tool-text"
              disabled={!config.model || !prompt.trim()}
            >
              <Send size={16} />
              生成修改
            </button>
          )}
        </div>
      </form>
      {error && (
        <div role="alert" className="yaws-alert-error">
          {error}
        </div>
      )}
      {notice && <div className="workspace-notice">{notice}</div>}
      {busy && <div className="workspace-notice">正在分析选定目录…</div>}
      {result && (
        <>
          <div className="ai-answer">{result.answer || "修改建议"}</div>
          <details className="text-xs text-white/50 py-2">
            <summary>读取记录（{result.trace.length}）</summary>
            {result.trace.map((t, i) => (
              <div key={i}>
                {t.tool} · {t.path}
              </div>
            ))}
          </details>
          {result.proposals.map((p) => (
            <section key={p.id} className="ai-proposal">
              <div className="workspace-toolbar">
                <strong className="min-w-0 flex-1 break-all text-sm">
                  {p.path}
                </strong>
                <button
                  className="yaws-btn-primary tool-text"
                  disabled={p.status !== "pending" || applying !== null}
                  onClick={() => void apply(p)}
                >
                  {p.kind === "file" ? <Check size={16} /> : <Play size={16} />}{" "}
                  {p.status === "applied"
                    ? "已应用"
                    : p.kind === "file"
                      ? "应用修改"
                      : "执行命令"}
                </button>
              </div>
              <pre className="diff-view">
                {p.kind === "command"
                  ? p.after
                  : diffLines(p.before, p.after).map((part, i) => (
                      <span
                        key={i}
                        className={
                          part.added
                            ? "diff-add"
                            : part.removed
                              ? "diff-remove"
                              : ""
                        }
                      >
                        {part.value.split("\n").map((line, j) =>
                          j === part.value.split("\n").length - 1 &&
                          line === "" ? null : (
                            <span key={j} className="diff-line">
                              {part.added ? "+" : part.removed ? "-" : " "}{" "}
                              {line}
                              {"\n"}
                            </span>
                          ),
                        )}
                      </span>
                    ))}
              </pre>
            </section>
          ))}
        </>
      )}
      {commandOutput && <pre className="command-output">{commandOutput}</pre>}
    </div>
  );
}
