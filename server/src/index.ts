import express, { type Request } from "express";
import cors from "cors";
import path from "node:path";
import fs from "node:fs";
import http from "node:http";
import crypto from "node:crypto";
import os from "node:os";
import zlib from "node:zlib";
import Database from "better-sqlite3";
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

let isRestoring = false;
app.use((req, res, next) => {
  if (!isRestoring) return next();
  if (req.path === "/health") return next();
  if (req.path === "/api/admin/restore") return next();
  return res.status(503).json({ error: "restarting" });
});

app.get("/health", (_req, res) => res.json({ ok: true }));

function validateBackupDb(filePath: string) {
  const tmp = new Database(filePath, { readonly: true, fileMustExist: true });
  try {
    const tables = new Set(
      tmp
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
        .all()
        .map((r: any) => String(r.name))
    );
    const required = ["users", "machines", "metrics"];
    for (const t of required) {
      if (!tables.has(t)) throw new Error("schema_missing");
    }
    const users = (tmp.prepare("SELECT COUNT(*) as c FROM users").get() as any)?.c ?? 0;
    const machines = (tmp.prepare("SELECT COUNT(*) as c FROM machines").get() as any)?.c ?? 0;
    const metrics = (tmp.prepare("SELECT COUNT(*) as c FROM metrics").get() as any)?.c ?? 0;
    if (users < 1) throw new Error("no_users");
    return { users, machines, metrics };
  } finally {
    try {
      tmp.close();
    } catch {
      // ignore
    }
  }
}

