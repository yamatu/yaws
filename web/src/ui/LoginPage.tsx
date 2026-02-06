import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { apiFetch } from "./api";
import { setToken } from "./auth";

export function LoginPage() {
  const nav = useNavigate();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const canSubmit = useMemo(() => username.trim() && password.trim(), [username, password]);

  return (
    <div className="mx-auto max-w-6xl px-5 py-5">
      <div className="mx-auto mt-24 max-w-md animate-slide-up">
        <div className="yaws-card p-6">
          <div className="mb-1 text-xl font-extrabold tracking-wide">登录</div>
          <div className="mb-5 text-sm text-white/40">使用管理员账号密码登录</div>

          <div className="grid gap-4">
            <div>
              <div className="mb-1.5 text-xs font-medium text-white/50">用户名</div>
              <input
                className="yaws-input"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="请输入用户名"
              />
            </div>
            <div>
              <div className="mb-1.5 text-xs font-medium text-white/50">密码</div>
              <input
                className="yaws-input"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="请输入密码"
              />
            </div>

            {error ? <div className="yaws-alert-error">{error}</div> : null}

            <button
              className="yaws-btn-primary mt-1 py-2.5"
              disabled={!canSubmit || loading}
              onClick={async () => {
                setLoading(true);
                setError(null);
                try {
                  const res = await apiFetch<{ token: string }>("/api/auth/login", {
                    method: "POST",
                    body: JSON.stringify({ username, password }),
                  });
                  setToken(res.token);
                  nav("/app", { replace: true });
                } catch (e: any) {
                  setError(e?.message === "invalid_credentials" ? "账号或密码错误" : `登录失败：${e?.message ?? "unknown"}`);
                } finally {
                  setLoading(false);
                }
              }}
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
