import { useCallback, useEffect, useState } from "react";
import {
  Download,
  LoaderCircle,
  Power,
  RefreshCw,
  Trash2,
  Wrench,
} from "lucide-react";
import { apiFetch } from "./api";
import { workspaceError } from "./workspaceErrors";

export type ExtensionPackage = {
  id: string;
  name: string;
  source: string;
  enabled: boolean;
  addedAt: number;
  /** Names contributed by this package, for the summary line. */
  tools: string[];
  skills: string[];
  prompts: string[];
};

export type ExtensionState = {
  directory: string;
  packages: ExtensionPackage[];
  tools: Array<{
    name: string;
    title: string;
    description: string;
    readOnly: boolean;
    packageId: string;
    packageName: string;
  }>;
  skills: Array<{
    name: string;
    description: string;
    packageId: string;
    packageName: string;
  }>;
  prompts: Array<{
    name: string;
    description: string;
    packageId: string;
    packageName: string;
  }>;
  errors: string[];
};

const EMPTY: ExtensionState = {
  directory: "",
  packages: [],
  tools: [],
  skills: [],
  prompts: [],
  errors: [],
};

const EXAMPLES = ["/path/to/my-extension", "npm:yaws-extension-example", "git:github.com/user/yaws-ext"];

/**
 * Extension package settings. Rendered inside the AI settings form, so every
 * action is `type="button"`; the panel talks to `/api/ai/extensions` on its own.
 */