function monthKeyUtc(at: number) {
  const d = new Date(at);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

function daysInMonthUtc(year: number, month0: number) {
  return new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
}

function pad2(n: number) {
  return String(n).padStart(2, "0");
}

function billingMonthBoundsUtc(atMs: number, anchorDay: number) {
  const at = new Date(atMs);
  let year = at.getUTCFullYear();
  let month0 = at.getUTCMonth();
  const a = Math.min(31, Math.max(1, anchorDay || 1));

  const mkStart = (y: number, m0: number) => {
    const d = Math.min(a, daysInMonthUtc(y, m0));
    return Date.UTC(y, m0, d, 0, 0, 0, 0);
  };
  let startAt = mkStart(year, month0);
  if (atMs < startAt) {
    month0 -= 1;
    if (month0 < 0) {
      month0 = 11;
      year -= 1;
    }
    startAt = mkStart(year, month0);
  }

  let endYear = year;
  let endMonth0 = month0 + 1;
  if (endMonth0 > 11) {
    endMonth0 = 0;
    endYear += 1;
  }
  const endAt = mkStart(endYear, endMonth0);
  const s = new Date(startAt);
  const periodKey = `${s.getUTCFullYear()}-${pad2(s.getUTCMonth() + 1)}-${pad2(s.getUTCDate())}`;
  return { periodKey, startAt, endAt, anchorDay: a };
}

type UptimeBucketState = "up" | "warn" | "down";

function computeUptimeBuckets(db: Database.Database, opts: { machineId: number; hours: number; bucketMin: number; offlineAfterMin: number }) {
  const hours = Math.max(1, Math.min(24 * 30, Math.floor(opts.hours || 24)));
  const bucketMin = Math.max(1, Math.min(60, Math.floor(opts.bucketMin || 5)));
  const offlineAfterMin = Math.max(1, Math.min(24 * 60, Math.floor(opts.offlineAfterMin || 5)));

  const endAt = Date.now();
  const bucketMs = bucketMin * 60_000;
  const startAt = endAt - hours * 60 * 60_000;
  const bucketsCount = Math.floor((endAt - startAt) / bucketMs);

  const prev = db
    .prepare("SELECT at FROM metrics WHERE machine_id = ? AND at < ? ORDER BY at DESC LIMIT 1")
    .get(opts.machineId, startAt) as any | undefined;

  const rows = db
    .prepare("SELECT at FROM metrics WHERE machine_id = ? AND at >= ? AND at <= ? ORDER BY at ASC")
    .all(opts.machineId, startAt, endAt) as any[];

  const times: number[] = [];
  if (prev?.at) times.push(Number(prev.at));
  for (const r of rows) times.push(Number(r.at));

  let idx = 0;
  let lastAt: number | null = null;
  const offlineAfterMs = offlineAfterMin * 60_000;

  let upCount = 0;
  let warnCount = 0;
  let downCount = 0;

  const buckets: Array<{ at: number; state: UptimeBucketState }> = [];
  for (let i = 0; i < bucketsCount; i++) {
    const bucketEnd = startAt + (i + 1) * bucketMs;
    while (idx < times.length && times[idx] <= bucketEnd) {
      lastAt = times[idx];
      idx++;
    }

    let state: UptimeBucketState = "down";
    if (lastAt != null) {
      const delta = bucketEnd - lastAt;
      if (delta <= offlineAfterMs) state = "up";
      else if (delta <= offlineAfterMs * 3) state = "warn";
      else state = "down";
    }

    if (state === "up") upCount++;
    else if (state === "warn") warnCount++;
    else downCount++;

    buckets.push({ at: bucketEnd, state });
  }

  const total = Math.max(1, buckets.length);
  return {
    machineId: opts.machineId,
    startAt,
    endAt,
    bucketMin,
    hours,
    offlineAfterMin,
    upPct: upCount / total,
    counts: { up: upCount, warn: warnCount, down: downCount, total },
    buckets,
  };
}

app.get("/api/public/summary", (_req, res) => {
  const now = Date.now();
  const rows = db
    .prepare(
      `SELECT
         m.id, m.name, m.online, m.last_seen_at as lastSeenAt,
         m.group_name as groupName,
         m.expires_at as expiresAt,
         m.billing_cycle as billingCycle,
         m.billing_anchor_day as anchorDay,
         m.auto_renew as autoRenew,
         tc.period_key as periodKey,
         tc.start_at as periodStartAt,
         tc.end_at as periodEndAt,
         tc.rx_bytes as periodRxBytes,
         tc.tx_bytes as periodTxBytes,
         x.at as metricAt,
         x.cpu_usage as cpuUsage,
         x.mem_used as memUsed, x.mem_total as memTotal,
          x.disk_used as diskUsed, x.disk_total as diskTotal,
          x.net_rx_bytes as netRxBytes, x.net_tx_bytes as netTxBytes,
          x.tcp_conn as tcpConn, x.udp_conn as udpConn,
          x.load_1 as load1, x.load_5 as load5, x.load_15 as load15
        FROM machines m
       LEFT JOIN traffic_cycles tc ON tc.machine_id = m.id AND tc.start_at <= ? AND tc.end_at > ?
       LEFT JOIN metrics x ON x.id = (
         SELECT id FROM metrics WHERE machine_id = m.id ORDER BY at DESC LIMIT 1
       )
       ORDER BY m.sort_order ASC, m.id ASC`
    )
    .all(now, now);

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
      monthTraffic: (() => {
        if (r.periodKey) {
          return {
            month: r.periodKey,
            startAt: r.periodStartAt,
            endAt: r.periodEndAt,
            rxBytes: r.periodRxBytes ?? 0,
            txBytes: r.periodTxBytes ?? 0,
          };
        }
        const b = billingMonthBoundsUtc(now, r.anchorDay ?? 1);
        return { month: b.periodKey, startAt: b.startAt, endAt: b.endAt, rxBytes: 0, txBytes: 0 };
      })(),
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
              tcpConn: r.tcpConn ?? 0,
              udpConn: r.udpConn ?? 0,
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
  const now = Date.now();

  const m = db
    .prepare(
      `SELECT
        id, name, notes,
        sort_order as sortOrder,
        group_name as groupName,
        billing_anchor_day as anchorDay,
        tc.period_key as periodKey,
        tc.start_at as periodStartAt,
        tc.end_at as periodEndAt,
        tc.rx_bytes as periodRxBytes,
        tc.tx_bytes as periodTxBytes,
        interval_sec as intervalSec,
        agent_ws_url as agentWsUrl,
        ssh_host as sshHost,
        ssh_port as sshPort,
        ssh_user as sshUser,
        ssh_auth_type as sshAuthType,
        CASE WHEN ssh_password_enc != '' THEN 1 ELSE 0 END as sshHasPassword,
        CASE WHEN ssh_key_enc != '' THEN 1 ELSE 0 END as sshHasKey,
        expires_at as expiresAt,
        purchase_amount_cents as purchaseAmountCents,
        billing_cycle as billingCycle,
        auto_renew as autoRenew,
        machines.created_at as createdAt,
        machines.updated_at as updatedAt,
        last_seen_at as lastSeenAt,
        online
      FROM machines
      LEFT JOIN traffic_cycles tc ON tc.machine_id = machines.id AND tc.start_at <= ? AND tc.end_at > ?
      WHERE machines.id = ?`
    )
    .get(now, now, id) as any | undefined;
  if (!m) return res.status(404).json({ error: "not_found" });

  const metrics = db
    .prepare(
      `SELECT
         at,
         cpu_usage as cpuUsage,
         mem_used as memUsed, mem_total as memTotal,
         disk_used as diskUsed, disk_total as diskTotal,
         net_rx_bytes as netRxBytes, net_tx_bytes as netTxBytes,
         tcp_conn as tcpConn, udp_conn as udpConn,
         load_1 as load1, load_5 as load5, load_15 as load15
       FROM metrics WHERE machine_id = ? ORDER BY at DESC LIMIT 300`
    )
    .all(id) as any[];

  res.json({
    machine: (() => {
      const { anchorDay, periodKey, periodStartAt, periodEndAt, periodRxBytes, periodTxBytes, ...rest } = m;
      const b = billingMonthBoundsUtc(now, anchorDay ?? 1);
      return {
        ...rest,
        expiresAt: m.expiresAt ?? null,
        lastSeenAt: m.lastSeenAt ?? null,
        monthTraffic: periodKey
          ? { month: periodKey, startAt: periodStartAt, endAt: periodEndAt, rxBytes: periodRxBytes ?? 0, txBytes: periodTxBytes ?? 0 }
          : { month: b.periodKey, startAt: b.startAt, endAt: b.endAt, rxBytes: 0, txBytes: 0 },
      };
    })(),
    metrics: metrics.reverse(),
  });
});

app.get("/api/public/machines/:id/uptime", (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "bad_id" });

  const row = db.prepare("SELECT id FROM machines WHERE id = ?").get(id) as { id: number } | undefined;
  if (!row) return res.status(404).json({ error: "not_found" });

  const hours = Number((req.query as any).hours ?? 24);
  const bucketMin = Number((req.query as any).bucketMin ?? 5);
  const offlineAfterMin = Number(getSetting("telegram_offline_after_min") ?? "5");

  const payload = computeUptimeBuckets(db, {
    machineId: id,
    hours,
    bucketMin,
    offlineAfterMin: Number.isFinite(offlineAfterMin) ? offlineAfterMin : 5,
  });

  res.json(payload);
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

function getSetting(key: string) {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

function setSetting(key: string, value: string) {
  db.prepare(
    `INSERT INTO settings (key, value, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(key, value, Date.now());
}

function delSetting(key: string) {
  db.prepare("DELETE FROM settings WHERE key = ?").run(key);
}

app.get("/api/admin/backup", requireAuth, requireAdmin, async (req, res) => {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const tmpDb = path.join(os.tmpdir(), `yaws-backup-${ts}.sqlite`);
  const gzipOut = String((req.query as any)?.gzip ?? "") === "1";
  const tmpOut = gzipOut ? `${tmpDb}.gz` : tmpDb;
  try {
    await db.backup(tmpDb);
    if (gzipOut) {
      await new Promise<void>((resolve, reject) => {
        const gz = zlib.createGzip({ level: 6 });
        const out = fs.createWriteStream(tmpOut, { mode: 0o600 });
        fs.createReadStream(tmpDb).pipe(gz).pipe(out);
        out.on("finish", () => resolve());
        out.on("error", reject);
        gz.on("error", reject);
      });
    }

    res.setHeader("content-type", gzipOut ? "application/gzip" : "application/octet-stream");
    res.setHeader(
      "content-disposition",
      `attachment; filename="yaws-backup-${ts}.sqlite${gzipOut ? ".gz" : ""}"`
    );
    fs.createReadStream(tmpOut)
      .on("error", () => res.status(500).end("read_failed"))
      .pipe(res)
      .on("finish", () => {
        try {
          if (fs.existsSync(tmpOut)) fs.unlinkSync(tmpOut);
          if (fs.existsSync(tmpDb)) fs.unlinkSync(tmpDb);
        } catch {
          // ignore
        }
      });
  } catch (e) {
    try {
      if (fs.existsSync(tmpOut)) fs.unlinkSync(tmpOut);
      if (fs.existsSync(tmpDb)) fs.unlinkSync(tmpDb);
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
  const tmpUpload = path.join(os.tmpdir(), `yaws-restore-${ts}.upload`);
  const out = fs.createWriteStream(tmpUpload, { mode: 0o600 });

  let size = 0;
  let aborted = false;
  let shouldExitSoon = false;
  const exitSoon = (code: number) => {
    if (shouldExitSoon) return;
    shouldExitSoon = true;
    setTimeout(() => process.exit(code), 250).unref();
  };
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
      if (fs.existsSync(tmpUpload)) fs.unlinkSync(tmpUpload);
      const tmpDb = `${tmpUpload}.sqlite`;
      if (fs.existsSync(tmpDb)) fs.unlinkSync(tmpDb);
    } catch {
      // ignore
    }
    // If we already closed SQLite during restore, exit to let Docker restart with a fresh connection.
    if (isRestoring) exitSoon(1);
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
      const head = Buffer.alloc(2);
      const fd0 = fs.openSync(tmpUpload, "r");
      fs.readSync(fd0, head, 0, 2, 0);
      fs.closeSync(fd0);
      const isGzip = head[0] === 0x1f && head[1] === 0x8b;

      const tmpDb = isGzip ? `${tmpUpload}.sqlite` : tmpUpload;
      if (isGzip) {
        // Decompress to sqlite file.
        const gunzip = zlib.createGunzip();
        const outDb = fs.createWriteStream(tmpDb, { mode: 0o600 });
        fs.createReadStream(tmpUpload).pipe(gunzip).pipe(outDb);
        const done = () => {
          try {
            const fd = fs.openSync(tmpDb, "r");
            const header = Buffer.alloc(16);
            fs.readSync(fd, header, 0, 16, 0);
            fs.closeSync(fd);
            if (!header.toString("utf8").startsWith("SQLite format 3")) {
              return abort(400, "not_sqlite");
            }
            try {
              validateBackupDb(tmpDb);
            } catch (e: any) {
              const code =
                e?.message === "schema_missing" ? "schema_missing" : e?.message === "no_users" ? "no_users" : "bad_db";
              return abort(400, code);
            }
            doRestore(tmpDb);
          } catch (e) {
            // eslint-disable-next-line no-console
            console.error("[restore] validate failed", e);
            return abort(400, "not_sqlite");
          }
        };
        outDb.on("finish", done);
        outDb.on("error", () => abort(500, "write_failed"));
        gunzip.on("error", () => abort(400, "bad_gzip"));
        return;
      }

      // Validate raw sqlite upload.
      const fd = fs.openSync(tmpDb, "r");
      const header = Buffer.alloc(16);
      fs.readSync(fd, header, 0, 16, 0);
      fs.closeSync(fd);
      if (!header.toString("utf8").startsWith("SQLite format 3")) return abort(400, "not_sqlite");
      try {
        validateBackupDb(tmpDb);
      } catch (e: any) {
        const code = e?.message === "schema_missing" ? "schema_missing" : e?.message === "no_users" ? "no_users" : "bad_db";
        return abort(400, code);
      }

      const dbPath = env.DATABASE_PATH;
      const bak = `${dbPath}.bak-${ts}`;
      const wal = `${dbPath}-wal`;
      const shm = `${dbPath}-shm`;

      isRestoring = true;
      exitSoon(0);
      try {
        db.close();
      } catch {
        // ignore
      }

      try {
        if (fs.existsSync(dbPath)) fs.renameSync(dbPath, bak);
        if (fs.existsSync(wal)) fs.renameSync(wal, `${bak}-wal`);
        if (fs.existsSync(shm)) fs.renameSync(shm, `${bak}-shm`);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error("[restore] backup current db failed", e);
        return abort(500, "backup_current_failed");
      }

      try {
        replaceFile(tmpDb, dbPath);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error("[restore] replace db failed", e);
        tryRollback(dbPath, bak);
        return abort(500, "replace_failed");
      } finally {
        try {
          if (fs.existsSync(tmpUpload)) fs.unlinkSync(tmpUpload);
        } catch {
          // ignore
        }
      }

      res.json({ ok: true, restarting: true });
      return;
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("[restore] failed", e);
      return abort(500, "restore_failed");
    }

    function replaceFile(src: string, dst: string) {
      const dir = path.dirname(dst);
      if (dir && dir !== "." && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      try {
        fs.renameSync(src, dst);
        return;
      } catch (e: any) {
        if (e?.code !== "EXDEV") throw e;
      }
      fs.copyFileSync(src, dst);
      try {
        fs.chmodSync(dst, 0o600);
      } catch {
        // ignore
      }
      fs.unlinkSync(src);
    }

    function tryRollback(dbPath: string, bak: string) {
      try {
        if (!fs.existsSync(dbPath) && fs.existsSync(bak)) fs.renameSync(bak, dbPath);
      } catch {
        // ignore
      }
      try {
        const wal = `${dbPath}-wal`;
        const shm = `${dbPath}-shm`;
        if (!fs.existsSync(wal) && fs.existsSync(`${bak}-wal`)) fs.renameSync(`${bak}-wal`, wal);
        if (!fs.existsSync(shm) && fs.existsSync(`${bak}-shm`)) fs.renameSync(`${bak}-shm`, shm);
      } catch {
        // ignore
      }
    }

    function doRestore(tmpDb: string) {
      try {
        const dbPath = env.DATABASE_PATH;
        const bak = `${dbPath}.bak-${ts}`;
        const wal = `${dbPath}-wal`;
        const shm = `${dbPath}-shm`;

        isRestoring = true;
        exitSoon(0);
        try {
          db.close();
        } catch {
          // ignore
        }

        try {
          if (fs.existsSync(dbPath)) fs.renameSync(dbPath, bak);
          if (fs.existsSync(wal)) fs.renameSync(wal, `${bak}-wal`);
          if (fs.existsSync(shm)) fs.renameSync(shm, `${bak}-shm`);
        } catch (e) {
          // eslint-disable-next-line no-console
          console.error("[restore] backup current db failed", e);
          return abort(500, "backup_current_failed");
        }

        try {
          replaceFile(tmpDb, dbPath);
        } catch (e) {
          // eslint-disable-next-line no-console
          console.error("[restore] replace db failed", e);
          tryRollback(dbPath, bak);
          return abort(500, "replace_failed");
        } finally {
          try {
            if (fs.existsSync(tmpUpload)) fs.unlinkSync(tmpUpload);
          } catch {
            // ignore
          }
        }

        res.json({ ok: true, restarting: true });
        return;
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error("[restore] failed", e);
        return abort(500, "restore_failed");
      }
    }
  });
});

const TelegramSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  botToken: z.string().optional(),
  chatId: z.string().optional(),
  offlineAfterMin: z.number().int().min(1).max(1440).optional(),
  expiryWarnDays: z.number().int().min(0).max(3650).optional(),
  notifyOffline: z.boolean().optional(),
  notifyOnline: z.boolean().optional(),
  notifyExpiry: z.boolean().optional(),
});

app.get("/api/admin/telegram/settings", requireAuth, requireAdmin, (req, res) => {
  const tokenEnc = getSetting("telegram_token_enc");
  const token = tokenEnc ? decryptText(tokenEnc, agentKeySecret) : env.TELEGRAM_BOT_TOKEN ?? "";
  const chatId = getSetting("telegram_chat_id") ?? env.TELEGRAM_CHAT_ID ?? "";
  const enabledRaw = getSetting("telegram_enabled");
  const enabled = enabledRaw != null ? enabledRaw === "1" : !!(token && chatId);
  const offlineAfterMin = Number(getSetting("telegram_offline_after_min") ?? "5");
  const expiryWarnDays = Number(getSetting("telegram_expiry_warn_days") ?? "10");
  const notifyOffline = (getSetting("telegram_notify_offline") ?? "1") === "1";
  const notifyOnline = (getSetting("telegram_notify_online") ?? "1") === "1";
  const notifyExpiry = (getSetting("telegram_notify_expiry") ?? "1") === "1";

  const masked = token ? `${token.slice(0, 4)}...${token.slice(-4)}` : "";
  res.json({
    enabled,
    botTokenMasked: masked,
    chatId,
    offlineAfterMin: Number.isFinite(offlineAfterMin) ? offlineAfterMin : 5,
    expiryWarnDays: Number.isFinite(expiryWarnDays) ? expiryWarnDays : 10,
    notifyOffline,
    notifyOnline,
    notifyExpiry,
    configured: !!(token && chatId),
  });
});

app.put("/api/admin/telegram/settings", requireAuth, requireAdmin, (req, res) => {
  const body = TelegramSettingsSchema.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: "bad_request" });

  if (body.data.enabled != null) setSetting("telegram_enabled", body.data.enabled ? "1" : "0");
  if (body.data.offlineAfterMin != null) setSetting("telegram_offline_after_min", String(body.data.offlineAfterMin));
  if (body.data.expiryWarnDays != null) setSetting("telegram_expiry_warn_days", String(body.data.expiryWarnDays));
  if (body.data.notifyOffline != null) setSetting("telegram_notify_offline", body.data.notifyOffline ? "1" : "0");
  if (body.data.notifyOnline != null) setSetting("telegram_notify_online", body.data.notifyOnline ? "1" : "0");
  if (body.data.notifyExpiry != null) setSetting("telegram_notify_expiry", body.data.notifyExpiry ? "1" : "0");

  if (body.data.chatId != null) {
    const v = body.data.chatId.trim();
    if (!v) delSetting("telegram_chat_id");
    else setSetting("telegram_chat_id", v);
  }

  if (body.data.botToken != null) {
    const v = body.data.botToken.trim();
    if (!v) delSetting("telegram_token_enc");
    else setSetting("telegram_token_enc", encryptText(v, agentKeySecret));
  }

  res.json({ ok: true });
});

app.post("/api/admin/telegram/test", requireAuth, requireAdmin, async (req, res) => {
  const body = z
    .object({ message: z.string().min(1).max(2000).optional() })
    .safeParse(req.body ?? {});
  if (!body.success) return res.status(400).json({ error: "bad_request" });
  try {
    const cfg = loadTelegramConfig();
    if (!cfg.token || !cfg.chatId) return res.status(409).json({ error: "telegram_not_configured" });
    const msg = body.data.message ?? `YAWS 测试通知：${new Date().toLocaleString()}`;
    await sendTelegram(cfg, msg);
    res.json({ ok: true });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("[telegram] test failed", e);
    res.status(500).json({ error: e instanceof Error ? e.message : "send_failed" });
  }
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
  const now = Date.now();
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
        billing_anchor_day as anchorDay,
        tc.period_key as periodKey,
        tc.start_at as periodStartAt,
        tc.end_at as periodEndAt,
        tc.rx_bytes as periodRxBytes,
        tc.tx_bytes as periodTxBytes,
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
      LEFT JOIN traffic_cycles tc ON tc.machine_id = machines.id AND tc.start_at <= ? AND tc.end_at > ?
      ORDER BY sort_order ASC, id ASC`
    )
    .all(now, now);
  res.json({
    machines: rows.map((m: any) => {
      const { anchorDay, periodKey, periodStartAt, periodEndAt, periodRxBytes, periodTxBytes, ...rest } = m;
      const b = billingMonthBoundsUtc(now, anchorDay ?? 1);
      return {
        ...rest,
        sshPort: Number(rest.sshPort ?? 22),
        sshAuthType: (rest.sshAuthType ?? "password") as any,
        sshHasPassword: !!rest.sshHasPassword,
        sshHasKey: !!rest.sshHasKey,
        monthTraffic: periodKey
          ? { month: periodKey, startAt: periodStartAt, endAt: periodEndAt, rxBytes: periodRxBytes ?? 0, txBytes: periodTxBytes ?? 0 }
          : { month: b.periodKey, startAt: b.startAt, endAt: b.endAt, rxBytes: 0, txBytes: 0 },
      };
    }),
  });
});

app.get("/api/machines/summary", requireAuth, (_req, res) => {
  const now = Date.now();
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
         m.billing_anchor_day as anchorDay,
         tc.period_key as periodKey,
         tc.start_at as periodStartAt,
         tc.end_at as periodEndAt,
         tc.rx_bytes as periodRxBytes,
         tc.tx_bytes as periodTxBytes,
         m.interval_sec as intervalSec,
         m.agent_ws_url as agentWsUrl,
         m.ssh_host as sshHost,
         m.ssh_port as sshPort,
         m.ssh_user as sshUser,
         m.ssh_auth_type as sshAuthType,
         CASE WHEN m.ssh_password_enc != '' THEN 1 ELSE 0 END as sshHasPassword,
         CASE WHEN m.ssh_key_enc != '' THEN 1 ELSE 0 END as sshHasKey,
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
          x.tcp_conn as tcpConn, x.udp_conn as udpConn,
          x.load_1 as load1, x.load_5 as load5, x.load_15 as load15
        FROM machines m
       LEFT JOIN traffic_cycles tc ON tc.machine_id = m.id AND tc.start_at <= ? AND tc.end_at > ?
       LEFT JOIN metrics x ON x.id = (
         SELECT id FROM metrics WHERE machine_id = m.id ORDER BY at DESC LIMIT 1
       )
       ORDER BY m.sort_order ASC, m.id ASC`
    )
    .all(now, now);

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
      sshHost: r.sshHost ?? "",
      sshPort: Number(r.sshPort ?? 22),
      sshUser: r.sshUser ?? "",
      sshAuthType: (r.sshAuthType ?? "password") as any,
      sshHasPassword: !!r.sshHasPassword,
      sshHasKey: !!r.sshHasKey,
      expiresAt: r.expiresAt ?? null,
      purchaseAmountCents: r.purchaseAmountCents,
      billingCycle: r.billingCycle,
      autoRenew: r.autoRenew,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      lastSeenAt: r.lastSeenAt ?? null,
      online: r.online,
      monthTraffic: (() => {
        if (r.periodKey) {
          return {
            month: r.periodKey,
            startAt: r.periodStartAt,
            endAt: r.periodEndAt,
            rxBytes: r.periodRxBytes ?? 0,
            txBytes: r.periodTxBytes ?? 0,
          };
        }
        const b = billingMonthBoundsUtc(now, r.anchorDay ?? 1);
        return { month: b.periodKey, startAt: b.startAt, endAt: b.endAt, rxBytes: 0, txBytes: 0 };
      })(),
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
            tcpConn: r.tcpConn ?? 0,
            udpConn: r.udpConn ?? 0,
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
         period_key as month,
         start_at as startAt,
         end_at as endAt,
         rx_bytes as rxBytes,
         tx_bytes as txBytes,
         updated_at as updatedAt
       FROM traffic_cycles
       WHERE machine_id = ?
       ORDER BY start_at DESC
       LIMIT ?`
    )
    .all(id, limit);
  res.json({ rows });
});

