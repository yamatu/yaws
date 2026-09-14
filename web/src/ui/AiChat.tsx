import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  CircleStop,
  Cpu,
  FileCode2,
  FolderTree,
  MessageSquarePlus,
  Pencil,
  Play,
  Send,
  Settings2,
  Sparkles,
  Terminal,
  Trash2,
  Undo2,
} from "lucide-react";
import { diffLines } from "diff";
import { apiFetch } from "./api";
import { getToken } from "./auth";
import { workspaceError } from "./workspaceErrors";

type Config = {
  baseUrl: string;
  model: string;
  protocol: "chat" | "responses";
  reasoning: string;
  allowPrivate: boolean;
  hasKey?: boolean;
};
type AutoRun = "off" | "read" | "all";
type Tool = {
  id: string;
  name: string;
  detail: string;
  state: "running" | "ok" | "error" | "awaiting";
  output?: string;
  code?: number | null;
  readOnly?: boolean;
  auto?: boolean;
  purpose?: string;
};
type Proposal = {
  id: string;
  kind: "file" | "command";
  path: string;
  before: string;
  after: string;
  revision: string;
  status: string;
  summary: string;
  result: { output?: string; code?: number | null; backup?: string | null } | null;
};
type Entry =
  | { key: string; kind: "user"; text: string }
  | { key: string; kind: "assistant"; text: string }
  | { key: string; kind: "tool"; tool: Tool }
  | { key: string; kind: "proposal"; proposal: Proposal }
  | { key: string; kind: "error"; text: string };
type Conversation = {
  id: string;
  title: string;
  root: string;
  updatedAt: number;
  turns: number;
};

export const AUTO_RUN_KEY = "yaws.ai.autorun";
export const AUTO_RUN_MODES: Array<{ value: AutoRun; label: string }> = [
  { value: "read", label: "只读命令自动执行（推荐）" },
  { value: "all", label: "修改类命令也自动执行" },
  { value: "off", label: "每条命令都先确认" },
];
const EXAMPLES = [
  "服务器磁盘和内存现在什么情况？",
  "Nginx 为什么启动失败，帮我查日志并给出修复命令",
  "看看哪个进程占用 CPU 最高",
];

export function storedAutoRun(): AutoRun {
  try {
    const value = localStorage.getItem(AUTO_RUN_KEY);
    if (value === "off" || value === "read" || value === "all") return value;
  } catch {
    // private mode
  }
  return "read";
}

const chatKey = (machineId: number) => `yaws.ai.chat.${machineId}`;

function storedConversation(machineId: number): string {
  try {
    return localStorage.getItem(chatKey(machineId)) ?? "";
  } catch {
    return "";
  }
}

const TOOL_ICON: Record<string, typeof Terminal> = {
  list_files: FolderTree,
  read_file: FileCode2,
  read_log: Terminal,
  run_command: Terminal,
  server_stats: Cpu,
  write_file: Pencil,
};

const TOOL_STATE: Record<Tool["state"], string> = {
  running: "执行中…",
  ok: "完成",
  error: "失败",
  awaiting: "等待确认",
};

