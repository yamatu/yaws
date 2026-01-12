import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { apiFetch, apiFetchBlob } from "./api";
import { getToken, setToken } from "./auth";

export function SettingsPage() {
  const nav = useNavigate();
  const [username, setUsername] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [backupLoading, setBackupLoading] = useState(false);
  const [restoreFile, setRestoreFile] = useState<File | null>(null);
  const [restoreLoading, setRestoreLoading] = useState(false);
  const [restoreProgress, setRestoreProgress] = useState<number>(0);
  const [restoreUploaded, setRestoreUploaded] = useState<number>(0);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const canSubmit = useMemo(() => currentPassword.trim().length > 0, [currentPassword]);

  return (
    <div className="grid gap-3">
      <div className="rounded-2xl border border-white/15 bg-white/10 p-4 backdrop-blur">
        <div className="mb-1 text-lg font-extrabold">账号设置</div>
        <div className="mb-4 text-xs text-white/60">修改用户名/密码后会自动更新登录 token。</div>

        {error ? (
          <div className="mb-3 rounded-2xl border border-rose-400/40 bg-rose-500/10 p-3 text-sm">{error}</div>
        ) : null}
        {ok ? (
          <div className="mb-3 rounded-2xl border border-emerald-400/30 bg-emerald-500/10 p-3 text-sm">{ok}</div>
        ) : null}

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

      <div className="rounded-2xl border border-white/15 bg-white/10 p-4 backdrop-blur">
        <div className="mb-1 text-lg font-extrabold">备份与恢复</div>
        <div className="mb-4 text-xs text-white/60">备份会导出 SQLite 文件；恢复后服务会自动重启。</div>

        <div className="grid gap-3 md:grid-cols-2">
          <div className="rounded-2xl border border-white/10 bg-black/20 p-3">
            <div className="mb-2 font-semibold">下载备份</div>
            <div className="mb-3 text-xs text-white/60">点击后会下载 `yaws-backup-*.sqlite`。</div>
            <button
              className="rounded-xl border border-sky-400/40 bg-sky-400/15 px-3 py-2 text-sm font-semibold hover:bg-sky-400/20 disabled:opacity-60"
              disabled={backupLoading}
              onClick={async () => {
                setBackupLoading(true);
                setError(null);
                setOk(null);
                try {
                  const { blob, filename } = await apiFetchBlob("/api/admin/backup");
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement("a");
                  a.href = url;
                  a.download = filename || "yaws-backup.sqlite";
                  document.body.appendChild(a);
                  a.click();
                  a.remove();
                  URL.revokeObjectURL(url);
                  setOk("已开始下载备份");
                } catch (e: any) {
                  setError(`下载失败：${e?.message ?? "unknown"}`);
                } finally {
                  setBackupLoading(false);
                }
              }}
            >
              {backupLoading ? "生成中..." : "下载备份"}
            </button>
          </div>

          <div className="rounded-2xl border border-white/10 bg-black/20 p-3">
            <div className="mb-2 font-semibold">恢复备份</div>
            <div className="mb-3 text-xs text-white/60">上传 `.sqlite` 备份文件恢复数据。</div>
            <input
              className="mb-3 w-full rounded-xl border border-white/15 bg-white/10 px-3 py-2 text-sm outline-none focus:border-white/30"
              type="file"
              accept=".sqlite,application/x-sqlite3,application/octet-stream"
              onChange={(e) => setRestoreFile(e.target.files?.[0] ?? null)}
            />
            {restoreLoading ? (
              <div className="mb-3">
                <div className="mb-1 flex items-center justify-between text-xs text-white/60">
                  <div>上传进度</div>
                  <div>
                    {Math.min(100, Math.max(0, Math.round(restoreProgress)))}% ·{" "}
                    {restoreUploaded > 0 ? `${(restoreUploaded / 1024 / 1024).toFixed(1)} MB` : "—"}
                  </div>
                </div>
                <div className="h-2 overflow-hidden rounded-full border border-white/10 bg-black/30">
                  <div
                    className="h-full bg-sky-400/70 transition-all"
                    style={{ width: `${Math.min(100, Math.max(0, restoreProgress))}%` }}
                  />
                </div>
              </div>
            ) : null}
            <button
              className="rounded-xl border border-rose-400/40 bg-rose-500/15 px-3 py-2 text-sm font-semibold hover:bg-rose-500/20 disabled:opacity-60"
              disabled={!restoreFile || restoreLoading}
              onClick={async () => {
                if (!restoreFile) return;
                if (!confirm("确认恢复备份？恢复会覆盖当前数据，并导致服务重启。")) return;
                setRestoreLoading(true);
                setRestoreProgress(0);
                setRestoreUploaded(0);
                setError(null);
                setOk(null);

                try {
                  const token = getToken();
                  if (!token) throw new Error("missing_token");

                  const res = await new Promise<{ status: number; bodyText: string }>((resolve, reject) => {
                    const xhr = new XMLHttpRequest();
                    xhr.open("POST", "/api/admin/restore", true);
                    xhr.setRequestHeader("authorization", `Bearer ${token}`);
                    xhr.setRequestHeader("content-type", "application/octet-stream");
                    xhr.upload.onprogress = (ev) => {
                      const total = ev.total || restoreFile.size || 0;
                      const loaded = ev.loaded || 0;
                      setRestoreUploaded(loaded);
                      if (total > 0) setRestoreProgress((loaded / total) * 100);
                    };
                    xhr.onerror = () => reject(new Error("network_error"));
                    xhr.onabort = () => reject(new Error("aborted"));
                    xhr.onload = () => resolve({ status: xhr.status, bodyText: xhr.responseText || "" });
                    xhr.send(restoreFile);
                  });

                  if (res.status >= 200 && res.status < 300) {
                    setRestoreProgress(100);
                    setOk("恢复成功，服务重启中...");
                    setTimeout(() => window.location.reload(), 2500);
                    return;
                  }

                  let errCode = `http_${res.status}`;
                  try {
                    const j = JSON.parse(res.bodyText || "{}");
                    if (j?.error) errCode = String(j.error);
                  } catch {
                    // ignore (nginx 413 may return HTML)
                  }

                  if (res.status === 413 || errCode === "file_too_large") {
                    throw new Error("file_too_large");
                  }
                  throw new Error(errCode);
                } catch (e: any) {
                  setError(
                    e?.message === "file_too_large"
                      ? "恢复失败：文件太大（可能是 Nginx client_max_body_size 或后端 ADMIN_RESTORE_MAX_MB 限制）"
                      : `恢复失败：${e?.message ?? "unknown"}`
                  );
                } finally {
                  setRestoreLoading(false);
                }
              }}
            >
              {restoreLoading ? "恢复中..." : "恢复备份"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
