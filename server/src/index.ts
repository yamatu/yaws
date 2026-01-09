import express, { type Request } from "express";
import cors from "cors";
import path from "node:path";
import fs from "node:fs";
import http from "node:http";
import crypto from "node:crypto";
import { loadEnv } from "./env.js";
import { openDb } from "./db.js";
import { authMiddleware } from "./http.js";
import { hashPassword, signToken, verifyPassword } from "./auth.js";
import { attachWebSockets } from "./ws.js";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { decryptText, encryptText } from "./crypto.js";

const env = loadEnv();
const db = openDb(env.DATABASE_PATH);
const agentKeySecret = env.AGENT_KEY_SECRET ?? env.JWT_SECRET;
const agentReleaseBaseUrl =
  env.AGENT_RELEASE_BASE_URL?.trim() || `https://github.com/${env.AGENT_GITHUB_REPO}/releases/latest/download`;

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(
  cors({
    origin: env.CORS_ORIGIN,
    credentials: false,
  })
);

app.get("/health", (_req, res) => res.json({ ok: true }));

app.get("/api/public/summary", (_req, res) => {
  const rows = db
    .prepare(
      `SELECT
         m.id, m.name, m.online, m.last_seen_at as lastSeenAt,
         x.at as metricAt,
         x.cpu_usage as cpuUsage,
         x.mem_used as memUsed, x.mem_total as memTotal,
         x.disk_used as diskUsed, x.disk_total as diskTotal,
         x.net_rx_bytes as netRxBytes, x.net_tx_bytes as netTxBytes,
         x.load_1 as load1, x.load_5 as load5, x.load_15 as load15
       FROM machines m
       LEFT JOIN metrics x ON x.id = (
         SELECT id FROM metrics WHERE machine_id = m.id ORDER BY at DESC LIMIT 1
       )
       ORDER BY m.id DESC`
    )
    .all();

  res.json({
    machines: rows.map((r: any) => ({
      id: r.id,
      name: r.name,
      online: r.online,
      lastSeenAt: r.lastSeenAt ?? null,
      latestMetric: r.metricAt
        ? {
            at: r.metricAt,
            cpuUsage: r.cpuUsage,
            memUsed: r.memUsed,
            memTotal: r.memTotal,
            diskUsed: r.diskUsed,
            diskTotal: r.diskTotal,
            netRxBytes: r.netRxBytes,
            netTxBytes: r.netTxBytes,
            load1: r.load1,
            load5: r.load5,
            load15: r.load15,
          }
        : null,
    })),
  });
});

app.post("/api/auth/bootstrap", async (req, res) => {
  const body = BootstrapSchema.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: "bad_request" });

  const count = db.prepare("SELECT COUNT(*) as c FROM users").get() as { c: number };
  if (count.c > 0) return res.status(409).json({ error: "already_bootstrapped" });

  const passwordHash = await hashPassword(body.data.password);
  const now = Date.now();
  const info = db
    .prepare("INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, 'admin', ?)")
    .run(body.data.username, passwordHash, now);

  return res.json({ ok: true, userId: Number(info.lastInsertRowid) });
});

app.post("/api/auth/login", async (req, res) => {
  const body = LoginSchema.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: "bad_request" });

  const row = db
    .prepare("SELECT id, username, password_hash, role FROM users WHERE username = ?")
    .get(body.data.username) as { id: number; username: string; password_hash: string; role: string } | undefined;
  if (!row) return res.status(401).json({ error: "invalid_credentials" });

  const ok = await verifyPassword(body.data.password, row.password_hash);
  if (!ok) return res.status(401).json({ error: "invalid_credentials" });

  const token = signToken({ id: row.id, username: row.username, role: row.role }, env.JWT_SECRET);
  return res.json({ token });
});

const requireAuth = authMiddleware(env.JWT_SECRET);

app.get("/api/me", requireAuth, (req, res) => {
  return res.json({ user: (req as any).user });
});

