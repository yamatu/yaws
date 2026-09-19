import { useCallback, useEffect, useState } from "react";
import {
  Check,
  ChevronRight,
  LoaderCircle,
  Plus,
  Trash2,
  X,
  Zap,
} from "lucide-react";
import { apiFetch } from "./api";
import { workspaceError } from "./workspaceErrors";

export type McpServer = {
  id: string;
  name: string;
  enabled: boolean;
  transport: "stdio" | "http";
  command: string;
  args: string[];
  env: Record<string, string>;
  url: string;
  headers: Record<string, string>;
};

type Pair = [string, string];
type Draft = Omit<McpServer, "args" | "env" | "headers"> & {
  argsText: string;
  env: Pair[];
  headers: Pair[];
};

const newServerId = () =>
  `srv_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

const linesToArgs = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

const recordToPairs = (record: Record<string, string>): Pair[] =>
  Object.entries(record).map(([key, value]) => [key, value]);

const pairsToRecord = (pairs: Pair[]): Record<string, string> => {
  const record: Record<string, string> = {};
  for (const [key, value] of pairs) {
    const name = key.trim();
    if (name) record[name] = value;
  }
  return record;
};

function blankServer(): Draft {
  return {
    id: newServerId(),
    name: "新 MCP 服务",
    enabled: true,
    transport: "stdio",
    command: "",
    argsText: "",
    env: [],
    url: "",
    headers: [],
  };
}

function toDraft(server: McpServer): Draft {
  return {
    id: server.id,
    name: server.name,
    enabled: server.enabled,
    transport: server.transport,
    command: server.command,
    argsText: server.args.join("\n"),
    env: recordToPairs(server.env),
    url: server.url,
    headers: recordToPairs(server.headers),
  };
}

function toBody(draft: Draft): McpServer {
  return {
    id: draft.id,
    name: draft.name,
    enabled: draft.enabled,
    transport: draft.transport,
    command: draft.command,
    args: linesToArgs(draft.argsText),
    env: pairsToRecord(draft.env),
    url: draft.url,
    headers: pairsToRecord(draft.headers),
  };
}

/** Editable key/value rows used for env vars and HTTP headers. */
function PairEditor({
  label,
  hint,
  pairs,
  onChange,
}: {
  label: string;
  hint: string;
  pairs: Pair[];
  onChange: (pairs: Pair[]) => void;
}) {
  const update = (index: number, pair: Pair) =>
    onChange(pairs.map((row, i) => (i === index ? pair : row)));
  return (
    <div className="mcp-pairs">
      <div className="mcp-pairs-head">
        <span>{label}</span>
        <button
          type="button"
          className="ai-profile-mini"
          onClick={() => onChange([...pairs, ["", ""]])}
        >
          <Plus size={12} />
          添加
        </button>
      </div>
      {pairs.map((pair, index) => (
        <div className="mcp-pair-row" key={index}>
          <input
            className="yaws-input"
            placeholder="名称"
            value={pair[0]}
            onChange={(e) => update(index, [e.target.value, pair[1]])}
          />
          <input
            className="yaws-input"
            type="password"
            autoComplete="new-password"
            placeholder={pair[0] && !pair[1] ? "留空保留已保存的值" : hint}
            value={pair[1]}
            onChange={(e) => update(index, [pair[0], e.target.value])}
          />
          <button
            type="button"
            className="icon-btn"
            title="删除"
            aria-label="删除"
            onClick={() => onChange(pairs.filter((_, i) => i !== index))}
          >
            <X size={14} />
          </button>
        </div>
      ))}
      {pairs.length === 0 && <p className="mcp-hint">{hint}</p>}
    </div>
  );
}

/**
 * MCP server settings. Rendered inside the AI settings form, so its own
 * actions are `type="button"` and the panel saves itself against `/api/ai/mcp`.
 */
export function McpSettings() {
  const [servers, setServers] = useState<Draft[]>([]);
  const [editingId, setEditingId] = useState("");
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [tools, setTools] = useState<string[] | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const current = servers.find((server) => server.id === editingId) ?? servers[0];

  const apply = useCallback((list: McpServer[]) => {
    const drafts = list.map(toDraft);
    setServers(drafts);
    setEditingId((id) =>
      drafts.some((server) => server.id === id) ? id : (drafts[0]?.id ?? ""),
    );
    return drafts;
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const data = await apiFetch<{ servers: McpServer[] }>("/api/ai/mcp", {
          signal: controller.signal,
        });
        apply(data.servers);
      } catch (e) {
        if (!controller.signal.aborted) setError(workspaceError(e));
      }
    })();
    return () => controller.abort();
  }, [apply]);

  function patch(id: string, changes: Partial<Draft>) {
    setServers((old) =>
      old.map((server) => (server.id === id ? { ...server, ...changes } : server)),
    );
  }

  function addServer() {
    const draft = blankServer();
    setServers((old) => [...old, draft]);
    setEditingId(draft.id);
    setTools(null);
    setNotice("");
  }

  async function removeServer(id: string) {
    const rest = servers.filter((server) => server.id !== id);
    setServers(rest);
    setEditingId(rest[0]?.id ?? "");
    setTools(null);
    try {
      const data = await apiFetch<{ servers: McpServer[] }>("/api/ai/mcp", {
        method: "PUT",
        body: JSON.stringify({ servers: rest.map(toBody) }),
      });
      apply(data.servers);
      setNotice("已删除 MCP 服务");
    } catch (e) {
      setError(workspaceError(e));
    }
  }

  async function save() {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const data = await apiFetch<{ servers: McpServer[] }>("/api/ai/mcp", {
        method: "PUT",
        body: JSON.stringify({ servers: servers.map(toBody) }),
      });
      apply(data.servers);
      setNotice("MCP 服务已保存，下一轮对话生效");
    } catch (e) {
      setError(workspaceError(e));
    } finally {
      setBusy(false);
    }
  }

  async function test() {
    if (!current) return;
    setTesting(true);
    setError("");
    setTools(null);
    try {
      const data = await apiFetch<{ ok: true; tools: string[] }>(
        "/api/ai/mcp/test",
        { method: "POST", body: JSON.stringify({ server: toBody(current) }) },
      );
      setTools(data.tools);
    } catch (e) {
      setError(workspaceError(e));
    } finally {
      setTesting(false);
    }
  }

  return (
    <div
      className="mcp-settings"
      onKeyDown={(e) => {
        // Enter inside an MCP field must not submit the surrounding profile form.
        if ((e.target as HTMLElement).tagName === "INPUT" && e.key === "Enter")
          e.preventDefault();
      }}
    >
      <div className="ai-profiles-top">
        <span className="ai-profiles-label">
          MCP 服务（挂载外部工具）
        </span>
        <button type="button" className="ai-profile-mini" onClick={addServer}>
          <Plus size={13} />
          添加服务
        </button>
      </div>
      <div className="ai-profile-list">
        {servers.map((server) => (
          <button
            key={server.id}
            type="button"
            className={`ai-profile-chip${server.id === current?.id ? " active" : ""}`}
            aria-pressed={server.id === current?.id}
            onClick={() => {
              setEditingId(server.id);
              setTools(null);
            }}
          >
            {server.name || "未命名"}
            {server.enabled ? (
              <span className="ai-profile-dot" title="已启用" />
            ) : (
              <span className="ai-profile-warn" title="已停用">
                –
              </span>
            )}
          </button>
        ))}
        {servers.length === 0 && (
          <p className="mcp-hint">
            还没有 MCP 服务。添加后，AI 助手会像使用内置工具一样调用它们提供的工具。
          </p>
        )}
      </div>
      {current ? (
        <>
          <label>
            名称
            <input
              className="yaws-input"
              value={current.name}
              required
              onChange={(e) => patch(current.id, { name: e.target.value })}
            />
          </label>
          <label>
            传输方式
            <select
              className="yaws-select w-full"
              value={current.transport}
              onChange={(e) =>
                patch(current.id, {
                  transport: e.target.value as Draft["transport"],
                })
              }
            >
              <option value="stdio">stdio（本地命令）</option>
              <option value="http">http（远程 Streamable HTTP）</option>
            </select>
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={current.enabled}
              onChange={(e) => patch(current.id, { enabled: e.target.checked })}
            />
            启用该服务
          </label>
          {current.transport === "stdio" ? (
            <>
              <label>
                启动命令
                <input
                  className="yaws-input"
                  placeholder="npx"
                  value={current.command}
                  onChange={(e) => patch(current.id, { command: e.target.value })}
                />
              </label>
              <label>
                参数（每行一个）
                <textarea
                  className="yaws-input"
                  rows={3}
                  placeholder={"-y\n@modelcontextprotocol/server-filesystem\n/var/log"}
                  value={current.argsText}
                  onChange={(e) => patch(current.id, { argsText: e.target.value })}
                />
              </label>
              <PairEditor
                label="环境变量"
                hint="示例：API_KEY=..."
                pairs={current.env}
                onChange={(env) => patch(current.id, { env })}
              />
            </>
          ) : (
            <>
              <label>
                服务地址
                <input
                  className="yaws-input"
                  type="url"
                  placeholder="https://mcp.example.com/mcp"
                  value={current.url}
                  onChange={(e) => patch(current.id, { url: e.target.value })}
                />
              </label>
              <PairEditor
                label="请求头"
                hint="示例：Authorization=Bearer ..."
                pairs={current.headers}
                onChange={(headers) => patch(current.id, { headers })}
              />
            </>
          )}
          <div className="ai-settings-actions">
            <button
              type="button"
              className="yaws-btn tool-text"
              disabled={testing}
              onClick={() => void test()}
            >
              {testing ? (
                <LoaderCircle size={15} className="spin" />
              ) : (
                <Zap size={15} />
              )}
              测试连接
            </button>
            <button
              type="button"
              className="yaws-btn tool-text danger"
              onClick={() => void removeServer(current.id)}
            >
              <Trash2 size={15} />
              删除
            </button>
          </div>
          {tools && (
            <div className="mcp-tools">
              连接成功，发现 {tools.length} 个工具：
              <div className="ai-chips">
                {tools.map((tool) => (
                  <span className="ai-chip" key={tool}>
                    {tool}
                  </span>
                ))}
              </div>
            </div>
          )}
          {error && <p className="mcp-error">{error}</p>}
          {notice && <p className="mcp-notice">{notice}</p>}
        </>
      ) : null}
      <div className="ai-settings-actions">
        <button
          type="button"
          className="yaws-btn-primary tool-text"
          disabled={busy || !servers.length}
          onClick={() => void save()}
        >
          {busy ? <LoaderCircle size={16} className="spin" /> : <Check size={16} />}
          保存 MCP 服务
        </button>
        {servers.length > 0 && (
          <span className="mcp-hint inline-flex items-center gap-1">
            <ChevronRight size={13} />
            工具名会以 mcp__ 前缀出现在助手的工具列表里
          </span>
        )}
      </div>
    </div>
  );
}