export function ExtensionSettings() {
  const [state, setState] = useState<ExtensionState>(EMPTY);
  const [source, setSource] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [openId, setOpenId] = useState("");

  const apply = useCallback((next: ExtensionState) => {
    setState(next);
    setOpenId("");
    setNotice("");
    setError("");
    return next;
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const data = await apiFetch<ExtensionState>("/api/ai/extensions", {
          signal: controller.signal,
        });
        setState(data);
      } catch (e) {
        if (!controller.signal.aborted) setError(workspaceError(e));
      }
    })();
    return () => controller.abort();
  }, []);

  const request = async (method: "POST" | "PUT", path: string, body?: unknown, tag = path) => {
    setBusy(tag);
    setError("");
    setNotice("");
    try {
      const data = await apiFetch<ExtensionState>(path, {
        method,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return apply(data);
    } catch (e) {
      setError(workspaceError(e));
      return null;
    } finally {
      setBusy("");
    }
  };

  const install = async () => {
    const value = source.trim();
    if (!value) return;
    const next = await request("POST", "/api/ai/extensions/install", { source: value }, "install");
    if (next) {
      setSource("");
      setNotice("扩展包已安装并生效，新工具对下一轮对话可用。");
    }
  };

  const remove = async (entry: ExtensionPackage) => {
    if (!window.confirm(`移除扩展包「${entry.name || entry.source}」？`)) return;
    await request("POST", "/api/ai/extensions/remove", { id: entry.id }, `remove:${entry.id}`);
  };

  const toggle = (entry: ExtensionPackage) =>
    request(
      "PUT",
      "/api/ai/extensions",
      { packages: [{ id: entry.id, enabled: !entry.enabled }] },
      `toggle:${entry.id}`,
    );

  const reload = async () => {
    const next = await request("POST", "/api/ai/extensions/reload", undefined, "reload");
    if (next) setNotice("已重新读取扩展包。");
  };

  return (
    <div
      className="mcp-settings ext-settings"
      onKeyDown={(e) => {
        // Enter inside these fields must not submit the surrounding profile form.
        if ((e.target as HTMLElement).tagName === "INPUT" && e.key === "Enter") {
          e.preventDefault();
          void install();
        }
      }}
    >
      <div className="ai-profiles-top">
        <span className="ai-profiles-label">扩展包（官方扩展机制）</span>
        <button
          type="button"
          className="ai-profile-mini"
          disabled={busy === "reload"}
          onClick={() => void reload()}
        >
          {busy === "reload" ? (
            <LoaderCircle size={13} className="spin" />
          ) : (
            <RefreshCw size={13} />
          )}
          重新加载
        </button>
      </div>

      <div className="mcp-pair-row ext-install-row">
        <input
          className="yaws-input"
          placeholder="本地目录、npm:包名 或 git:仓库地址"
          value={source}
          onChange={(e) => setSource(e.target.value)}
        />
        <button
          type="button"
          className="yaws-btn tool-text"
          disabled={busy === "install" || !source.trim()}
          onClick={() => void install()}
        >
          {busy === "install" ? (
            <LoaderCircle size={15} className="spin" />
          ) : (
            <Download size={15} />
          )}
          安装
        </button>
      </div>
      <p className="mcp-hint">
        示例：{EXAMPLES.join("　")}
        。扩展包会在服务器上以相同权限运行代码，只安装可信来源。
      </p>

      {state.packages.length === 0 ? (
        <p className="mcp-hint">
          还没有扩展包。安装后，扩展提供的工具会挂到 AI 助手上，技能会写进系统提示，
          提示模板用 /名字 触发。
        </p>
      ) : (
        <div className="ext-list">
          {state.packages.map((entry) => {
            const open = openId === entry.id;
            const tools = state.tools.filter((tool) => tool.packageId === entry.id);
            const skills = state.skills.filter((skill) => skill.packageId === entry.id);
            const prompts = state.prompts.filter((prompt) => prompt.packageId === entry.id);
            const problem = state.errors.find((text) => text.includes(entry.id));
            return (
              <div
                className={`ext-card${entry.enabled ? "" : " off"}`}
                key={entry.id}
              >
                <div className="ext-card-head">
                  <button
                    type="button"
                    className="ext-card-title"
                    aria-expanded={open}
                    onClick={() => setOpenId(open ? "" : entry.id)}
                  >
                    <strong>{entry.name || entry.id}</strong>
                    <span className="ext-source">{entry.source}</span>
                    <span className="ext-counts">
                      {tools.length} 个工具 · {skills.length} 个技能 · {prompts.length} 个模板
                    </span>
                  </button>
                  <button
                    type="button"
                    className="ai-profile-mini"
                    disabled={busy === `toggle:${entry.id}`}
                    title={entry.enabled ? "停用该扩展包" : "启用该扩展包"}
                    onClick={() => void toggle(entry)}
                  >
                    <Power size={13} />
                    {entry.enabled ? "已启用" : "已停用"}
                  </button>
                  <button
                    type="button"
                    className="icon-btn"
                    title="移除扩展包"
                    aria-label="移除扩展包"
                    disabled={busy === `remove:${entry.id}`}
                    onClick={() => void remove(entry)}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
                {problem ? <p className="ext-error">{problem}</p> : null}
                {open ? (
                  <div className="ext-detail">
                    {tools.length ? (
                      <ul className="ext-tool-list">
                        {tools.map((tool) => (
                          <li key={tool.name}>
                            <Wrench size={13} />
                            <code>{tool.name}</code>
                            <span>{tool.description}</span>
                            <em>{tool.readOnly ? "只读" : "可写"}</em>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                    {skills.length ? (
                      <p className="mcp-hint">
                        技能：
                        {skills.map((skill) => skill.name).join("、")}
                      </p>
                    ) : null}
                    {prompts.length ? (
                      <p className="mcp-hint">
                        提示模板：
                        {prompts.map((prompt) => `/${prompt.name}`).join("、")}
                      </p>
                    ) : null}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}

      {state.errors.length ? (
        <p className="ext-error">
          加载失败：{state.errors.join("；")}
        </p>
      ) : null}
      {notice ? <p className="mcp-notice">{notice}</p> : null}
      {error ? <p className="mcp-error">{error}</p> : null}
      {state.directory ? (
        <p className="mcp-hint">扩展包目录：{state.directory}</p>
      ) : null}
    </div>
  );
}
