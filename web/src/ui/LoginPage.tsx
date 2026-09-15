import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { apiFetch } from "./api";
import {
  rememberedUsername,
  rememberUsername,
  rememberPersist,
  setRememberPersist,
  setToken,
} from "./auth";
import { useDocumentTitle } from "./documentTitle";
import { safeNext } from "./session";

export function LoginPage() {
  const nav = useNavigate();
  const [params] = useSearchParams();
  const cachedUser = rememberedUsername();
  const [username, setUsername] = useState(cachedUser);
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(() => rememberPersist());
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const passwordRef = useRef<HTMLInputElement | null>(null);
  const expired = params.get("expired") === "1";
  const next = safeNext(params.get("next"));

  useDocumentTitle("登录");

  // A remembered username means only the password is left to type.
  useEffect(() => {
    if (cachedUser) passwordRef.current?.focus();
  }, [cachedUser]);

  const canSubmit = useMemo(() => username.trim() && password.trim(), [username, password]);

  const submit = async () => {
    if (loading || !username.trim() || !password.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch<{ token: string }>("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ username, password }),
      });
      setToken(res.token, remember);
      rememberUsername(username, remember);
      setRememberPersist(remember);
      nav(next ?? "/app", { replace: true });
    } catch (e: any) {
      const message =
        e?.message === "invalid_credentials"
          ? "账号或密码错误"
          : e?.message === "too_many_attempts"
            ? "登录尝试过多，请稍后再试"
            : `登录失败：${e?.message ?? "unknown"}`;
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="mx-auto max-w-6xl px-5 py-5">
      <div className="mx-auto mt-24 max-w-md animate-slide-up">
        <div className="yaws-card p-6">
          <div className="mb-1 text-xl font-extrabold tracking-wide">登录</div>
          <div className="mb-5 text-sm text-white/40">使用管理员账号密码登录</div>

          <div className="grid gap-4">
            {expired ? (
              <div className="yaws-alert-error" role="status">
                登录状态已过期，请重新登录。
              </div>
            ) : null}

            <div>
              <div className="mb-1.5 text-xs font-medium text-white/50">用户名</div>
              <input
                className="yaws-input"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="请输入用户名"
                autoComplete="username"
              />
            </div>
            <div>
              <div className="mb-1.5 text-xs font-medium text-white/50">密码</div>
              <input
                className="yaws-input"
                ref={passwordRef}
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="请输入密码"
                autoComplete="current-password"
                onKeyDown={(e) => {
                  if (e.key === "Enter") void submit();
                }}
              />
            </div>

            <label className="flex cursor-pointer items-center gap-2.5 text-sm text-white/60">
              <input
                type="checkbox"
                className="h-4 w-4 accent-sky-500"
                checked={remember}
                onChange={(e) => setRemember(e.target.checked)}
              />
              <span>
                记住我
                <span className="ml-1.5 text-xs text-white/35">
                  （勾选后关闭浏览器仍保持登录，7 天有效）
                </span>
              </span>
            </label>

            {error ? <div className="yaws-alert-error">{error}</div> : null}

            <button
              className="yaws-btn-primary mt-1 py-2.5"
              disabled={!canSubmit || loading}
              onClick={() => void submit()}
            >
              {loading ? "登录中..." : "登录"}
            </button>

            <div className="text-xs text-white/35">
              首次使用请先调用 <code className="text-white/50">/api/auth/bootstrap</code> 创建管理员账号。
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