app.put("/api/me/credentials", requireAuth, async (req, res) => {
  const body = MeCredentialsSchema.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: "bad_request" });

  const user = (req as any).user as { id: number; username: string; role: string };
  const row = db
    .prepare("SELECT id, username, password_hash, role FROM users WHERE id = ?")
    .get(user.id) as { id: number; username: string; password_hash: string; role: string } | undefined;
  if (!row) return res.status(404).json({ error: "not_found" });

  const ok = await verifyPassword(body.data.currentPassword, row.password_hash);
  if (!ok) return res.status(401).json({ error: "invalid_credentials" });

  const newUsername = body.data.username?.trim() || row.username;
  const newPasswordHash = body.data.newPassword ? await hashPassword(body.data.newPassword) : row.password_hash;
  try {
    db.prepare("UPDATE users SET username = ?, password_hash = ? WHERE id = ?").run(newUsername, newPasswordHash, row.id);
  } catch {
    return res.status(409).json({ error: "username_taken" });
  }

  const token = signToken({ id: row.id, username: newUsername, role: row.role }, env.JWT_SECRET);
  return res.json({ ok: true, token, user: { id: row.id, username: newUsername, role: row.role } });
});

app.get("/api/machines", requireAuth, (_req, res) => {
  const rows = db
    .prepare(
      `SELECT
        id, name, notes,
        interval_sec as intervalSec,
        agent_ws_url as agentWsUrl,
        expires_at as expiresAt,
        purchase_amount_cents as purchaseAmountCents,
        billing_cycle as billingCycle,
        auto_renew as autoRenew,
        created_at as createdAt, updated_at as updatedAt,
        last_seen_at as lastSeenAt, online
      FROM machines ORDER BY id DESC`
    )
    .all();
  res.json({ machines: rows });
});