export function AiChat({
  machineId,
  initialRoot,
  compact = false,
}: {
  machineId: number;
  initialRoot: string;
  compact?: boolean;
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
  const [root, setRoot] = useState(initialRoot || "/");
  const [autoRun, setAutoRun] = useState<AutoRun>(storedAutoRun);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [conversationId, setConversationId] = useState("");
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [openTools, setOpenTools] = useState<Record<string, boolean>>({});
  const [working, setWorking] = useState("");
  const controller = useRef<AbortController | null>(null);
  const transcript = useRef<HTMLDivElement | null>(null);
  const counter = useRef(0);
  const nextKey = () => `e${++counter.current}`;

  useEffect(() => setRoot(initialRoot || "/"), [initialRoot]);

  const push = useCallback((entry: Entry) => {
    setEntries((old) => [...old, entry]);
  }, []);

  const loadConversations = useCallback(async () => {
    try {
      const data = await apiFetch<{ conversations: Conversation[] }>(
        `/api/ai/conversations?machineId=${machineId}`,
      );
      setConversations(data.conversations);
      return data.conversations;
    } catch {
      return [] as Conversation[];
    }
  }, [machineId]);

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

  const openConversation = useCallback(
    async (id: string) => {
      if (!id) return;
      try {
        const data = await apiFetch<{
          conversation: { root: string };
          turns: Array<{
            prompt: string;
            answer: string;
            trace: Tool[];
            proposals: Proposal[];
          }>;
        }>(`/api/ai/conversations/${id}`);
        const restored: Entry[] = [];
        for (const turn of data.turns) {
          restored.push({ key: nextKey(), kind: "user", text: turn.prompt });
          for (const tool of turn.trace ?? [])
            restored.push({ key: nextKey(), kind: "tool", tool });
          for (const proposal of turn.proposals ?? [])
            restored.push({ key: nextKey(), kind: "proposal", proposal });
          if (turn.answer)
            restored.push({ key: nextKey(), kind: "assistant", text: turn.answer });
        }
        setEntries(restored);
        setConversationId(id);
        if (data.conversation.root) setRoot(data.conversation.root);
        try {
          localStorage.setItem(chatKey(machineId), id);
        } catch {
          // ignore
        }
      } catch (e) {
        setError(workspaceError(e));
      }
    },
    [machineId],
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const list = await loadConversations();
      const stored = storedConversation(machineId);
      if (!cancelled && stored && list.some((c) => c.id === stored))
        await openConversation(stored);
    })();
    return () => {
      cancelled = true;
    };
  }, [machineId, loadConversations, openConversation]);

  useEffect(() => {
    const node = transcript.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [entries, working]);

  function newChat() {
    controller.current?.abort();
    setEntries([]);
    setConversationId("");
    setError("");
    setNotice("");
    setWorking("");
    try {
      localStorage.removeItem(chatKey(machineId));
    } catch {
      // ignore
    }
  }

  async function saveSettings() {
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
    }
  }

  function handleEvent(event: Record<string, any>) {
    if (event.type === "start") {
      setConversationId(event.conversationId);
      try {
        localStorage.setItem(chatKey(machineId), event.conversationId);
      } catch {
        // ignore
      }
    } else if (event.type === "tool") {
      const tool = event.tool as Tool;
      setEntries((old) => {
        const index = old.findIndex(
          (entry) => entry.kind === "tool" && entry.tool.id === tool.id,
        );
        if (index < 0) return [...old, { key: nextKey(), kind: "tool", tool }];
        const copy = old.slice();
        copy[index] = { key: copy[index].key, kind: "tool", tool };
        return copy;
      });
      setWorking(TOOL_STATE[tool.state]);
    } else if (event.type === "proposal") {
      const proposal = event.proposal as Proposal;
      setEntries((old) => {
        const index = old.findIndex(
          (entry) => entry.kind === "proposal" && entry.proposal.id === proposal.id,
        );
        if (index < 0)
          return [...old, { key: nextKey(), kind: "proposal", proposal }];
        const copy = old.slice();
        copy[index] = { key: copy[index].key, kind: "proposal", proposal };
        return copy;
      });
    } else if (event.type === "delta") {
      setEntries((old) => {
        const copy = old.slice();
        for (let i = copy.length - 1; i >= 0; i--) {
          const entry = copy[i];
          if (entry.kind === "user") break;
          if (entry.kind === "assistant") {
            copy[i] = { ...entry, text: entry.text + String(event.text) };
            return copy;
          }
        }
        return [...copy, { key: nextKey(), kind: "assistant", text: String(event.text) }];
      });
    } else if (event.type === "answer") {
      const text = String(event.text ?? "");
      setEntries((old) => {
        const copy = old.slice();
        for (let i = copy.length - 1; i >= 0; i--) {
          const entry = copy[i];
          if (entry.kind === "user") break;
          if (entry.kind === "assistant") {
            copy[i] = { ...entry, text };
            return copy;
          }
        }
        return [...copy, { key: nextKey(), kind: "assistant", text }];
      });
    } else if (event.type === "error") {
      setError(workspaceError(new Error(String(event.error ?? "请求失败"))));
    } else if (event.type === "done") {
      const proposals = (event.proposals ?? []) as Proposal[];
      if (proposals.length)
        setEntries((old) =>
          old.map((entry) => {
            if (entry.kind !== "proposal") return entry;
            const found = proposals.find((p) => p.id === entry.proposal.id);
            return found
              ? { key: entry.key, kind: "proposal", proposal: found }
              : entry;
          }),
        );
    }
  }

  async function send() {
    const message = input.trim();
    if (!message || busy) return;
    setInput("");
    setError("");
    setNotice("");
    push({ key: nextKey(), kind: "user", text: message });
    setBusy(true);
    setWorking("正在思考…");
    const ac = new AbortController();
    controller.current = ac;
    try {
      const token = getToken();
      const response = await fetch(`/api/ai/machines/${machineId}/chat`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ conversationId, message, root, autoRun }),
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
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            handleEvent(JSON.parse(line));
          } catch {
            // ignore malformed frame
          }
        }
      }
      void loadConversations();
    } catch (e) {
      const aborted =
        ac.signal.aborted || (e as Error)?.name === "AbortError";
      setError(aborted ? "已停止" : workspaceError(e));
    } finally {
      setBusy(false);
      setWorking("");
      controller.current = null;
    }
  }

  async function decide(proposal: Proposal, action: "apply" | "revert" | "reject") {
    const confirmText =
      action === "apply"
        ? proposal.kind === "command"
          ? `在目录 ${root} 执行以下命令？\n\n${proposal.after}`
          : `写入 ${proposal.path}？修改前的版本会自动备份。`
        : action === "revert"
          ? `撤销对 ${proposal.path} 的修改？`
          : `忽略这条待确认操作？`;
    if (!window.confirm(confirmText)) return;
    setError("");
    setNotice("");
    try {
      if (action === "reject") {
        await apiFetch(
          `/api/ai/machines/${machineId}/proposals/${proposal.id}/reject`,
          { method: "POST", body: JSON.stringify({ confirm: true }) },
        );
        updateProposal({ ...proposal, status: "rejected" });
        setNotice("已忽略该操作");
        return;
      }
      const data = await apiFetch<{
        result: {
          output?: string;
          code?: number | null;
          backup?: string | null;
          revision?: string;
        };
      }>(
        `/api/ai/machines/${machineId}/proposals/${proposal.id}/${action}`,
        { method: "POST", body: JSON.stringify({ confirm: true }) },
      );
      updateProposal({
        ...proposal,
        status: action === "apply" ? "applied" : "reverted",
        result: data.result ?? null,
      });
      setNotice(
        action === "revert"
          ? `已还原 ${proposal.path}`
          : proposal.kind === "command"
            ? `命令执行完成（退出码 ${data.result?.code ?? "未知"}）`
            : `已保存 ${proposal.path}${data.result?.backup ? ` · 备份 ${data.result.backup}` : ""}`,
      );
    } catch (e) {
      setError(workspaceError(e));
    }
  }

  function updateProposal(proposal: Proposal) {
    setEntries((old) =>
      old.map((entry) =>
        entry.kind === "proposal" && entry.proposal.id === proposal.id
          ? { key: entry.key, kind: "proposal", proposal }
          : entry,
      ),
    );
  }

  const pending = entries.filter(
    (entry) => entry.kind === "proposal" && entry.proposal.status === "pending",
  ).length;

  return (
    <div className={`ai-chat${compact ? " compact" : ""}`}>
      <div className="workspace-toolbar ai-chat-head">
        <Sparkles size={16} />
        <strong className="flex-1 min-w-0 truncate text-sm">AI 助手</strong>
        <span className="text-xs text-white/45 truncate hidden sm:inline">
          {config.model || "未配置模型"}
        </span>
        <select
          aria-label="历史对话"
          className="yaws-select ai-chat-history"
          value={conversationId}
          disabled={busy}
          onChange={(e) => {
            const id = e.target.value;
            if (id) void openConversation(id);
            else newChat();
          }}
        >
          <option value="">新对话</option>
          {conversations.map((c) => (
            <option key={c.id} value={c.id}>
              {c.title || "未命名"} · {c.turns} 轮
            </option>
          ))}
        </select>
        <button
          className="icon-btn"
          title="新对话"
          aria-label="新对话"
          onClick={newChat}
        >
          <MessageSquarePlus size={17} />
        </button>
        <button
          className="icon-btn"
          title="AI 设置"
          aria-label="AI 设置"
          aria-expanded={settings}
          onClick={() => setSettings((v) => !v)}
        >
          <Settings2 size={17} />
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
              onChange={(e) => setConfig({ ...config, baseUrl: e.target.value })}
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
              onChange={(e) => setConfig({ ...config, reasoning: e.target.value })}
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
          <button className="yaws-btn-primary tool-text" type="submit">
            <Check size={16} />
            保存设置
          </button>
        </form>
      )}
      <div className="ai-chat-transcript" ref={transcript}>
        {entries.length === 0 && !busy && (
          <div className="ai-chat-empty">
            <p>
              直接提问即可。助手会自己读取服务器上的文件和日志，需要改动服务器时会先生成待确认的操作卡片。
            </p>
            <div className="ai-chips">
              {EXAMPLES.map((example) => (
                <button
                  key={example}
                  type="button"
                  className="ai-chip"
                  onClick={() => setInput(example)}
                >
                  {example}
                </button>
              ))}
            </div>
          </div>
        )}
        {entries.map((entry) => {
          if (entry.kind === "user")
            return (
              <div key={entry.key} className="ai-row user">
                <div className="ai-bubble">{entry.text}</div>
              </div>
            );
          if (entry.kind === "assistant")
            return (
              <div key={entry.key} className="ai-row">
                <div className="ai-answer">{entry.text}</div>
              </div>
            );
          if (entry.kind === "error")
            return (
              <div key={entry.key} role="alert" className="yaws-alert-error">
                {entry.text}
              </div>
            );
          if (entry.kind === "tool") {
            const Icon = TOOL_ICON[entry.tool.name] ?? Terminal;
            const open = openTools[entry.key] ?? entry.tool.state === "error";
            return (
              <div key={entry.key} className="ai-tool">
                <button
                  type="button"
                  className="ai-tool-head"
                  aria-expanded={open}
                  onClick={() =>
                    setOpenTools((old) => ({ ...old, [entry.key]: !open }))
                  }
                >
                  {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  <Icon size={14} />
                  <span className="ai-tool-name">{entry.tool.detail || entry.tool.name}</span>
                  {entry.tool.readOnly ? (
                    <span className="ai-tag">只读</span>
                  ) : null}
                  <span className={`ai-tool-state ${entry.tool.state}`}>
                    {TOOL_STATE[entry.tool.state]}
                  </span>
                </button>
                {open && entry.tool.output ? (
                  <pre className="ai-tool-out">{entry.tool.output}</pre>
                ) : null}
              </div>
            );
          }
          const { proposal } = entry;
          const dismissed = proposal.status === "rejected";
          return (
            <section key={entry.key} className={`ai-proposal${dismissed ? " muted" : ""}`}>
              <div className="workspace-toolbar">
                <strong className="min-w-0 flex-1 break-all text-sm">
                  {proposal.kind === "command" ? "执行命令" : proposal.path}
                </strong>
                {proposal.status === "pending" ? (
                  <>
                    <button
                      className="yaws-btn tool-text"
                      onClick={() => void decide(proposal, "reject")}
                    >
                      忽略
                    </button>
                    <button
                      className="yaws-btn-primary tool-text"
                      onClick={() => void decide(proposal, "apply")}
                    >
                      {proposal.kind === "file" ? <Check size={16} /> : <Play size={16} />}
                      {proposal.kind === "file" ? "应用修改" : "执行命令"}
                    </button>
                  </>
                ) : proposal.status === "applied" && proposal.kind === "file" ? (
                  <>
                    <span className="ai-tag ok">已应用</span>
                    <button
                      className="yaws-btn tool-text"
                      onClick={() => void decide(proposal, "revert")}
                    >
                      <Undo2 size={16} />
                      撤销
                    </button>
                  </>
                ) : (
                  <span className={`ai-tag ${proposal.status}`}>
                    {proposal.status === "applied"
                      ? "已执行"
                      : proposal.status === "reverted"
                        ? "已还原"
                        : proposal.status === "rejected"
                          ? "已忽略"
                          : proposal.status === "failed"
                            ? "执行失败"
                            : proposal.status}
                  </span>
                )}
              </div>
              {proposal.summary ? (
                <div className="ai-proposal-note">{proposal.summary}</div>
              ) : null}
              {proposal.status === "pending" && proposal.kind === "command" ? (
                <div className="ai-proposal-note">
                  <AlertTriangle size={13} /> 需要你确认后才会在服务器上执行
                </div>
              ) : null}
              <pre className="diff-view">
                {proposal.kind === "command"
                  ? proposal.after
                  : diffLines(proposal.before, proposal.after).map((part, i) => (
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
                        {part.value.split("\n").map((line, j, all) =>
                          j === all.length - 1 && line === "" ? null : (
                            <span key={j} className="diff-line">
                              {part.added ? "+" : part.removed ? "-" : " "} {line}
                              {"\n"}
                            </span>
                          ),
                        )}
                      </span>
                    ))}
              </pre>
              {proposal.result?.output ? (
                <pre className="command-output">{proposal.result.output}</pre>
              ) : null}
            </section>
          );
        })}
        {busy ? <div className="ai-chat-working">{working || "处理中…"}</div> : null}
      </div>
      {error && (
        <div role="alert" className="yaws-alert-error">
          {error}
        </div>
      )}
      {notice && <div className="workspace-notice">{notice}</div>}
      {pending > 0 ? (
        <div className="ai-chat-pending">
          有 {pending} 条操作等待你确认，确认后助手才能继续。
        </div>
      ) : null}
      <form
        className="ai-chat-composer"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <div className="ai-chat-meta">
          <label className="flex items-center gap-1">
            目录
            <input
              className="yaws-input font-mono"
              aria-label="工作目录"
              required
              value={root}
              disabled={busy}
              onChange={(e) => setRoot(e.target.value)}
            />
          </label>
          <label className="flex items-center gap-1">
            执行方式
            <select
              className="yaws-select"
              aria-label="执行方式"
              value={autoRun}
              disabled={busy}
              onChange={(e) => {
                const value = e.target.value as AutoRun;
                setAutoRun(value);
                try {
                  localStorage.setItem(AUTO_RUN_KEY, value);
                } catch {
                  // ignore
                }
              }}
            >
              {AUTO_RUN_MODES.map((mode) => (
                <option key={mode.value} value={mode.value}>
                  {mode.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="ai-chat-input">
          <textarea
            className="yaws-input"
            rows={compact ? 2 : 3}
            value={input}
            placeholder="问点什么，例如：帮我看看 nginx 为什么 502"
            aria-label="问题"
            disabled={busy}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
          />
          {busy ? (
            <button
              type="button"
              className="yaws-btn tool-text"
              title="停止"
              aria-label="停止"
              onClick={() => controller.current?.abort()}
            >
              <CircleStop size={16} />
              停止
            </button>
          ) : (
            <button
              className="yaws-btn-primary tool-text"
              type="submit"
              disabled={!input.trim()}
            >
              <Send size={16} />
              发送
            </button>
          )}
        </div>
        <div className="ai-chat-hint">
          危险命令（rm -rf、mkfs、改密码等）永远需要确认；凭据文件不会被读取。
        </div>
        <button
          type="button"
          className="ai-chat-clear"
          title="清空对话"
          onClick={() => void deleteConversation()}
          hidden={!conversationId}
        >
          <Trash2 size={12} /> 删除这轮对话
        </button>
      </form>
    </div>
  );

  async function deleteConversation() {
    if (!conversationId || !window.confirm("删除这轮对话记录？")) return;
    try {
      await apiFetch(`/api/ai/conversations/${conversationId}`, { method: "DELETE" });
      newChat();
      void loadConversations();
    } catch (e) {
      setError(workspaceError(e));
    }
  }
}