app.post("/api/machines", requireAuth, async (req, res) => {
  const body = MachineCreateSchema.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: "bad_request" });
  const now = Date.now();
  const billingAnchorDay = body.data.expiresAt ? new Date(body.data.expiresAt).getUTCDate() : new Date(now).getUTCDate();
  const agentKey = body.data.agentKey ?? randomAgentKey();
  const agentKeyHash = await bcrypt.hash(agentKey, 12);
  const agentKeyEnc = encryptText(agentKey, agentKeySecret);

  const sshHost = (body.data.sshHost ?? "").trim();
  const sshPort = body.data.sshPort ?? 22;
  const sshUser = (body.data.sshUser ?? "").trim();
  const sshAuthType = body.data.sshAuthType ?? "password";
  const sshPasswordEnc = body.data.sshPassword ? encryptText(body.data.sshPassword, agentKeySecret) : "";
  const sshKeyEnc = body.data.sshPrivateKey ? encryptText(body.data.sshPrivateKey, agentKeySecret) : "";

  const nextSortOrder =
    (db.prepare("SELECT COALESCE(MAX(sort_order), 0) as m FROM machines").get() as any)?.m + 1;
  const info = db
    .prepare(
      `INSERT INTO machines (
         name, notes, sort_order, interval_sec,
         group_name,
         agent_key_hash, agent_key_enc, agent_ws_url,
         ssh_host, ssh_port, ssh_user, ssh_auth_type, ssh_password_enc, ssh_key_enc,
         expires_at, purchase_amount_cents, billing_cycle, auto_renew,
         billing_anchor_day,
         created_at, updated_at, online
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
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
      sshHost,
      sshPort,
      sshUser,
      sshAuthType,
      sshPasswordEnc,
      sshKeyEnc,
      body.data.expiresAt ?? null,
      Math.max(0, Math.round((body.data.purchaseAmount ?? 0) * 100)),
      body.data.billingCycle ?? "month",
      body.data.autoRenew ? 1 : 0,
      billingAnchorDay,
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
  const anchorDay = hasExpiresAt && body.data.expiresAt ? new Date(body.data.expiresAt).getUTCDate() : null;
  const keyHash = body.data.agentKey ? await bcrypt.hash(body.data.agentKey, 12) : null;
  const keyEnc = body.data.agentKey ? encryptText(body.data.agentKey, agentKeySecret) : null;

  const hasSshPassword = Object.prototype.hasOwnProperty.call(req.body ?? {}, "sshPassword");
  const hasSshKey = Object.prototype.hasOwnProperty.call(req.body ?? {}, "sshPrivateKey");
  const sshPasswordEnc = hasSshPassword ? (body.data.sshPassword ? encryptText(body.data.sshPassword, agentKeySecret) : "") : null;
  const sshKeyEnc = hasSshKey ? (body.data.sshPrivateKey ? encryptText(body.data.sshPrivateKey, agentKeySecret) : "") : null;

  db.prepare(
    `UPDATE machines
     SET name = COALESCE(?, name),
         notes = COALESCE(?, notes),
         group_name = COALESCE(?, group_name),
         interval_sec = COALESCE(?, interval_sec),
         agent_key_hash = COALESCE(?, agent_key_hash),
         agent_key_enc = COALESCE(?, agent_key_enc),
         agent_ws_url = COALESCE(?, agent_ws_url),
         ssh_host = COALESCE(?, ssh_host),
         ssh_port = COALESCE(?, ssh_port),
         ssh_user = COALESCE(?, ssh_user),
         ssh_auth_type = COALESCE(?, ssh_auth_type),
         ssh_password_enc = CASE WHEN ? THEN ? ELSE ssh_password_enc END,
         ssh_key_enc = CASE WHEN ? THEN ? ELSE ssh_key_enc END,
         expires_at = CASE WHEN ? THEN ? ELSE expires_at END,
         billing_anchor_day = CASE WHEN billing_anchor_day = 0 AND ? THEN COALESCE(?, billing_anchor_day) ELSE billing_anchor_day END,
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
    body.data.sshHost != null ? String(body.data.sshHost).trim() : null,
    body.data.sshPort != null ? Number(body.data.sshPort) : null,
    body.data.sshUser != null ? String(body.data.sshUser).trim() : null,
    body.data.sshAuthType ?? null,
    hasSshPassword ? 1 : 0,
    sshPasswordEnc,
    hasSshKey ? 1 : 0,
    sshKeyEnc,
    hasExpiresAt ? 1 : 0,
    body.data.expiresAt ?? null,
    hasExpiresAt ? 1 : 0,
    anchorDay,
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

app.get("/api/machines/:id/uptime", requireAuth, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "bad_id" });

  const row = db.prepare("SELECT id FROM machines WHERE id = ?").get(id) as { id: number } | undefined;
  if (!row) return res.status(404).json({ error: "not_found" });

  const hours = Number((req.query as any).hours ?? 24);
  const bucketMin = Number((req.query as any).bucketMin ?? 5);
  const offlineAfterMin = Number(getSetting("telegram_offline_after_min") ?? "5");

  const payload = computeUptimeBuckets(db, {
    machineId: id,
    hours,
    bucketMin,
    offlineAfterMin: Number.isFinite(offlineAfterMin) ? offlineAfterMin : 5,
  });

  res.json(payload);
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
         tcp_conn as tcpConn, udp_conn as udpConn,
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
attachWebSockets({ server, db, jwtSecret: env.JWT_SECRET, agentKeySecret });