app.post("/api/machines", requireAuth, async (req, res) => {
  const body = MachineCreateSchema.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: "bad_request" });
  const now = Date.now();
  const agentKey = body.data.agentKey ?? randomAgentKey();
  const agentKeyHash = await bcrypt.hash(agentKey, 12);
  const agentKeyEnc = encryptText(agentKey, agentKeySecret);
  const info = db
    .prepare(
      `INSERT INTO machines (
         name, notes, interval_sec,
         agent_key_hash, agent_key_enc, agent_ws_url,
         expires_at, purchase_amount_cents, billing_cycle, auto_renew,
         created_at, updated_at, online
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
    )
    .run(
      body.data.name,
      body.data.notes ?? "",
      body.data.intervalSec,
      agentKeyHash,
      agentKeyEnc,
      body.data.agentWsUrl ?? "",
      body.data.expiresAt ?? null,
      Math.max(0, Math.round((body.data.purchaseAmount ?? 0) * 100)),
      body.data.billingCycle ?? "month",
      body.data.autoRenew ? 1 : 0,
      now,
      now
    );
  res.json({ ok: true, id: Number(info.lastInsertRowid), agentKey });
});

app.put("/api/machines/:id", requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "bad_id" });
  const body = MachineUpdateSchema.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: "bad_request" });

  const machine = db.prepare("SELECT id FROM machines WHERE id = ?").get(id) as { id: number } | undefined;
  if (!machine) return res.status(404).json({ error: "not_found" });

  const now = Date.now();
  const hasExpiresAt = Object.prototype.hasOwnProperty.call(req.body ?? {}, "expiresAt");
  const keyHash = body.data.agentKey ? await bcrypt.hash(body.data.agentKey, 12) : null;
  const keyEnc = body.data.agentKey ? encryptText(body.data.agentKey, agentKeySecret) : null;
  db.prepare(
    `UPDATE machines
     SET name = COALESCE(?, name),
         notes = COALESCE(?, notes),
         interval_sec = COALESCE(?, interval_sec),
         agent_key_hash = COALESCE(?, agent_key_hash),
         agent_key_enc = COALESCE(?, agent_key_enc),
         agent_ws_url = COALESCE(?, agent_ws_url),
         expires_at = CASE WHEN ? THEN ? ELSE expires_at END,
         purchase_amount_cents = COALESCE(?, purchase_amount_cents),
         billing_cycle = COALESCE(?, billing_cycle),
         auto_renew = COALESCE(?, auto_renew),
         updated_at = ?
     WHERE id = ?`
  ).run(
    body.data.name ?? null,
    body.data.notes ?? null,
    body.data.intervalSec ?? null,
    keyHash,
    keyEnc,
    body.data.agentWsUrl ?? null,
    hasExpiresAt ? 1 : 0,
    body.data.expiresAt ?? null,
    body.data.purchaseAmount != null ? Math.max(0, Math.round(body.data.purchaseAmount * 100)) : null,
    body.data.billingCycle ?? null,
    body.data.autoRenew != null ? (body.data.autoRenew ? 1 : 0) : null,
    now,
    id
  );
  res.json({ ok: true });
});

app.delete("/api/machines/:id", requireAuth, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "bad_id" });
  const info = db.prepare("DELETE FROM machines WHERE id = ?").run(id);
  if (info.changes === 0) return res.status(404).json({ error: "not_found" });
  res.json({ ok: true });
});

app.get("/api/machines/:id/agent-config", requireAuth, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "bad_id" });
  const row = db
    .prepare("SELECT id, agent_key_enc, agent_ws_url FROM machines WHERE id = ?")
    .get(id) as { id: number; agent_key_enc: string; agent_ws_url: string } | undefined;
  if (!row) return res.status(404).json({ error: "not_found" });

  const wsUrl = row.agent_ws_url || inferAgentWsUrl(req);
  if (!row.agent_key_enc) return res.status(409).json({ error: "no_key" });
  const key = decryptText(row.agent_key_enc, agentKeySecret);

  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("content-disposition", `attachment; filename="yaws-agent-${id}.json"`);
  res.end(JSON.stringify({ url: wsUrl, id, key, disk: "/" }, null, 2));
});

app.post("/api/machines/:id/reset-key", requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "bad_id" });
  const machine = db.prepare("SELECT id FROM machines WHERE id = ?").get(id) as { id: number } | undefined;
  if (!machine) return res.status(404).json({ error: "not_found" });
  const agentKey = randomAgentKey();
  const agentKeyHash = await bcrypt.hash(agentKey, 12);
  const agentKeyEnc = encryptText(agentKey, agentKeySecret);
  db.prepare("UPDATE machines SET agent_key_hash = ?, agent_key_enc = ?, updated_at = ? WHERE id = ?").run(
    agentKeyHash,
    agentKeyEnc,
    Date.now(),
    id
  );
  res.json({ ok: true, agentKey });
});

app.post("/api/machines/:id/renew", requireAuth, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "bad_id" });
  const body = RenewSchema.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: "bad_request" });
  const row = db.prepare("SELECT expires_at as expiresAt FROM machines WHERE id = ?").get(id) as
    | { expiresAt: number | null }
    | undefined;
  if (!row) return res.status(404).json({ error: "not_found" });

  const base = Math.max(Date.now(), row.expiresAt ?? 0);
  const next = addCycle(base, body.data.cycle, body.data.count);
  db.prepare("UPDATE machines SET expires_at = ?, updated_at = ? WHERE id = ?").run(next, Date.now(), id);
  res.json({ ok: true, expiresAt: next });
});

app.get("/api/machines/:id/setup", requireAuth, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "bad_id" });
  const row = db
    .prepare("SELECT id, agent_key_enc, agent_ws_url FROM machines WHERE id = ?")
    .get(id) as { id: number; agent_key_enc: string; agent_ws_url: string } | undefined;
  if (!row) return res.status(404).json({ error: "not_found" });
  const wsUrl = row.agent_ws_url || inferAgentWsUrl(req);
  const key = row.agent_key_enc ? decryptText(row.agent_key_enc, agentKeySecret) : null;
  res.json({
    machineId: id,
    wsUrl,
    agentKey: key,
    downloadConfigUrl: `/api/machines/${id}/agent-config`,
  });
});

app.get("/api/machines/:id/install-script", requireAuth, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "bad_id" });
  const row = db
    .prepare("SELECT id, interval_sec, agent_key_enc, agent_ws_url FROM machines WHERE id = ?")
    .get(id) as { id: number; interval_sec: number; agent_key_enc: string; agent_ws_url: string } | undefined;
  if (!row) return res.status(404).json({ error: "not_found" });
  if (!row.agent_key_enc) return res.status(409).json({ error: "no_key" });

  const wsUrl = row.agent_ws_url || inferAgentWsUrl(req);
  const key = decryptText(row.agent_key_enc, agentKeySecret);
  const intervalSec = row.interval_sec;

  const script = renderInstallScript({
    machineId: id,
    wsUrl,
    key,
    intervalSec,
    releaseBaseUrl: agentReleaseBaseUrl,
  });

  res.setHeader("content-type", "text/plain; charset=utf-8");
  res.end(script);
});

app.get("/api/machines/:id/metrics", requireAuth, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "bad_id" });
  const limit = Math.max(1, Math.min(2000, Number(req.query.limit ?? 200)));
  const rows = db
    .prepare(
      `SELECT
         at,
         cpu_usage as cpuUsage,
         mem_used as memUsed, mem_total as memTotal,
         disk_used as diskUsed, disk_total as diskTotal,
         net_rx_bytes as netRxBytes, net_tx_bytes as netTxBytes,
         load_1 as load1, load_5 as load5, load_15 as load15
       FROM metrics WHERE machine_id = ? ORDER BY at DESC LIMIT ?`
    )
    .all(id, limit);
  res.json({ metrics: rows.reverse() });
});

const webDist = path.resolve(process.cwd(), "../web/dist");
if (fs.existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get("*", (req, res) => res.sendFile(path.join(webDist, "index.html")));
}

const server = http.createServer(app);
attachWebSockets({ server, db, jwtSecret: env.JWT_SECRET });

server.listen(env.PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`yaws server listening on http://localhost:${env.PORT}`);
});

