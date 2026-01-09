import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { apiFetch } from "./api";
import { setToken } from "./auth";

export function SettingsPage() {
  const nav = useNavigate();
  const [username, setUsername] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const canSubmit = useMemo(() => currentPassword.trim().length > 0, [currentPassword]);

  return (
    <div className="rounded-2xl border border-white/15 bg-white/10 p-4 backdrop-blur">
      <div className="mb-1 text-lg font-extrabold">账号设置</div>
      <div className="mb-4 text-xs text-white/60">修改用户名/密码后会自动更新登录 token。</div>

      {error ? <div className="mb-3 rounded-2xl border border-rose-400/40 bg-rose-500/10 p-3 text-sm">{error}</div> : null}
      {ok ? <div className="mb-3 rounded-2xl border border-emerald-400/30 bg-emerald-500/10 p-3 text-sm">{ok}</div> : null}

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <div>
          <div className="mb-1 text-xs text-white/60">新用户名（可选）</div>
          <input
            className="w-full rounded-xl border border-white/15 bg-white/10 px-3 py-2 outline-none focus:border-white/30"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="留空表示不修改"
          />
        </div>

        <div>
          <div className="mb-1 text-xs text-white/60">当前密码（必填）</div>
          <input
            className="w-full rounded-xl border border-white/15 bg-white/10 px-3 py-2 outline-none focus:border-white/30"
            type="password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
          />
        </div>

        <div className="md:col-span-2">
          <div className="mb-1 text-xs text-white/60">新密码（可选，至少 6 位）</div>
          <input
            className="w-full rounded-xl border border-white/15 bg-white/10 px-3 py-2 outline-none focus:border-white/30"
            type="password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            placeholder="留空表示不修改"
          />
        </div>
      </div>

      <div className="mt-4 flex items-center gap-2">
        <div className="flex-1" />
        <button
          className="rounded-xl border border-white/15 bg-white/10 px-3 py-2 text-sm hover:bg-white/15"
          onClick={() => nav(-1)}
        >
          返回
        </button>
        <button
          className="rounded-xl border border-sky-400/40 bg-sky-400/15 px-3 py-2 text-sm font-semibold hover:bg-sky-400/20 disabled:opacity-60"
          disabled={!canSubmit || loading}
          onClick={async () => {
            setLoading(true);
            setError(null);
            setOk(null);
            try {
              const res = await apiFetch<{ ok: true; token: string }>("/api/me/credentials", {
                method: "PUT",
                body: JSON.stringify({
                  username: username.trim() ? username.trim() : undefined,
                  currentPassword,
                  newPassword: newPassword.trim() ? newPassword.trim() : undefined,
                }),
              });
              setToken(res.token);
              setOk("已更新");
              setCurrentPassword("");
              setNewPassword("");
            } catch (e: any) {
              setError(
                e?.message === "invalid_credentials"
                  ? "当前密码不正确"
                  : e?.message === "username_taken"
                    ? "用户名已被占用"
                    : `更新失败：${e?.message ?? "unknown"}`
              );
            } finally {
              setLoading(false);
            }
          }}
        >
          {loading ? "保存中..." : "保存"}
        </button>
      </div>
    </div>
  );
}

