import type { IncomingMessage } from "node:http";
import WebSocket, { WebSocketServer } from "ws";
import { z } from "zod";
import type { Db } from "./db.js";
import { verifyToken } from "./auth.js";
import bcrypt from "bcryptjs";
import { Client as SshClient } from "ssh2";
import { decryptText } from "./crypto.js";

type UiClient = {
  ws: WebSocket;
  userId: number;
  subscribedMachineIds: Set<number> | null;
};

type AgentClient = {
  ws: WebSocket;
  machineId: number;
};

export function attachWebSockets(opts: {
  server: import("node:http").Server;
  db: Db;
  jwtSecret: string;
  agentKeySecret: string;
}) {
  const wss = new WebSocketServer({ noServer: true });
  const uiClients = new Set<UiClient>();
  const agents = new Map<number, AgentClient>();

  opts.server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    if (url.pathname !== "/ws/ui" && url.pathname !== "/ws/agent" && url.pathname !== "/ws/ssh") {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  wss.on("connection", (ws, req: IncomingMessage) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    if (url.pathname === "/ws/ui") handleUi(ws, req, url);
    else if (url.pathname === "/ws/agent") handleAgent(ws, req, url);
    else handleSsh(ws, req, url);
  });

  function handleSsh(ws: WebSocket, _req: IncomingMessage, url: URL) {
    const token = url.searchParams.get("token") ?? "";
    try {
      verifyToken(token, opts.jwtSecret);
    } catch {
      ws.close(1008, "invalid token");
      return;
    }

    let ssh: SshClient | null = null;
    let stream: any = null;
    let connected = false;

    const cleanup = () => {
      try {
        stream?.end?.();
      } catch {
        // ignore
      }
      try {
        ssh?.end();
      } catch {
        // ignore
      }
      stream = null;
      ssh = null;
      connected = false;
    };

    ws.on("close", cleanup);

    ws.on("message", (data) => {
      let msg: any;
      try {
        msg = SshMessageSchema.parse(JSON.parse(data.toString("utf8")));
      } catch {
        ws.send(JSON.stringify({ type: "error", error: "bad_message" }));
        return;
      }

      if (msg.type === "connect") {
        if (connected) return;
        const row = opts.db
          .prepare(
            `SELECT
               id,
               ssh_host as sshHost,
               ssh_port as sshPort,
               ssh_user as sshUser,
               ssh_auth_type as sshAuthType,
               ssh_password_enc as sshPasswordEnc,
               ssh_key_enc as sshKeyEnc
             FROM machines
             WHERE id = ?`
          )
          .get(msg.machineId) as
          | {
              id: number;
              sshHost: string;
              sshPort: number;
              sshUser: string;
              sshAuthType: string;
              sshPasswordEnc: string;
              sshKeyEnc: string;
            }
          | undefined;
        if (!row) {
          ws.send(JSON.stringify({ type: "error", error: "not_found" }));
          return;
        }

        const host = (row.sshHost ?? "").trim();
        const port = Number(row.sshPort ?? 22);
        const username = (row.sshUser ?? "").trim();
        const authType = (row.sshAuthType ?? "password").trim();
        if (!host || !username || !Number.isFinite(port) || port <= 0 || port > 65535) {
          ws.send(JSON.stringify({ type: "error", error: "ssh_not_configured" }));
          return;
        }

        const cols = Number(msg.cols ?? 120);
        const rows = Number(msg.rows ?? 30);

        ssh = new SshClient();
        connected = true;

        ssh.on("ready", () => {
          try {
            ws.send(JSON.stringify({ type: "ready" }));
          } catch {
            // ignore
          }
          ssh!.shell(
            {
              term: "xterm-256color",
              cols: Math.max(20, Math.min(500, cols)),
              rows: Math.max(5, Math.min(200, rows)),
            },
            (err: any, s: any) => {
              if (err) {
                ws.send(JSON.stringify({ type: "error", error: "shell_failed" }));
                ws.close(1011, "shell_failed");
                cleanup();
                return;
              }
              stream = s;
              stream.on("data", (chunk: Buffer) => {
                try {
                  ws.send(JSON.stringify({ type: "output", dataB64: chunk.toString("base64") }));
                } catch {
                  // ignore
                }
              });
              stream.on("close", () => {
                try {
                  ws.send(JSON.stringify({ type: "exit" }));
                } catch {
                  // ignore
                }
                ws.close(1000, "exit");
                cleanup();
              });
            }
          );
        });

        ssh.on("error", (e: any) => {
          try {
            ws.send(JSON.stringify({ type: "error", error: e?.level ? `ssh_${e.level}` : "ssh_error" }));
          } catch {
            // ignore
          }
          try {
            ws.close(1011, "ssh_error");
          } catch {
            // ignore
          }
          cleanup();
        });

        try {
          const common: any = {
            host,
            port,
            username,
            readyTimeout: 15_000,
            keepaliveInterval: 10_000,
            keepaliveCountMax: 3,
            hostVerifier: () => true,
          };
          if (authType === "key") {
            if (!row.sshKeyEnc) {
              ws.send(JSON.stringify({ type: "error", error: "ssh_key_missing" }));
              cleanup();
              return;
            }
            const key = decryptText(row.sshKeyEnc, opts.agentKeySecret);
            ssh.connect({ ...common, privateKey: key });
          } else {
            if (!row.sshPasswordEnc) {
              ws.send(JSON.stringify({ type: "error", error: "ssh_password_missing" }));
              cleanup();
              return;
            }
            const password = decryptText(row.sshPasswordEnc, opts.agentKeySecret);
            ssh.connect({ ...common, password });
          }
        } catch {
          ws.send(JSON.stringify({ type: "error", error: "ssh_connect_failed" }));
          cleanup();
        }
        return;
      }

      if (msg.type === "input") {
        if (!stream) return;
        try {
          const buf = Buffer.from(msg.dataB64, "base64");
          stream.write(buf);
        } catch {
          // ignore
        }
        return;
      }

      if (msg.type === "resize") {
        if (!stream?.setWindow) return;
        const cols = Math.max(20, Math.min(500, Number(msg.cols)));
        const rows = Math.max(5, Math.min(200, Number(msg.rows)));
        try {
          stream.setWindow(rows, cols, 0, 0);
        } catch {
          // ignore
        }
        return;
      }
    });
  }

  function handleUi(ws: WebSocket, _req: IncomingMessage, url: URL) {
    const token = url.searchParams.get("token") ?? "";
    let user: ReturnType<typeof verifyToken>;
    try {
      user = verifyToken(token, opts.jwtSecret);
    } catch {
      ws.close(1008, "invalid token");
      return;
    }

    const client: UiClient = { ws, userId: user.id, subscribedMachineIds: null };
    uiClients.add(client);

    ws.on("message", (data) => {
      try {
        const msg = UiMessageSchema.parse(JSON.parse(data.toString("utf8")));
        if (msg.type === "subscribe") {
          client.subscribedMachineIds = new Set(msg.machineIds);
          ws.send(JSON.stringify({ type: "subscribed", machineIds: msg.machineIds }));
        }
      } catch {
        ws.send(JSON.stringify({ type: "error", error: "bad_message" }));
      }
    });

    ws.on("close", () => uiClients.delete(client));
    ws.send(JSON.stringify({ type: "hello", userId: user.id }));
  }

  function handleAgent(ws: WebSocket, _req: IncomingMessage, _url: URL) {
    let machineId: number | null = null;

    ws.on("message", (data) => {
      try {
        const msg = AgentMessageSchema.parse(JSON.parse(data.toString("utf8")));
        if (msg.type === "hello") {
          const row = opts.db
            .prepare("SELECT id, agent_key_hash, interval_sec FROM machines WHERE id = ?")
            .get(msg.machineId) as { id: number; agent_key_hash: string; interval_sec: number } | undefined;
          if (!row) {
            ws.send(JSON.stringify({ type: "error", error: "unknown_machine" }));
            ws.close(1008, "unknown machine");
            return;
          }
          if (!bcrypt.compareSync(msg.key, row.agent_key_hash)) {
            ws.send(JSON.stringify({ type: "error", error: "bad_key" }));
            ws.close(1008, "bad key");
            return;
          }

          machineId = row.id;
          agents.set(machineId, { ws, machineId });
          opts.db
            .prepare(
              `UPDATE machines
               SET online = 1,
                   last_seen_at = ?,
                   hostname = COALESCE(NULLIF(?, ''), hostname),
                   os_name = COALESCE(NULLIF(?, ''), os_name),
                   os_version = COALESCE(NULLIF(?, ''), os_version),
                   arch = COALESCE(NULLIF(?, ''), arch),
                   kernel_version = COALESCE(NULLIF(?, ''), kernel_version),
                   cpu_model = COALESCE(NULLIF(?, ''), cpu_model),
                   cpu_cores = COALESCE(?, cpu_cores)
               WHERE id = ?`
            )
            .run(
              Date.now(),
              msg.hostname ?? "",
              msg.osName ?? "",
              msg.osVersion ?? "",
              msg.arch ?? "",
              msg.kernelVersion ?? "",
              msg.cpuModel ?? "",
              msg.cpuCores ?? null,
              machineId
            );

          broadcastUi({
            type: "machine_status",
            machineId,
            online: true,
            lastSeenAt: Date.now(),
          });
          ws.send(JSON.stringify({ type: "hello_ok", machineId, intervalSec: row.interval_sec }));
          return;
        }

        if (msg.type === "metrics") {
          if (machineId == null) {
            ws.send(JSON.stringify({ type: "error", error: "not_helloed" }));
            return;
          }

          const at = msg.at ?? Date.now();
          const netRx = msg.net?.rxBytes ?? 0;
          const netTx = msg.net?.txBytes ?? 0;
          const tcpConn = msg.conn?.tcp ?? 0;
          const udpConn = msg.conn?.udp ?? 0;
          const l1 = msg.load?.l1 ?? 0;
          const l5 = msg.load?.l5 ?? 0;
          const l15 = msg.load?.l15 ?? 0;
          opts.db
            .prepare(
              `INSERT INTO metrics (
                 machine_id, at,
                 cpu_usage, mem_used, mem_total, disk_used, disk_total,
                 net_rx_bytes, net_tx_bytes,
                 tcp_conn, udp_conn,
                 load_1, load_5, load_15
                )
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            )
            .run(
              machineId,
              at,
              msg.cpu.usage,
              msg.mem.used,
              msg.mem.total,
              msg.disk.used,
              msg.disk.total,
              netRx,
              netTx,
              tcpConn,
              udpConn,
              l1,
              l5,
              l15
            );
          opts.db
            .prepare("UPDATE machines SET last_seen_at = ?, online = 1 WHERE id = ?")
            .run(at, machineId);

          const monthTraffic = msg.net ? updateBillingMonthTraffic(opts.db, machineId, at, netRx, netTx) : null;

          broadcastUi({
            type: "metrics",
            machineId,
            metric: {
              at,
              cpu: msg.cpu,
              mem: msg.mem,
              disk: msg.disk,
              net: msg.net,
              conn: msg.conn,
              load: msg.load,
            },
            ...(monthTraffic ? { monthTraffic } : {}),
          });
        }
      } catch {
        ws.send(JSON.stringify({ type: "error", error: "bad_message" }));
      }
    });

    ws.on("close", () => {
      if (machineId == null) return;
      const agent = agents.get(machineId);
      if (agent?.ws === ws) agents.delete(machineId);
      opts.db.prepare("UPDATE machines SET online = 0 WHERE id = ?").run(machineId);
      broadcastUi({ type: "machine_status", machineId, online: false, lastSeenAt: Date.now() });
    });
  }

  function broadcastUi(message: unknown) {
    const payload = JSON.stringify(message);
    for (const client of uiClients) {
      if (client.ws.readyState !== WebSocket.OPEN) continue;
      if (message && typeof message === "object" && "machineId" in (message as any)) {
        const machineId = (message as any).machineId as number;
        if (client.subscribedMachineIds && !client.subscribedMachineIds.has(machineId)) continue;
      }
      client.ws.send(payload);
    }
  }
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

function updateBillingMonthTraffic(db: Db, machineId: number, at: number, netRx: number, netTx: number) {
  const now = Date.now();
  const state = db
    .prepare(
      `SELECT
         anchor_day as anchorDay,
         period_key as periodKey,
         start_at as startAt,
         end_at as endAt,
         last_at as lastAt,
         last_rx_bytes as lastRx,
         last_tx_bytes as lastTx,
         usage_rx_bytes as usageRx,
         usage_tx_bytes as usageTx
       FROM traffic_cycles_state WHERE machine_id = ?`
    )
    .get(machineId) as
    | {
        anchorDay: number;
        periodKey: string;
        startAt: number;
        endAt: number;
        lastAt: number;
        lastRx: number;
        lastTx: number;
        usageRx: number;
        usageTx: number;
      }
    | undefined;

  let anchorDay = state?.anchorDay ?? 0;
  if (!anchorDay) {
    const row = db
      .prepare("SELECT billing_anchor_day as anchorDay FROM machines WHERE id = ?")
      .get(machineId) as { anchorDay: number } | undefined;
    anchorDay = row?.anchorDay ?? 1;
    if (!anchorDay) anchorDay = 1;
  }

  const bounds = billingMonthBoundsUtc(at, anchorDay);

  if (!state || state.periodKey !== bounds.periodKey) {
    db.prepare(
      `INSERT INTO traffic_cycles_state (
         machine_id, anchor_day, period_key, start_at, end_at,
         last_at, last_rx_bytes, last_tx_bytes, usage_rx_bytes, usage_tx_bytes, updated_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?)
       ON CONFLICT(machine_id) DO UPDATE SET
         anchor_day = excluded.anchor_day,
         period_key = excluded.period_key,
         start_at = excluded.start_at,
         end_at = excluded.end_at,
         last_at = excluded.last_at,
         last_rx_bytes = excluded.last_rx_bytes,
         last_tx_bytes = excluded.last_tx_bytes,
         usage_rx_bytes = 0,
         usage_tx_bytes = 0,
         updated_at = excluded.updated_at`
    ).run(machineId, bounds.anchorDay, bounds.periodKey, bounds.startAt, bounds.endAt, at, netRx, netTx, now);

    db.prepare(
      `INSERT INTO traffic_cycles (machine_id, period_key, start_at, end_at, rx_bytes, tx_bytes, updated_at)
       VALUES (?, ?, ?, ?, 0, 0, ?)
       ON CONFLICT(machine_id, period_key) DO UPDATE SET
         start_at = excluded.start_at,
         end_at = excluded.end_at,
         updated_at = excluded.updated_at`
    ).run(machineId, bounds.periodKey, bounds.startAt, bounds.endAt, now);

    return { month: bounds.periodKey, startAt: bounds.startAt, endAt: bounds.endAt, rxBytes: 0, txBytes: 0, updatedAt: now };
  }

  if (at < state.lastAt) {
    return { month: state.periodKey, startAt: state.startAt, endAt: state.endAt, rxBytes: state.usageRx, txBytes: state.usageTx, updatedAt: state.lastAt };
  }

  let usageRx = state.usageRx;
  let usageTx = state.usageTx;

  if (netRx >= state.lastRx) usageRx += netRx - state.lastRx;
  else usageRx += netRx;

  if (netTx >= state.lastTx) usageTx += netTx - state.lastTx;
  else usageTx += netTx;

  db.prepare(
    `UPDATE traffic_cycles_state
     SET period_key = ?, start_at = ?, end_at = ?,
         last_at = ?, last_rx_bytes = ?, last_tx_bytes = ?,
         usage_rx_bytes = ?, usage_tx_bytes = ?, updated_at = ?
     WHERE machine_id = ?`
  ).run(bounds.periodKey, bounds.startAt, bounds.endAt, at, netRx, netTx, usageRx, usageTx, now, machineId);

  db.prepare(
    `INSERT INTO traffic_cycles (machine_id, period_key, start_at, end_at, rx_bytes, tx_bytes, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(machine_id, period_key) DO UPDATE SET
       start_at = excluded.start_at,
       end_at = excluded.end_at,
       rx_bytes = excluded.rx_bytes,
       tx_bytes = excluded.tx_bytes,
       updated_at = excluded.updated_at`
  ).run(machineId, bounds.periodKey, bounds.startAt, bounds.endAt, usageRx, usageTx, now);

  return { month: bounds.periodKey, startAt: bounds.startAt, endAt: bounds.endAt, rxBytes: usageRx, txBytes: usageTx, updatedAt: now };
}

function monthKeyUtc(at: number) {
  const d = new Date(at);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

function updateMonthlyTraffic(db: Db, machineId: number, at: number, netRx: number, netTx: number) {
  const now = Date.now();
  const month = monthKeyUtc(at);
  const state = db
    .prepare(
      `SELECT
         month,
         last_at as lastAt,
         last_rx_bytes as lastRx,
         last_tx_bytes as lastTx,
         usage_rx_bytes as usageRx,
         usage_tx_bytes as usageTx
       FROM traffic_monthly_state WHERE machine_id = ?`
    )
    .get(machineId) as
    | { month: string; lastAt: number; lastRx: number; lastTx: number; usageRx: number; usageTx: number }
    | undefined;

  if (!state || state.month !== month) {
    db.prepare(
      `INSERT INTO traffic_monthly_state (machine_id, month, last_at, last_rx_bytes, last_tx_bytes, usage_rx_bytes, usage_tx_bytes, updated_at)
       VALUES (?, ?, ?, ?, ?, 0, 0, ?)
       ON CONFLICT(machine_id) DO UPDATE SET
         month = excluded.month,
         last_at = excluded.last_at,
         last_rx_bytes = excluded.last_rx_bytes,
         last_tx_bytes = excluded.last_tx_bytes,
         usage_rx_bytes = 0,
         usage_tx_bytes = 0,
         updated_at = excluded.updated_at`
    ).run(machineId, month, at, netRx, netTx, now);

    db.prepare(
      `INSERT INTO traffic_monthly (machine_id, month, rx_bytes, tx_bytes, updated_at)
       VALUES (?, ?, 0, 0, ?)
       ON CONFLICT(machine_id, month) DO UPDATE SET updated_at = excluded.updated_at`
    ).run(machineId, month, now);

    return { month, rxBytes: 0, txBytes: 0, updatedAt: now };
  }

  if (at < state.lastAt) {
    return { month, rxBytes: state.usageRx, txBytes: state.usageTx, updatedAt: state.lastAt };
  }

  let usageRx = state.usageRx;
  let usageTx = state.usageTx;

  if (netRx >= state.lastRx) usageRx += netRx - state.lastRx;
  else usageRx += netRx;

  if (netTx >= state.lastTx) usageTx += netTx - state.lastTx;
  else usageTx += netTx;

  db.prepare(
    `UPDATE traffic_monthly_state
     SET last_at = ?, last_rx_bytes = ?, last_tx_bytes = ?,
         usage_rx_bytes = ?, usage_tx_bytes = ?, updated_at = ?
     WHERE machine_id = ?`
  ).run(at, netRx, netTx, usageRx, usageTx, now, machineId);

  db.prepare(
    `INSERT INTO traffic_monthly (machine_id, month, rx_bytes, tx_bytes, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(machine_id, month) DO UPDATE SET
       rx_bytes = excluded.rx_bytes,
       tx_bytes = excluded.tx_bytes,
       updated_at = excluded.updated_at`
  ).run(machineId, month, usageRx, usageTx, now);

  return { month, rxBytes: usageRx, txBytes: usageTx, updatedAt: now };
}

const UiMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("subscribe"), machineIds: z.array(z.number().int().positive()) }),
]);

const SshMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("connect"),
    machineId: z.number().int().positive(),
    cols: z.number().int().positive().max(500).optional(),
    rows: z.number().int().positive().max(200).optional(),
  }),
  z.object({ type: z.literal("input"), dataB64: z.string().min(1) }),
  z.object({ type: z.literal("resize"), cols: z.number().int().positive().max(500), rows: z.number().int().positive().max(200) }),
]);

const AgentMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("hello"),
    machineId: z.number().int().positive(),
    key: z.string().min(1),
    hostname: z.string().optional(),
    osName: z.string().optional(),
    osVersion: z.string().optional(),
    arch: z.string().optional(),
    kernelVersion: z.string().optional(),
    cpuModel: z.string().optional(),
    cpuCores: z.number().int().nonnegative().optional(),
  }),
  z.object({
    type: z.literal("metrics"),
    at: z.number().int().optional(),
    cpu: z.object({ usage: z.number().min(0).max(1) }),
    mem: z.object({ used: z.number().int().nonnegative(), total: z.number().int().positive() }),
    disk: z.object({ used: z.number().int().nonnegative(), total: z.number().int().positive() }),
    net: z
      .object({ rxBytes: z.number().int().nonnegative(), txBytes: z.number().int().nonnegative() })
      .optional(),
    conn: z.object({ tcp: z.number().int().nonnegative(), udp: z.number().int().nonnegative() }).optional(),
    load: z.object({ l1: z.number().nonnegative(), l5: z.number().nonnegative(), l15: z.number().nonnegative() }).optional(),
  }),
]);