startMetricsPruner();

const BootstrapSchema = z.object({ username: z.string().min(1), password: z.string().min(6) });
const LoginSchema = z.object({ username: z.string().min(1), password: z.string().min(1) });
const MachineCreateSchema = z.object({
  name: z.string().min(1),
  notes: z.string().optional(),
  intervalSec: z.number().int().min(2).max(3600).default(5),
  agentKey: z.string().min(8).optional(),
  agentWsUrl: z.string().optional(),
  expiresAt: z.number().int().nullable().optional(),
  purchaseAmount: z.number().nonnegative().optional(),
  billingCycle: z.enum(["month", "quarter", "year"]).optional(),
  autoRenew: z.boolean().optional(),
});
const MachineUpdateSchema = z.object({
  name: z.string().min(1).optional(),
  notes: z.string().optional(),
  intervalSec: z.number().int().min(2).max(3600).optional(),
  agentKey: z.string().min(8).optional(),
  agentWsUrl: z.string().optional(),
  expiresAt: z.number().int().nullable().optional(),
  purchaseAmount: z.number().nonnegative().optional(),
  billingCycle: z.enum(["month", "quarter", "year"]).optional(),
  autoRenew: z.boolean().optional(),
});

const RenewSchema = z.object({
  cycle: z.enum(["month", "quarter", "year"]),
  count: z.number().int().min(1).max(36).default(1),
});

const MeCredentialsSchema = z.object({
  username: z.string().min(1).optional(),
  currentPassword: z.string().min(1),
  newPassword: z.string().min(6).optional(),
});

function randomAgentKey() {
  return crypto.randomBytes(16).toString("hex");
}

function inferAgentWsUrl(req: Request) {
  const host = req.headers.host ?? "localhost:3001";
  const xfProto = String(req.headers["x-forwarded-proto"] ?? "");
  const proto = (xfProto || req.protocol || "http").toLowerCase();
  const wsProto = proto === "https" ? "wss" : "ws";
  return `${wsProto}://${host}/ws/agent`;
}