server.listen(env.PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`yaws server listening on http://localhost:${env.PORT}`);
});

try {
  const users = (db.prepare("SELECT COUNT(*) as c FROM users").get() as any)?.c ?? 0;
  const machines = (db.prepare("SELECT COUNT(*) as c FROM machines").get() as any)?.c ?? 0;
  const metrics = (db.prepare("SELECT COUNT(*) as c FROM metrics").get() as any)?.c ?? 0;
  // eslint-disable-next-line no-console
  console.log(`[db] path=${env.DATABASE_PATH} users=${users} machines=${machines} metrics=${metrics}`);
} catch (e) {
  // eslint-disable-next-line no-console
  console.error("[db] self-check failed", e);
}

startMetricsPruner();
startTelegramNotifier();

const BootstrapSchema = z.object({ username: z.string().min(1), password: z.string().min(6) });
const LoginSchema = z.object({ username: z.string().min(1), password: z.string().min(1) });
const MachineCreateSchema = z.object({
  name: z.string().min(1),
  notes: z.string().optional(),
  groupName: z.string().max(64).optional(),
  intervalSec: z.number().int().min(2).max(3600).default(5),
  agentKey: z.string().min(8).optional(),
  agentWsUrl: z.string().optional(),
  sshHost: z.string().max(255).optional(),
  sshPort: z.number().int().min(1).max(65535).optional(),
  sshUser: z.string().max(64).optional(),
  sshAuthType: z.enum(["password", "key"]).optional(),
  sshPassword: z.string().max(4096).optional(),
  sshPrivateKey: z.string().max(20000).optional(),
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
  sshHost: z.string().max(255).optional(),
  sshPort: z.number().int().min(1).max(65535).optional(),
  sshUser: z.string().max(64).optional(),
  sshAuthType: z.enum(["password", "key"]).optional(),
  sshPassword: z.string().max(4096).optional(),
  sshPrivateKey: z.string().max(20000).optional(),
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

type TelegramConfig = {
  enabled: boolean;
  token: string;
  chatId: string;
  offlineAfterMin: number;
  expiryWarnDays: number;
  notifyOffline: boolean;
  notifyOnline: boolean;
  notifyExpiry: boolean;
};

function loadTelegramConfig(): TelegramConfig {
  const tokenEnc = getSetting("telegram_token_enc");
  const token = tokenEnc ? decryptText(tokenEnc, agentKeySecret) : env.TELEGRAM_BOT_TOKEN ?? "";
  const chatId = (getSetting("telegram_chat_id") ?? env.TELEGRAM_CHAT_ID ?? "").trim();
  const enabledRaw = getSetting("telegram_enabled");
  const enabled = enabledRaw != null ? enabledRaw === "1" : !!(token && chatId);

  const offlineAfterMin = Number(getSetting("telegram_offline_after_min") ?? "5");
  const expiryWarnDays = Number(getSetting("telegram_expiry_warn_days") ?? "10");
  const notifyOffline = (getSetting("telegram_notify_offline") ?? "1") === "1";
  const notifyOnline = (getSetting("telegram_notify_online") ?? "1") === "1";
  const notifyExpiry = (getSetting("telegram_notify_expiry") ?? "1") === "1";

  return {
    enabled: enabled && !!(token && chatId),
    token,
    chatId,
    offlineAfterMin: Number.isFinite(offlineAfterMin) ? Math.max(1, offlineAfterMin) : 5,
    expiryWarnDays: Number.isFinite(expiryWarnDays) ? Math.max(0, expiryWarnDays) : 10,
    notifyOffline,
    notifyOnline,
    notifyExpiry,
  };
}

async function sendTelegram(cfg: TelegramConfig, text: string) {
  const url = `https://api.telegram.org/bot${cfg.token}/sendMessage`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 12_000).unref();
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: cfg.chatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
      signal: ctrl.signal,
    });
    const j: any = await res.json().catch(() => null);
    if (!res.ok) {
      const desc = String(j?.description ?? "").toLowerCase();
      if (res.status === 401) throw new Error("telegram_unauthorized");
      if (res.status === 403) {
        if (desc.includes("blocked")) throw new Error("telegram_blocked");
        if (desc.includes("can't initiate") || desc.includes("cant initiate")) throw new Error("telegram_cant_initiate");
        if (desc.includes("not a member")) throw new Error("telegram_not_in_chat");
        throw new Error("telegram_forbidden");
      }
      if (res.status === 400) throw new Error("telegram_bad_request");
      throw new Error(`telegram_http_${res.status}`);
    }
    if (!j || j.ok !== true) throw new Error("telegram_bad_response");
  } finally {
    clearTimeout(t);
  }
}

