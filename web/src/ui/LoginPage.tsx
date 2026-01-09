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
      <div className="mx-auto mt-20 max-w-md rounded-2xl border border-white/15 bg-white/10 p-5 backdrop-blur">
        <div className="mb-1 text-xl font-extrabold">登录</div>
        <div className="mb-4 text-sm text-white/60">使用管理员账号密码登录</div>

        <div className="grid gap-3">
          <div>
            <div className="mb-1 text-xs text-white/60">用户名</div>
            <input
              className="w-full rounded-xl border border-white/15 bg-white/10 px-3 py-2 outline-none focus:border-white/30"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="请输入用户名"
            />
          </div>
          <div>
            <div className="mb-1 text-xs text-white/60">密码</div>
            <input
              className="w-full rounded-xl border border-white/15 bg-white/10 px-3 py-2 outline-none focus:border-white/30"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="请输入密码"
            />
          </div>

          {error ? (
            <div className="rounded-2xl border border-rose-400/40 bg-rose-500/10 p-3 text-sm">{error}</div>
          ) : null}

          <button
            className="rounded-xl border border-sky-400/40 bg-sky-400/15 px-3 py-2 text-sm font-semibold hover:bg-sky-400/20 disabled:opacity-60"
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

          <div className="text-xs text-white/60">
            首次使用请先调用 <code>/api/auth/bootstrap</code> 创建管理员账号。
          </div>
        </div>
      </div>
    </div>
  );
}