function addCycle(baseMs: number, cycle: "month" | "quarter" | "year", count: number) {
  const d = new Date(baseMs);
  const months = cycle === "month" ? count : cycle === "quarter" ? count * 3 : count * 12;
  d.setMonth(d.getMonth() + months);
  return d.getTime();
}

function startMetricsPruner() {
  const retentionMs = env.METRICS_RETENTION_DAYS * 24 * 3600 * 1000;
  const intervalMs = env.METRICS_PRUNE_INTERVAL_MIN * 60 * 1000;

  const prune = () => {
    const cutoff = Date.now() - retentionMs;
    try {
      const info = db.prepare("DELETE FROM metrics WHERE at < ?").run(cutoff);
      if (info.changes > 0) {
        // eslint-disable-next-line no-console
        console.log(`[metrics] pruned ${info.changes} rows older than ${env.METRICS_RETENTION_DAYS} days`);
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("[metrics] prune failed", e);
    }
  };

  prune();
  setInterval(prune, intervalMs).unref();
}

function renderInstallScript(opts: {
  machineId: number;
  wsUrl: string;
  key: string;
  intervalSec: number;
  releaseBaseUrl: string;
}) {
  const cfg = {
    url: opts.wsUrl,
    id: opts.machineId,
    key: opts.key,
    disk: "/",
    intervalSec: opts.intervalSec,
  };
  const cfgJson = JSON.stringify(cfg, null, 2);
  const base = opts.releaseBaseUrl.replace(/\/+$/, "");

  return `#!/usr/bin/env bash
set -euo pipefail

if [ "\${EUID:-\$(id -u)}" -ne 0 ]; then
  if command -v sudo >/dev/null 2>&1; then
    exec sudo -E bash "$0" "$@"
  fi
  echo "Please run as root." >&2
  exit 1
fi

OS="\$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="\$(uname -m)"
if [ "\$OS" != "linux" ]; then
  echo "Unsupported OS: \$OS (only linux supported by this installer)" >&2
  exit 1
fi

case "\$ARCH" in
  x86_64|amd64) ASSET="yaws-agent-linux-amd64" ;;
  aarch64|arm64) ASSET="yaws-agent-linux-arm64" ;;
  *) echo "Unsupported arch: \$ARCH" >&2; exit 1 ;;
esac

BIN="/usr/local/bin/yaws-agent"
CFG="/etc/yaws-agent.json"
SVC="/etc/systemd/system/yaws-agent.service"

echo "[1/4] Downloading agent: ${base}/\$ASSET"
TMP="\$(mktemp -d)"
trap 'rm -rf "\$TMP"' EXIT

if command -v curl >/dev/null 2>&1; then
  curl -fsSL "${base}/\$ASSET" -o "\$TMP/yaws-agent"
elif command -v wget >/dev/null 2>&1; then
  wget -qO "\$TMP/yaws-agent" "${base}/\$ASSET"
else
  echo "Need curl or wget." >&2
  exit 1
fi

install -m 0755 "\$TMP/yaws-agent" "\$BIN"

echo "[2/4] Writing config: \$CFG"
cat > "\$CFG" <<'JSON'
${cfgJson}
JSON
chmod 0600 "\$CFG"

echo "[3/4] Installing service"
if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
  cat > "\$SVC" <<'UNIT'
[Unit]
Description=YAWS Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/local/bin/yaws-agent -config /etc/yaws-agent.json
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT

  systemctl daemon-reload
  systemctl enable --now yaws-agent
  systemctl restart yaws-agent
  echo "[4/4] Done. systemctl status yaws-agent --no-pager"
else
  echo "[3/4] systemd not found; running in background"
  nohup "\$BIN" -config "\$CFG" >/var/log/yaws-agent.log 2>&1 &
  echo "[4/4] Done. log: /var/log/yaws-agent.log"
fi
`;
}