function fmtDateTime(ms: number | null) {
  if (!ms) return "—";
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return String(ms);
  }
}

function daysLeftUtc(expiresAt: number, now: number) {
  return Math.floor((expiresAt - now) / (24 * 3600 * 1000));
}

function ymdUtc(ms: number) {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

function startTelegramNotifier() {
  const intervalMs = 60_000;
  const tick = async () => {
    if (isRestoring) return;
    let cfg: TelegramConfig;
    try {
      cfg = loadTelegramConfig();
    } catch {
      return;
    }
    if (!cfg.enabled) return;

    const now = Date.now();
    const offlineAfterMs = cfg.offlineAfterMin * 60_000;
    const cooldownMs = 5 * 60_000;
    const today = ymdUtc(now);
    const machines = db
      .prepare(
        `SELECT
           id, name, online, last_seen_at as lastSeenAt,
           expires_at as expiresAt,
           purchase_amount_cents as purchaseAmountCents,
           billing_cycle as billingCycle,
           auto_renew as autoRenew
         FROM machines
         ORDER BY sort_order ASC, id ASC`
      )
      .all() as Array<{
      id: number;
      name: string;
      online: 0 | 1;
      lastSeenAt: number | null;
      expiresAt: number | null;
      purchaseAmountCents: number;
      billingCycle: string;
      autoRenew: 0 | 1;
    }>;

    const getNotif = db.prepare(
      `SELECT
         machine_id as machineId,
         last_online as lastOnline,
         offline_notified_at as offlineNotifiedAt,
         online_notified_at as onlineNotifiedAt,
         expiry_warn_date as expiryWarnDate,
         expired_notified_at as expiredNotifiedAt
       FROM machine_notifications WHERE machine_id = ?`
    );
    const upsertNotif = db.prepare(
      `INSERT INTO machine_notifications (
         machine_id, last_online, offline_notified_at, online_notified_at, expiry_warn_date, expired_notified_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(machine_id) DO UPDATE SET
         last_online = excluded.last_online,
         offline_notified_at = excluded.offline_notified_at,
         online_notified_at = excluded.online_notified_at,
         expiry_warn_date = excluded.expiry_warn_date,
         expired_notified_at = excluded.expired_notified_at,
         updated_at = excluded.updated_at`
    );

    const offlineEvents: Array<{ id: number; name: string; lastSeenAt: number | null }> = [];
    const onlineEvents: Array<{ id: number; name: string; lastSeenAt: number | null }> = [];
    const expiryWarnEvents: Array<{
      id: number;
      name: string;
      left: number;
      expiresAt: number;
      billingCycle: string;
      autoRenew: 0 | 1;
    }> = [];
    const expiredEvents: Array<{ id: number; name: string; expiresAt: number }> = [];

    const pendingNotifUpdates = new Map<
      number,
      {
        lastOnline: 0 | 1;
        offlineNotifiedAt: number;
        onlineNotifiedAt: number;
        expiryWarnDate: string;
        expiredNotifiedAt: number;
      }
    >();

    const saveNow = (
      machineId: number,
      lastOnline: 0 | 1,
      offlineNotifiedAt: number,
      onlineNotifiedAt: number,
      expiryWarnDate: string,
      expiredNotifiedAt: number
    ) => {
      upsertNotif.run(machineId, lastOnline, offlineNotifiedAt, onlineNotifiedAt, expiryWarnDate, expiredNotifiedAt, now);
    };

    for (const m of machines) {
      const derivedOnline = m.lastSeenAt != null && now - m.lastSeenAt <= offlineAfterMs;
      const row = getNotif.get(m.id) as
        | {
            machineId: number;
            lastOnline: number;
            offlineNotifiedAt: number;
            onlineNotifiedAt: number;
            expiryWarnDate: string;
            expiredNotifiedAt: number;
          }
        | undefined;

      if (!row) {
        saveNow(m.id, derivedOnline ? 1 : 0, 0, 0, "", 0);
        continue;
      }

      const current = {
        lastOnline: (row.lastOnline ? 1 : 0) as 0 | 1,
        offlineNotifiedAt: row.offlineNotifiedAt ?? 0,
        onlineNotifiedAt: row.onlineNotifiedAt ?? 0,
        expiryWarnDate: row.expiryWarnDate ?? "",
        expiredNotifiedAt: row.expiredNotifiedAt ?? 0,
      };

      if (derivedOnline && current.lastOnline === 0) {
        if (!cfg.notifyOnline) {
          saveNow(m.id, 1, current.offlineNotifiedAt, current.onlineNotifiedAt, current.expiryWarnDate, current.expiredNotifiedAt);
          current.lastOnline = 1;
        } else if (now - current.onlineNotifiedAt > cooldownMs) {
          onlineEvents.push({ id: m.id, name: m.name, lastSeenAt: m.lastSeenAt });
          pendingNotifUpdates.set(m.id, {
            ...current,
            lastOnline: 1,
            onlineNotifiedAt: now,
          });
        } else {
          saveNow(m.id, 1, current.offlineNotifiedAt, current.onlineNotifiedAt, current.expiryWarnDate, current.expiredNotifiedAt);
          current.lastOnline = 1;
        }
      } else if (!derivedOnline && current.lastOnline === 1) {
        if (!cfg.notifyOffline) {
          saveNow(m.id, 0, current.offlineNotifiedAt, current.onlineNotifiedAt, current.expiryWarnDate, current.expiredNotifiedAt);
          current.lastOnline = 0;
        } else if (now - current.offlineNotifiedAt > cooldownMs) {
          offlineEvents.push({ id: m.id, name: m.name, lastSeenAt: m.lastSeenAt });
          pendingNotifUpdates.set(m.id, {
            ...current,
            lastOnline: 0,
            offlineNotifiedAt: now,
          });
        } else {
          saveNow(m.id, 0, current.offlineNotifiedAt, current.onlineNotifiedAt, current.expiryWarnDate, current.expiredNotifiedAt);
          current.lastOnline = 0;
        }
      }

      if (cfg.notifyExpiry && m.expiresAt != null) {
        const left = daysLeftUtc(m.expiresAt, now);
        if (left < 0) {
          if (current.expiredNotifiedAt === 0) {
            expiredEvents.push({ id: m.id, name: m.name, expiresAt: m.expiresAt });
            pendingNotifUpdates.set(m.id, {
              ...(pendingNotifUpdates.get(m.id) ?? current),
              expiredNotifiedAt: now,
            });
          }
        } else if (cfg.expiryWarnDays > 0 && left <= cfg.expiryWarnDays) {
          if (current.expiryWarnDate !== today) {
            expiryWarnEvents.push({
              id: m.id,
              name: m.name,
              left,
              expiresAt: m.expiresAt,
              billingCycle: m.billingCycle,
              autoRenew: m.autoRenew,
            });
            pendingNotifUpdates.set(m.id, {
              ...(pendingNotifUpdates.get(m.id) ?? current),
              expiryWarnDate: today,
            });
          }
        }
      }
    }

    const sendChunked = async (title: string, lines: string[]) => {
      if (lines.length === 0) return;
      const maxLen = 3500;
      let chunk = `<b>${escapeHtml(title)}</b>\n`;
      for (const line of lines) {
        if (chunk.length + line.length + 1 > maxLen) {
          await sendTelegram(cfg, chunk);
          chunk = `<b>${escapeHtml(title)}</b>\n${line}`;
          continue;
        }
        chunk += line;
      }
      if (chunk.trim()) await sendTelegram(cfg, chunk);
    };

    const offlineLines = offlineEvents.map(
      (e) =>
        `⚠️ <b>${escapeHtml(e.name)}</b> (ID ${e.id}) 离线 · last seen ${escapeHtml(fmtDateTime(e.lastSeenAt))}\n`
    );
    const onlineLines = onlineEvents.map(
      (e) =>
        `✅ <b>${escapeHtml(e.name)}</b> (ID ${e.id}) 在线 · last seen ${escapeHtml(fmtDateTime(e.lastSeenAt))}\n`
    );
    const expiryWarnLines = expiryWarnEvents.map(
      (e) =>
        `⏳ <b>${escapeHtml(e.name)}</b> (ID ${e.id}) 剩余 <b>${e.left}</b> 天 · 到期 ${escapeHtml(
          new Date(e.expiresAt).toLocaleDateString()
        )} · ${escapeHtml(String(e.billingCycle))}${e.autoRenew ? " · 自动续费" : ""}\n`
    );
    const expiredLines = expiredEvents.map(
      (e) =>
        `🟥 <b>${escapeHtml(e.name)}</b> (ID ${e.id}) 已到期 · 到期 ${escapeHtml(new Date(e.expiresAt).toLocaleDateString())}\n`
    );

    try {
      await sendChunked("机器离线", offlineLines);
      await sendChunked("机器恢复在线", onlineLines);
      await sendChunked("即将到期提醒", expiryWarnLines);
      await sendChunked("到期提醒", expiredLines);
    } catch {
      return;
    }

    for (const [machineId, u] of pendingNotifUpdates) {
      saveNow(machineId, u.lastOnline, u.offlineNotifiedAt, u.onlineNotifiedAt, u.expiryWarnDate, u.expiredNotifiedAt);
    }
  };

  const safeTick = () => {
    tick().catch((e) => {
      // eslint-disable-next-line no-console
      console.error("[telegram] notifier tick failed", e);
    });
  };
  safeTick();
  setInterval(safeTick, intervalMs).unref();
}

function escapeHtml(s: string) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
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
