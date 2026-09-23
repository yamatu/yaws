import { useEffect, useState } from "react";
import { apiFetch } from "./api";
import { workspaceError } from "./workspaceErrors";

export type OfficialProvider = {
  id: string;
  name: string;
  baseUrl: string;
  connected: boolean;
  models: Array<{ id: string; name: string }>;
};
type LoginEvent =
  | { type: "auth_url"; url: string; instructions?: string }
  | { type: "device_code"; userCode: string; verificationUri: string }
  | { type: "prompt"; message: string; secret?: boolean;
      options?: Array<{ id: string; label: string }> }
  | { type: "progress" | "info"; message: string };
type LoginState = {
  status: "running" | "done" | "failed" | "cancelled";
  provider: string;
  event: LoginEvent | null;
  authEvent: Extract<LoginEvent, { type: "auth_url" | "device_code" }> | null;
};
const LOGIN_KEY = "yaws.ai.official.login";

export function OfficialModels({ onAdd }: {
  onAdd: (provider: OfficialProvider, model: string) => void;
}) {
  const [providers, setProviders] = useState<OfficialProvider[]>([]);
  const [providerId, setProviderId] = useState("openai-codex");
  const [modelId, setModelId] = useState("");
  const [loginId, setLoginId] = useState(() => {
    try { return sessionStorage.getItem(LOGIN_KEY) ?? ""; } catch { return ""; }
  });
  const [login, setLogin] = useState<LoginState | null>(null);
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  const selected = providers.find((provider) => provider.id === providerId);

  async function refresh() {
    const data = await apiFetch<{ providers: OfficialProvider[] }>(
      "/api/ai/official/providers",
    );
    setProviders(data.providers);
  }
  useEffect(() => {
    void refresh().catch((e) => setError(workspaceError(e)));
  }, []);
  useEffect(() => {
    if (!loginId) return;
    let alive = true;
    const poll = async () => {
      try {
        const data = await apiFetch<LoginState>(
          `/api/ai/official/login/${encodeURIComponent(loginId)}`,
        );
        if (!alive) return;
        setProviderId(data.provider);
        setLogin(data);
        if (data.status !== "running") {
          setLoginId("");
          try { sessionStorage.removeItem(LOGIN_KEY); } catch { /* private mode */ }
          if (data.status === "done") void refresh();
          if (data.status === "failed") setError("官方登录失败，请重试或检查主控能否访问提供商");
        }
      } catch (e) {
        if (alive) {
          setLoginId("");
          try { sessionStorage.removeItem(LOGIN_KEY); } catch { /* private mode */ }
          setError(workspaceError(e));
        }
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 1200);
    return () => { alive = false; clearInterval(timer); };
  }, [loginId]);
  async function start() {
    setError("");
    setLogin(null);
    try {
      const data = await apiFetch<{ loginId: string }>("/api/ai/official/login", {
        method: "POST", body: JSON.stringify({ provider: providerId }),
      });
      setLoginId(data.loginId);
      try { sessionStorage.setItem(LOGIN_KEY, data.loginId); } catch { /* private mode */ }
    } catch (e) { setError(workspaceError(e)); }
  }
  async function answer(answerValue: string) {
    if (!loginId) return;
    try {
      await apiFetch(`/api/ai/official/login/${encodeURIComponent(loginId)}/answer`, {
        method: "POST", body: JSON.stringify({ value: answerValue }),
      });
      setValue("");
    } catch (e) { setError(workspaceError(e)); }
  }
  async function cancel() {
    if (!loginId) return;
    try {
      await apiFetch(`/api/ai/official/login/${encodeURIComponent(loginId)}`, {
        method: "DELETE",
      });
    } catch (e) { setError(workspaceError(e)); }
    setLoginId("");
    setLogin(null);
    try { sessionStorage.removeItem(LOGIN_KEY); } catch { /* private mode */ }
  }
  async function logout() {
    if (!selected || !window.confirm(`退出 ${selected.name} 的官方授权？`)) return;
    try {
      await apiFetch(`/api/ai/official/providers/${selected.id}`, {
        method: "DELETE",
      });
      await refresh();
    } catch (e) { setError(workspaceError(e)); }
  }
  const event = login?.event;
  const authEvent = login?.authEvent;
  const authUrl = authEvent?.type === "auth_url" ? authEvent.url
    : authEvent?.type === "device_code" ? authEvent.verificationUri : "";
  const safeUrl = (() => {
    try { return new URL(authUrl).protocol === "https:" ? authUrl : ""; }
    catch { return ""; }
  })();
  return (
    <div className="ai-official">
      <strong>登录官方模型（pi 授权）</strong>
      <p>使用官方账号授权，不需要复制 API Key。授权信息仅加密保存在主控，不会发送给浏览器。订阅与 API 计费规则以提供商为准。</p>
      <label>提供商
        <select className="yaws-select w-full" value={providerId}
          disabled={!!loginId}
          onChange={(e) => { setProviderId(e.target.value); setModelId(""); setError(""); }}>
          {providers.map((provider) => (
            <option key={provider.id} value={provider.id}>
              {provider.name}{provider.connected ? " · 已登录" : ""}
            </option>
          ))}
        </select>
      </label>
      <div className="ai-settings-actions">
        <button type="button" className="yaws-btn tool-text" disabled={!selected || !!loginId}
          onClick={() => void start()}>{selected?.connected ? "重新登录" : "登录官方账号"}</button>
        {selected?.connected && !loginId ? <button type="button" className="yaws-btn tool-text"
          onClick={() => void logout()}>退出登录</button> : null}
        {loginId ? <button type="button" className="yaws-btn tool-text"
          onClick={() => void cancel()}>取消授权</button> : null}
      </div>
      {loginId && <div className="ai-official-flow" aria-live="polite">
        {authEvent?.type === "device_code" && <p>打开下方地址，在官方页面输入设备码：<strong>{authEvent.userCode}</strong></p>}
        {authEvent?.type === "auth_url" && <p>在官方页面完成授权。如果跳转到无法访问的 localhost，请复制浏览器地址栏的完整回调地址并粘贴在下方。</p>}
        {safeUrl && <a href={safeUrl} target="_blank" rel="noreferrer noopener">打开官方授权页面 ↗</a>}
        {event?.type === "prompt" && (
          event.options?.length ? <div className="ai-settings-actions">
            {event.options.map((option) => <button type="button" className="yaws-btn tool-text"
              key={option.id} onClick={() => void answer(option.id)}>{option.label}</button>)}
          </div> : <div className="ai-settings-actions">
            <input className="yaws-input" aria-label="授权回调或代码"
              type={event.secret ? "password" : "text"} value={value}
              placeholder={event.message} onChange={(e) => setValue(e.target.value)} />
            <button type="button" className="yaws-btn tool-text" disabled={!value.trim()}
              onClick={() => void answer(value.trim())}>提交</button>
          </div>
        )}
        {event?.type === "progress" || event?.type === "info" ? <p>{event.message}</p> : null}
        {!event && <p>正在等待官方授权…</p>}
      </div>}
      {error && <p role="alert" className="ai-profile-warn">{error}</p>}
      {selected?.connected && !loginId && <>
        <label>官方模型
          <select className="yaws-select w-full" value={modelId || selected.models[0]?.id || ""}
            onChange={(e) => setModelId(e.target.value)}>
            {selected.models.map((model) => <option key={model.id} value={model.id}>
              {model.name || model.id}（{model.id}）
            </option>)}
          </select>
        </label>
        <button type="button" className="yaws-btn tool-text" disabled={!selected.models.length}
          onClick={() => onAdd(selected, modelId || selected.models[0].id)}>
          添加到模型配置（然后保存）
        </button>
      </>}
    </div>
  );
}
