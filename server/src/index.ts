import express, { type Request } from "express";
import cors from "cors";
import path from "node:path";
import fs from "node:fs";
import http from "node:http";
import crypto from "node:crypto";
import os from "node:os";
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

function monthKeyUtc(at: number) {
  const d = new Date(at);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

app.get("/api/public/summary", (_req, res) => {
  const month = monthKeyUtc(Date.now());
  const rows = db
    .prepare(
      `SELECT
         m.id, m.name, m.online, m.last_seen_at as lastSeenAt,
         m.group_name as groupName,
         m.expires_at as expiresAt,
         m.billing_cycle as billingCycle,
         m.auto_renew as autoRenew,
         tm.month as monthKey,
         tm.rx_bytes as monthRxBytes,
         tm.tx_bytes as monthTxBytes,
         x.at as metricAt,
         x.cpu_usage as cpuUsage,
         x.mem_used as memUsed, x.mem_total as memTotal,
         x.disk_used as diskUsed, x.disk_total as diskTotal,
         x.net_rx_bytes as netRxBytes, x.net_tx_bytes as netTxBytes,
         x.load_1 as load1, x.load_5 as load5, x.load_15 as load15
       FROM machines m
       LEFT JOIN traffic_monthly tm ON tm.machine_id = m.id AND tm.month = ?
       LEFT JOIN metrics x ON x.id = (
         SELECT id FROM metrics WHERE machine_id = m.id ORDER BY at DESC LIMIT 1
       )
       ORDER BY m.sort_order ASC, m.id ASC`
    )
    .all(month);

  res.json({
    machines: rows.map((r: any) => ({
      id: r.id,
      name: r.name,
      online: r.online,
      lastSeenAt: r.lastSeenAt ?? null,
      groupName: r.groupName ?? "",
      expiresAt: r.expiresAt ?? null,
      billingCycle: r.billingCycle,
      autoRenew: r.autoRenew,
      monthTraffic: r.monthKey
        ? { month: r.monthKey, rxBytes: r.monthRxBytes ?? 0, txBytes: r.monthTxBytes ?? 0 }
        : { month, rxBytes: 0, txBytes: 0 },
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

app.get("/api/public/machines/:id", (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "bad_id" });
  const month = monthKeyUtc(Date.now());

  const m = db
    .prepare(
	      `SELECT
	        id, name, notes,
	        sort_order as sortOrder,
	        group_name as groupName,
	        tm.month as monthKey,
	        tm.rx_bytes as monthRxBytes,
	        tm.tx_bytes as monthTxBytes,
	        interval_sec as intervalSec,
	        agent_ws_url as agentWsUrl,
	        expires_at as expiresAt,
	        purchase_amount_cents as purchaseAmountCents,
	        billing_cycle as billingCycle,
	        auto_renew as autoRenew,
	        machines.created_at as createdAt,
	        machines.updated_at as updatedAt,
	        last_seen_at as lastSeenAt,
	        online
	      FROM machines
	      LEFT JOIN traffic_monthly tm ON tm.machine_id = machines.id AND tm.month = ?
	      WHERE machines.id = ?`
    )
    .get(month, id) as any | undefined;
  if (!m) return res.status(404).json({ error: "not_found" });

  const metrics = db
    .prepare(
      `SELECT
         at,
         cpu_usage as cpuUsage,
         mem_used as memUsed, mem_total as memTotal,
         disk_used as diskUsed, disk_total as diskTotal,
         net_rx_bytes as netRxBytes, net_tx_bytes as netTxBytes,
         load_1 as load1, load_5 as load5, load_15 as load15
       FROM metrics WHERE machine_id = ? ORDER BY at DESC LIMIT 300`
    )
    .all(id) as any[];

  res.json({
    machine: (() => {
      const { monthKey, monthRxBytes, monthTxBytes, ...rest } = m;
      return {
        ...rest,
        expiresAt: m.expiresAt ?? null,
        lastSeenAt: m.lastSeenAt ?? null,
        monthTraffic: monthKey ? { month: monthKey, rxBytes: monthRxBytes ?? 0, txBytes: monthTxBytes ?? 0 } : { month, rxBytes: 0, txBytes: 0 },
      };
    })(),
    metrics: metrics.reverse(),
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
function requireAdmin(req: Request, res: express.Response, next: express.NextFunction) {
  const user = (req as any).user as { id: number; username: string; role: string } | undefined;
  if (!user) return res.status(401).json({ error: "missing_token" });
  if (user.role !== "admin") return res.status(403).json({ error: "forbidden" });
  return next();
}

app.get("/api/me", requireAuth, (req, res) => {
  return res.json({ user: (req as any).user });
});

app.get("/api/admin/backup", requireAuth, requireAdmin, async (_req, res) => {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const tmp = path.join(os.tmpdir(), `yaws-backup-${ts}.sqlite`);
  try {
    await db.backup(tmp);
    res.setHeader("content-type", "application/octet-stream");
    res.setHeader("content-disposition", `attachment; filename="yaws-backup-${ts}.sqlite"`);
    fs.createReadStream(tmp)
      .on("error", () => res.status(500).end("read_failed"))
      .pipe(res)
      .on("finish", () => {
        try {
          fs.unlinkSync(tmp);
        } catch {
          // ignore
        }
      });
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // ignore
    }
    // eslint-disable-next-line no-console
    console.error("[backup] failed", e);
    res.status(500).json({ error: "backup_failed" });
  }
});

app.post("/api/admin/restore", requireAuth, requireAdmin, async (req, res) => {
  const ct = String(req.headers["content-type"] ?? "");
  if (!ct.startsWith("application/octet-stream")) return res.status(415).json({ error: "bad_content_type" });

  const maxBytes = env.ADMIN_RESTORE_MAX_MB * 1024 * 1024;
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const tmp = path.join(os.tmpdir(), `yaws-restore-${ts}.sqlite`);
  const out = fs.createWriteStream(tmp, { mode: 0o600 });

  let size = 0;
  let aborted = false;
  const abort = (code: number, err: string) => {
    aborted = true;
    try {
      req.destroy();
    } catch {
      // ignore
    }
    try {
      out.destroy();
    } catch {
      // ignore
    }
    try {
      fs.unlinkSync(tmp);
    } catch {
      // ignore
    }
    return res.status(code).json({ error: err });
  };

  req.on("data", (chunk: Buffer) => {
    size += chunk.length;
    if (size > maxBytes && !aborted) abort(413, "file_too_large");
  });
  req.on("error", () => {
    if (!aborted) abort(400, "upload_failed");
  });
  out.on("error", () => {
    if (!aborted) abort(500, "write_failed");
  });

  req.pipe(out);

  out.on("finish", () => {
    if (aborted) return;
    try {
      const fd = fs.openSync(tmp, "r");
      const header = Buffer.alloc(16);
      fs.readSync(fd, header, 0, 16, 0);
      fs.closeSync(fd);
      if (!header.toString("utf8").startsWith("SQLite format 3")) {
        return abort(400, "not_sqlite");
      }

      const dbPath = env.DATABASE_PATH;
      const bak = `${dbPath}.bak-${ts}`;

      try {
        db.close();
      } catch {
        // ignore
      }

      try {
        if (fs.existsSync(dbPath)) fs.renameSync(dbPath, bak);
        const wal = `${dbPath}-wal`;
        const shm = `${dbPath}-shm`;
        if (fs.existsSync(wal)) fs.renameSync(wal, `${bak}-wal`);
        if (fs.existsSync(shm)) fs.renameSync(shm, `${bak}-shm`);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error("[restore] backup current db failed", e);
        return abort(500, "backup_current_failed");
      }

      try {
        fs.renameSync(tmp, dbPath);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error("[restore] replace db failed", e);
        return abort(500, "replace_failed");
      }

      res.json({ ok: true, restarting: true });
      setTimeout(() => process.exit(0), 250).unref();
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("[restore] failed", e);
      return abort(500, "restore_failed");
    }
  });
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
  const month = monthKeyUtc(Date.now());
  const rows = db
    .prepare(
	      `SELECT
	        id, name, notes,
	        sort_order as sortOrder,
	        group_name as groupName,
	        hostname,
	        os_name as osName,
	        os_version as osVersion,
	        arch,
	        kernel_version as kernelVersion,
	        cpu_model as cpuModel,
	        cpu_cores as cpuCores,
	        tm.month as monthKey,
	        tm.rx_bytes as monthRxBytes,
	        tm.tx_bytes as monthTxBytes,
	        interval_sec as intervalSec,
	        agent_ws_url as agentWsUrl,
	        expires_at as expiresAt,
	        purchase_amount_cents as purchaseAmountCents,
	        billing_cycle as billingCycle,
	        auto_renew as autoRenew,
	        machines.created_at as createdAt,
	        machines.updated_at as updatedAt,
	        last_seen_at as lastSeenAt, online
	      FROM machines
	      LEFT JOIN traffic_monthly tm ON tm.machine_id = machines.id AND tm.month = ?
	      ORDER BY sort_order ASC, id ASC`
    )
    .all(month);
  res.json({
    machines: rows.map((m: any) => {
      const { monthKey, monthRxBytes, monthTxBytes, ...rest } = m;
      return {
        ...rest,
        monthTraffic: monthKey ? { month: monthKey, rxBytes: monthRxBytes ?? 0, txBytes: monthTxBytes ?? 0 } : { month, rxBytes: 0, txBytes: 0 },
      };
    }),
  });
});

app.get("/api/machines/summary", requireAuth, (_req, res) => {
  const month = monthKeyUtc(Date.now());
  const rows = db
    .prepare(
      `SELECT
         m.id,
         m.name,
         m.notes,
         m.sort_order as sortOrder,
         m.group_name as groupName,
         m.hostname,
         m.os_name as osName,
         m.os_version as osVersion,
         m.arch,
         m.kernel_version as kernelVersion,
         m.cpu_model as cpuModel,
         m.cpu_cores as cpuCores,
         tm.month as monthKey,
         tm.rx_bytes as monthRxBytes,
         tm.tx_bytes as monthTxBytes,
         m.interval_sec as intervalSec,
         m.agent_ws_url as agentWsUrl,
         m.expires_at as expiresAt,
         m.purchase_amount_cents as purchaseAmountCents,
         m.billing_cycle as billingCycle,
         m.auto_renew as autoRenew,
         m.created_at as createdAt,
         m.updated_at as updatedAt,
         m.last_seen_at as lastSeenAt,
         m.online,
         x.at as metricAt,
         x.cpu_usage as cpuUsage,
         x.mem_used as memUsed, x.mem_total as memTotal,
         x.disk_used as diskUsed, x.disk_total as diskTotal,
         x.net_rx_bytes as netRxBytes, x.net_tx_bytes as netTxBytes,
         x.load_1 as load1, x.load_5 as load5, x.load_15 as load15
       FROM machines m
       LEFT JOIN traffic_monthly tm ON tm.machine_id = m.id AND tm.month = ?
       LEFT JOIN metrics x ON x.id = (
         SELECT id FROM metrics WHERE machine_id = m.id ORDER BY at DESC LIMIT 1
       )
       ORDER BY m.sort_order ASC, m.id ASC`
    )
    .all(month);

  res.json({
    machines: rows.map((r: any) => ({
      id: r.id,
      name: r.name,
      notes: r.notes,
      sortOrder: r.sortOrder,
      groupName: r.groupName ?? "",
      hostname: r.hostname ?? "",
      osName: r.osName ?? "",
      osVersion: r.osVersion ?? "",
      arch: r.arch ?? "",
      kernelVersion: r.kernelVersion ?? "",
      cpuModel: r.cpuModel ?? "",
      cpuCores: r.cpuCores ?? 0,
      intervalSec: r.intervalSec,
      agentWsUrl: r.agentWsUrl,
      expiresAt: r.expiresAt ?? null,
      purchaseAmountCents: r.purchaseAmountCents,
      billingCycle: r.billingCycle,
      autoRenew: r.autoRenew,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      lastSeenAt: r.lastSeenAt ?? null,
      online: r.online,
      monthTraffic: r.monthKey
        ? { month: r.monthKey, rxBytes: r.monthRxBytes ?? 0, txBytes: r.monthTxBytes ?? 0 }
        : { month, rxBytes: 0, txBytes: 0 },
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

app.get("/api/machines/:id/traffic-monthly", requireAuth, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "bad_id" });
  const limit = Math.max(1, Math.min(60, Number(req.query.limit ?? 12)));
  const rows = db
    .prepare(
      `SELECT
         month,
         rx_bytes as rxBytes,
         tx_bytes as txBytes,
         updated_at as updatedAt
       FROM traffic_monthly
       WHERE machine_id = ?
       ORDER BY month DESC
       LIMIT ?`
    )
    .all(id, limit);
  res.json({ rows });
});

app.post("/api/machines", requireAuth, async (req, res) => {
  const body = MachineCreateSchema.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: "bad_request" });
  const now = Date.now();
  const agentKey = body.data.agentKey ?? randomAgentKey();
  const agentKeyHash = await bcrypt.hash(agentKey, 12);
  const agentKeyEnc = encryptText(agentKey, agentKeySecret);
  const nextSortOrder =
    (db.prepare("SELECT COALESCE(MAX(sort_order), 0) as m FROM machines").get() as any)?.m + 1;
  const info = db
    .prepare(
      `INSERT INTO machines (
         name, notes, sort_order, interval_sec,
         group_name,
         agent_key_hash, agent_key_enc, agent_ws_url,
         expires_at, purchase_amount_cents, billing_cycle, auto_renew,
         created_at, updated_at, online
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
    )
    .run(
      body.data.name,
      body.data.notes ?? "",
      nextSortOrder,
      body.data.intervalSec,
      (body.data.groupName ?? "").trim(),
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

app.put("/api/machines/order", requireAuth, (req, res) => {
  const body = MachinesOrderSchema.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: "bad_request" });

  const ids = body.data.machineIds;
  const uniq = new Set(ids);
  if (uniq.size !== ids.length) return res.status(400).json({ error: "duplicate_ids" });

  const tx = db.transaction(() => {
    const stmt = db.prepare("UPDATE machines SET sort_order = ? WHERE id = ?");
    ids.forEach((id, idx) => stmt.run(idx + 1, id));
  });
  tx();
  res.json({ ok: true });
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
         group_name = COALESCE(?, group_name),
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
    body.data.groupName ?? null,
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
    agentRepo: env.AGENT_GITHUB_REPO,
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
  groupName: z.string().max(64).optional(),
  intervalSec: z.number().int().min(2).max(3600).default(5),
  agentKey: z.string().min(8).optional(),
  agentWsUrl: z.string().optional(),
  expiresAt: z.number().int().nullable().optional(),
  purchaseAmount: z.number().nonnegative().optional(),
  billingCycle: z.enum(["month", "quarter", "half_year", "year", "two_year", "three_year"]).optional(),
  autoRenew: z.boolean().optional(),
});
const MachineUpdateSchema = z.object({
  name: z.string().min(1).optional(),
  notes: z.string().optional(),
  groupName: z.string().max(64).optional(),
  intervalSec: z.number().int().min(2).max(3600).optional(),
  agentKey: z.string().min(8).optional(),
  agentWsUrl: z.string().optional(),
  expiresAt: z.number().int().nullable().optional(),
  purchaseAmount: z.number().nonnegative().optional(),
  billingCycle: z.enum(["month", "quarter", "half_year", "year", "two_year", "three_year"]).optional(),
  autoRenew: z.boolean().optional(),
});

const RenewSchema = z.object({
  cycle: z.enum(["month", "quarter", "half_year", "year", "two_year", "three_year"]),
  count: z.number().int().min(1).max(36).default(1),
});

const MeCredentialsSchema = z.object({
  username: z.string().min(1).optional(),
  currentPassword: z.string().min(1),
  newPassword: z.string().min(6).optional(),
});

const MachinesOrderSchema = z.object({
  machineIds: z.array(z.number().int().positive()).min(1).max(10000),
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

function addCycle(
  baseMs: number,
  cycle: "month" | "quarter" | "half_year" | "year" | "two_year" | "three_year",
  count: number
) {
  const d = new Date(baseMs);
  const months =
    cycle === "month"
      ? count
      : cycle === "quarter"
        ? count * 3
        : cycle === "half_year"
          ? count * 6
          : cycle === "year"
            ? count * 12
            : cycle === "two_year"
              ? count * 24
              : count * 36;
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
  agentRepo: string;
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
  const repo = opts.agentRepo.trim();

  return `#!/usr/bin/env bash
set -euo pipefail

if [ "\${EUID:-\$(id -u)}" -ne 0 ]; then
  if command -v sudo >/dev/null 2>&1; then
    exec sudo -E bash "$0" "$@"
  fi
  echo "Please run as root." >&2
  exit 1
fi

FORCE=0
CHECK_ONLY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --force) FORCE=1 ;;
    --check) CHECK_ONLY=1 ;;
    -h|--help)
      echo "Usage: $0 [--check] [--force]"
      exit 0
      ;;
    *) echo "Unknown arg: $1" >&2; exit 2 ;;
  esac
  shift
done

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

REPO="${repo}"
BASE="${base}"

LATEST_TAG=""
if [ -n "$REPO" ]; then
  API="https://api.github.com/repos/$REPO/releases/latest"
  if command -v curl >/dev/null 2>&1; then
    JSON="\$(curl -fsSL "\$API" 2>/dev/null || true)"
  elif command -v wget >/dev/null 2>&1; then
    JSON="\$(wget -qO- "\$API" 2>/dev/null || true)"
  else
    JSON=""
  fi
  if [ -n "\$JSON" ]; then
    LATEST_TAG="\$(printf '%s' "\$JSON" | tr -d '\r' | grep -m1 '\"tag_name\"' | sed -E 's/.*\"tag_name\"[[:space:]]*:[[:space:]]*\"([^\"]+)\".*/\\1/')"
  fi

  # If BASE is a GitHub release URL, prefer downloading by tag so "latest" and version checks stay in sync.
  if [ -n "\$LATEST_TAG" ] && printf '%s' "\$BASE" | grep -q '^https://github.com/'; then
    BASE="https://github.com/$REPO/releases/download/\$LATEST_TAG"
  fi
fi

INSTALLED_TAG=""
if [ -x "\$BIN" ]; then
  INSTALLED_TAG="\$("\$BIN" -version 2>/dev/null | head -n1 | tr -d '\r' || true)"
fi

if [ "\$CHECK_ONLY" -eq 1 ]; then
  echo "installed=\${INSTALLED_TAG:-none}"
  echo "latest=\${LATEST_TAG:-unknown}"
  exit 0
fi

NEED_DOWNLOAD=0
if [ ! -x "\$BIN" ] || [ "\$FORCE" -eq 1 ]; then
  NEED_DOWNLOAD=1
elif [ -n "\$LATEST_TAG" ]; then
  # If the installed agent doesn't support -version, treat it as outdated.
  if [ -z "\$INSTALLED_TAG" ] || [ "\$INSTALLED_TAG" != "\$LATEST_TAG" ]; then
    NEED_DOWNLOAD=1
  fi
fi

TMP="\$(mktemp -d)"
trap 'rm -rf "\$TMP"' EXIT

if [ "\$NEED_DOWNLOAD" -eq 1 ]; then
  echo "[1/4] Downloading agent: \$BASE/\$ASSET (installed=\${INSTALLED_TAG:-none} latest=\${LATEST_TAG:-unknown})"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "\$BASE/\$ASSET" -o "\$TMP/yaws-agent"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "\$TMP/yaws-agent" "\$BASE/\$ASSET"
  else
    echo "Need curl or wget." >&2
    exit 1
  fi
  install -m 0755 "\$TMP/yaws-agent" "\$BIN"
else
  echo "[1/4] Agent already latest: \${INSTALLED_TAG:-unknown}"
fi

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
