import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { apiFetch, apiFetchBlob } from "./api";
import { getToken, setToken } from "./auth";

type TelegramSettings = {
  enabled: boolean;
  botTokenMasked: string;
  chatId: string;
  offlineAfterMin: number;
  expiryWarnDays: number;
  notifyOffline: boolean;
  notifyOnline: boolean;
  notifyExpiry: boolean;
  configured: boolean;
};

export function SettingsPage() {
  const nav = useNavigate();
  const [username, setUsername] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [backupLoading, setBackupLoading] = useState(false);
  const [backupGzip, setBackupGzip] = useState(true);
  const [restoreFile, setRestoreFile] = useState<File | null>(null);
  const [restoreLoading, setRestoreLoading] = useState(false);
  const [restoreProgress, setRestoreProgress] = useState<number>(0);
  const [restoreUploaded, setRestoreUploaded] = useState<number>(0);
  const [restoreAttempted, setRestoreAttempted] = useState(false);
  const [tgLoading, setTgLoading] = useState(false);
  const [tgSaving, setTgSaving] = useState(false);
  const [tgTesting, setTgTesting] = useState(false);
  const [tgError, setTgError] = useState<string | null>(null);
  const [tgOk, setTgOk] = useState<string | null>(null);
  const [tgEnabled, setTgEnabled] = useState(false);
  const [tgBotTokenMasked, setTgBotTokenMasked] = useState("");
  const [tgBotToken, setTgBotToken] = useState("");
  const [tgBotTokenDirty, setTgBotTokenDirty] = useState(false);
  const [tgChatId, setTgChatId] = useState("");
  const [tgOfflineAfterMin, setTgOfflineAfterMin] = useState<number>(5);
  const [tgExpiryWarnDays, setTgExpiryWarnDays] = useState<number>(10);
  const [tgNotifyOffline, setTgNotifyOffline] = useState(true);
  const [tgNotifyOnline, setTgNotifyOnline] = useState(true);
  const [tgNotifyExpiry, setTgNotifyExpiry] = useState(true);
  const [tgConfigured, setTgConfigured] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const canSubmit = useMemo(() => currentPassword.trim().length > 0, [currentPassword]);

  useEffect(() => {
    let cancelled = false;
    setTgLoading(true);
    setTgError(null);
    apiFetch<TelegramSettings>("/api/admin/telegram/settings")
      .then((s) => {
        if (cancelled) return;
        setTgEnabled(!!s.enabled);
        setTgBotTokenMasked(s.botTokenMasked || "");
        setTgChatId(s.chatId || "");
        setTgOfflineAfterMin(Number.isFinite(s.offlineAfterMin) ? s.offlineAfterMin : 5);
        setTgExpiryWarnDays(Number.isFinite(s.expiryWarnDays) ? s.expiryWarnDays : 10);
        setTgNotifyOffline(!!s.notifyOffline);
        setTgNotifyOnline(!!s.notifyOnline);
        setTgNotifyExpiry(!!s.notifyExpiry);
        setTgConfigured(!!s.configured);
      })
      .catch((e: any) => {
        if (cancelled) return;
        setTgError(`加载失败：${e?.message ?? "unknown"}`);
      })
      .finally(() => {
        if (cancelled) return;
        setTgLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

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
            <div className="mb-3 text-xs text-white/60">点击后会下载 `yaws-backup-*.sqlite`（建议用压缩版更小）。</div>
            <label className="mb-3 flex select-none items-center gap-2 text-xs text-white/70">
              <input
                type="checkbox"
                checked={backupGzip}
                onChange={(e) => setBackupGzip(e.target.checked)}
              />
              下载压缩备份（.sqlite.gz）
            </label>
            <button
              className="rounded-xl border border-sky-400/40 bg-sky-400/15 px-3 py-2 text-sm font-semibold hover:bg-sky-400/20 disabled:opacity-60"
              disabled={backupLoading}
              onClick={async () => {
                setBackupLoading(true);
                setError(null);
                setOk(null);
                try {
                  const { blob, filename } = await apiFetchBlob(`/api/admin/backup${backupGzip ? "?gzip=1" : ""}`);
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
            <div className="mb-3 text-xs text-white/60">
              上传 `.sqlite` 或 `.sqlite.gz` 备份文件恢复数据（大文件建议先用压缩版）。
            </div>
            <input
              className="mb-3 w-full rounded-xl border border-white/15 bg-white/10 px-3 py-2 text-sm outline-none focus:border-white/30"
              type="file"
              accept=".sqlite,.gz,.sqlite.gz,application/x-sqlite3,application/gzip,application/octet-stream"
              onChange={(e) => {
                setRestoreFile(e.target.files?.[0] ?? null);
                setRestoreProgress(0);
                setRestoreUploaded(0);
                setRestoreAttempted(false);
              }}
            />
            {restoreFile ? (
              <div className="mb-3 text-xs text-white/60">
                已选择：{restoreFile.name}（{(restoreFile.size / 1024 / 1024).toFixed(1)} MB）
              </div>
            ) : null}
            {restoreLoading || restoreAttempted ? (
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
                setRestoreAttempted(true);
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
                      ? "恢复失败：文件太大（可能是 Nginx client_max_body_size / 后端 ADMIN_RESTORE_MAX_MB / Cloudflare 100MB 限制；建议用 .sqlite.gz）"
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

      <div className="rounded-2xl border border-white/15 bg-white/10 p-4 backdrop-blur">
        <div className="mb-1 flex items-center justify-between gap-2">
          <div className="text-lg font-extrabold">Telegram 通知</div>
          <div
            className={`rounded-full border px-2 py-0.5 text-xs ${
              tgConfigured ? "border-emerald-400/30 bg-emerald-500/10 text-emerald-100" : "border-white/15 bg-white/10 text-white/70"
            }`}
          >
            {tgConfigured ? "已配置" : "未配置"}
          </div>
        </div>
        <div className="mb-4 text-xs text-white/60">
          用于机器离线/恢复在线/到期提醒。你也可以只用环境变量配置（Docker compose 里写 TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID）。
        </div>

        {tgError ? (
          <div className="mb-3 rounded-2xl border border-rose-400/40 bg-rose-500/10 p-3 text-sm">{tgError}</div>
        ) : null}
        {tgOk ? (
          <div className="mb-3 rounded-2xl border border-emerald-400/30 bg-emerald-500/10 p-3 text-sm">{tgOk}</div>
        ) : null}

        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <label className="flex select-none items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={tgEnabled}
              onChange={(e) => setTgEnabled(e.target.checked)}
              disabled={tgLoading}
            />
            启用 Telegram 通知
          </label>
          <div className="text-right text-xs text-white/50 md:pt-1">
            {tgBotTokenMasked ? `Bot token：${tgBotTokenMasked}` : "Bot token：—"}
          </div>

          <div>
            <div className="mb-1 text-xs text-white/60">Bot Token（可选，留空表示不修改）</div>
            <div className="flex gap-2">
              <input
                className="w-full rounded-xl border border-white/15 bg-white/10 px-3 py-2 outline-none focus:border-white/30"
                type="password"
                value={tgBotToken}
                onChange={(e) => {
                  setTgBotToken(e.target.value);
                  setTgBotTokenDirty(true);
                }}
                placeholder={tgBotTokenMasked ? "已设置（留空不修改）" : "123456:ABC..."}
                disabled={tgLoading}
              />
              <button
                className="shrink-0 rounded-xl border border-white/15 bg-white/10 px-3 py-2 text-sm hover:bg-white/15 disabled:opacity-60"
                disabled={tgLoading}
                onClick={() => {
                  setTgBotToken("");
                  setTgBotTokenDirty(true);
                }}
                type="button"
                title="清除数据库里保存的 token（若你使用了环境变量，仍可能继续生效）"
              >
                清除
              </button>
            </div>
          </div>

          <div>
            <div className="mb-1 text-xs text-white/60">Chat ID（必填）</div>
            <input
              className="w-full rounded-xl border border-white/15 bg-white/10 px-3 py-2 outline-none focus:border-white/30"
              value={tgChatId}
              onChange={(e) => setTgChatId(e.target.value)}
              placeholder="例如：123456789 或 -100xxxxxxxxxx"
              disabled={tgLoading}
            />
          </div>

          <div>
            <div className="mb-1 text-xs text-white/60">离线判定（分钟）</div>
            <input
              className="w-full rounded-xl border border-white/15 bg-white/10 px-3 py-2 outline-none focus:border-white/30"
              type="number"
              min={1}
              max={1440}
              value={tgOfflineAfterMin}
              onChange={(e) => setTgOfflineAfterMin(Number(e.target.value || 0))}
              disabled={tgLoading}
            />
          </div>

          <div>
            <div className="mb-1 text-xs text-white/60">到期提前提醒（天）</div>
            <input
              className="w-full rounded-xl border border-white/15 bg-white/10 px-3 py-2 outline-none focus:border-white/30"
              type="number"
              min={0}
              max={3650}
              value={tgExpiryWarnDays}
              onChange={(e) => setTgExpiryWarnDays(Number(e.target.value || 0))}
              disabled={tgLoading}
            />
          </div>

          <div className="md:col-span-2 grid grid-cols-1 gap-2 md:grid-cols-3">
            <label className="flex select-none items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={tgNotifyOffline}
                onChange={(e) => setTgNotifyOffline(e.target.checked)}
                disabled={tgLoading}
              />
              通知离线
            </label>
            <label className="flex select-none items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={tgNotifyOnline}
                onChange={(e) => setTgNotifyOnline(e.target.checked)}
                disabled={tgLoading}
              />
              通知恢复在线
            </label>
            <label className="flex select-none items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={tgNotifyExpiry}
                onChange={(e) => setTgNotifyExpiry(e.target.checked)}
                disabled={tgLoading}
              />
              通知到期
            </label>
          </div>
        </div>

        <div className="mt-4 flex items-center gap-2">
          <div className="flex-1" />
          <button
            className="rounded-xl border border-white/15 bg-white/10 px-3 py-2 text-sm hover:bg-white/15 disabled:opacity-60"
            disabled={tgTesting || tgSaving || tgLoading}
            onClick={async () => {
              setTgTesting(true);
              setTgError(null);
              setTgOk(null);
              try {
                await apiFetch<{ ok: true }>("/api/admin/telegram/test", { method: "POST", body: JSON.stringify({}) });
                setTgOk("已发送测试消息");
              } catch (e: any) {
                setTgError(e?.message === "telegram_not_configured" ? "请先配置 Bot Token + Chat ID" : `发送失败：${e?.message ?? "unknown"}`);
              } finally {
                setTgTesting(false);
              }
            }}
          >
            {tgTesting ? "发送中..." : "发送测试"}
          </button>
          <button
            className="rounded-xl border border-sky-400/40 bg-sky-400/15 px-3 py-2 text-sm font-semibold hover:bg-sky-400/20 disabled:opacity-60"
            disabled={tgSaving || tgLoading}
            onClick={async () => {
              setTgSaving(true);
              setTgError(null);
              setTgOk(null);
              try {
                const payload: any = {
                  enabled: tgEnabled,
                  chatId: tgChatId,
                  offlineAfterMin: tgOfflineAfterMin,
                  expiryWarnDays: tgExpiryWarnDays,
                  notifyOffline: tgNotifyOffline,
                  notifyOnline: tgNotifyOnline,
                  notifyExpiry: tgNotifyExpiry,
                };
                if (tgBotTokenDirty) payload.botToken = tgBotToken;
                await apiFetch<{ ok: true }>("/api/admin/telegram/settings", {
                  method: "PUT",
                  body: JSON.stringify({ ...payload }),
                });
                const s = await apiFetch<TelegramSettings>("/api/admin/telegram/settings");
                setTgEnabled(!!s.enabled);
                setTgBotTokenMasked(s.botTokenMasked || "");
                setTgChatId(s.chatId || "");
                setTgOfflineAfterMin(Number.isFinite(s.offlineAfterMin) ? s.offlineAfterMin : 5);
                setTgExpiryWarnDays(Number.isFinite(s.expiryWarnDays) ? s.expiryWarnDays : 10);
                setTgNotifyOffline(!!s.notifyOffline);
                setTgNotifyOnline(!!s.notifyOnline);
                setTgNotifyExpiry(!!s.notifyExpiry);
                setTgConfigured(!!s.configured);
                setTgBotToken("");
                setTgBotTokenDirty(false);
                setTgOk("已保存");
              } catch (e: any) {
                setTgError(`保存失败：${e?.message ?? "unknown"}`);
              } finally {
                setTgSaving(false);
              }
            }}
          >
            {tgSaving ? "保存中..." : "保存"}
          </button>
        </div>
      </div>
    </div>
  );
}
