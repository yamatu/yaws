import type { IncomingMessage } from "node:http";
import WebSocket, { WebSocketServer } from "ws";
import { z } from "zod";
import type { Db } from "./db.js";
import { verifyAgentKey, verifyToken } from "./auth.js";
import { currentUser } from "./http.js";
import { terminalSocket, type TerminalSession } from "./ssh-terminal.js";
import { randomUUID } from "node:crypto";
import type { PingResult } from "./ping.js";

type UiClient = {
  ws: WebSocket;
  userId: number;
  subscribedMachineIds: Set<number> | null;
};

type AgentClient = {
  ws: WebSocket;
  machineId: number;
  capabilities: string[];
};

function browserToken(req: IncomingMessage) {
  const protocol = req.headers["sec-websocket-protocol"]?.split(",").map((p) => p.trim()).find((p) => p.startsWith("bearer."));
  return protocol?.slice(7) ?? "";
}

export function attachWebSockets(opts: {
  server: import("node:http").Server;
  db: Db;
  jwtSecret: string;
  agentKeySecret: string;
  previousAgentKeySecret?: string;
  corsOrigin?: string;
}) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024, handleProtocols: (protocols) => protocols.has("yaws") ? "yaws" : false });
  const uiClients = new Set<UiClient>();
  const agents = new Map<number, AgentClient>();
  const sshSessions = new Map<string, TerminalSession>();
  const browserUsers = new Map<WebSocket, number>();
  const browserTokens = new Map<WebSocket, string>();
  opts.db.prepare("UPDATE ssh_sessions SET ended_at = ?, status = 'closed', reason = 'server_restarted' WHERE ended_at IS NULL").run(Date.now());
  const pendingPings = new Map<string, { ws: WebSocket; finish: (result: PingResult) => void }>();
  function probeMachine(machineId: number, target: string, signal?: AbortSignal): Promise<PingResult> {
    const agent = agents.get(machineId);
    const failed = (error: string) => ({ at: Date.now(), latencyMs: null, error });
    if (!agent || agent.ws.readyState !== WebSocket.OPEN) return Promise.resolve(failed("agent_offline"));
    if (!agent.capabilities.includes("ping-v1")) return Promise.resolve(failed("agent_upgrade_required"));
    if (pendingPings.size >= 32 || agent.ws.bufferedAmount > 256 * 1024) return Promise.resolve(failed("agent_busy"));
    return new Promise((resolve) => {
      const requestId = randomUUID();
      const abort = () => finish(failed("cancelled"));
      const timer = setTimeout(() => finish(failed("agent_timeout")), 7000);
      const finish = (result: PingResult) => { clearTimeout(timer); signal?.removeEventListener("abort", abort); pendingPings.delete(requestId); resolve(result); };
      pendingPings.set(requestId, { ws: agent.ws, finish });
      if (signal?.aborted) return abort();
      signal?.addEventListener("abort", abort, { once: true });
      agent.ws.send(JSON.stringify({ type: "ping", requestId, target }), (err) => { if (err) finish(failed("agent_offline")); });
    });
  }

  opts.server.on("upgrade", (req, socket, head) => {
    if (!opts.db.open) { socket.destroy(); return; }
    let url: URL;
    try { url = new URL(req.url ?? "/", `http://${req.headers.host}`); } catch { socket.destroy(); return; }
    if (wss.clients.size >= 1000) { socket.destroy(); return; }
    if (url.pathname !== "/ws/ui" && url.pathname !== "/ws/agent" && url.pathname !== "/ws/ssh") {
      socket.destroy();
      return;
    }

    // Hard reject before WebSocket upgrade for security.
    // This ensures unauthenticated clients can't even establish a WS connection.
    if (url.pathname === "/ws/ui" || url.pathname === "/ws/ssh") {
      const token = browserToken(req);
      const origin = req.headers.origin;
      let originOk = false;
      try { originOk = !!origin && (new URL(origin).host === req.headers.host || origin === opts.corsOrigin); } catch { originOk = false; }
      if (!originOk) { socket.destroy(); return; }
      if (!token) {
        socket.destroy();
        return;
      }
      try {
        const user = currentUser(opts.db, token, opts.jwtSecret);
        const row = opts.db
          .prepare("SELECT id, role FROM users WHERE id = ?")
          .get(user.id) as { id: number; role: string } | undefined;
        if (!row) {
          socket.destroy();
          return;
        }
        if (url.pathname === "/ws/ssh" && row.role !== "admin") {
          socket.destroy();
          return;
        }
      } catch {
        socket.destroy();
        return;
      }
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      if (url.pathname !== "/ws/agent") { browserUsers.set(ws, currentUser(opts.db, browserToken(req), opts.jwtSecret).id); browserTokens.set(ws, browserToken(req)); }
      ws.once("close", () => { browserUsers.delete(ws); browserTokens.delete(ws); });
      ws.on("error", () => ws.terminate());
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", (ws, req: IncomingMessage) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    if (url.pathname === "/ws/ui") handleUi(ws, req, url);
    else if (url.pathname === "/ws/agent") handleAgent(ws, req, url);
    else handleSsh(ws, req, url);
  });

  function handleSsh(ws: WebSocket, req: IncomingMessage, _url: URL) {
    try { terminalSocket(ws, opts.db, opts.agentKeySecret, currentUser(opts.db, browserToken(req), opts.jwtSecret), sshSessions); }
    catch { ws.close(1008, "invalid_token"); }
  }

  function handleUi(ws: WebSocket, _req: IncomingMessage, url: URL) {
    const token = browserToken(_req);
    let user: ReturnType<typeof verifyToken>;
    try {
      user = currentUser(opts.db, token, opts.jwtSecret);
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
    let authenticating = false;
    let lastMetricAt = 0;
    const authTimeout = setTimeout(() => {
      if (machineId == null) ws.close(1008, "hello timeout");
    }, 10_000);
    authTimeout.unref();

    ws.on("message", async (data) => {
      try {
        const msg = AgentMessageSchema.parse(JSON.parse(data.toString("utf8")));
        if (msg.type === "hello") {
          if (machineId != null || authenticating) {
            ws.close(1008, "duplicate hello");
            return;
          }
          authenticating = true;
          const row = opts.db
            .prepare("SELECT id, agent_key_hash, interval_sec FROM machines WHERE id = ? AND deleted_at IS NULL")
            .get(msg.machineId) as { id: number; agent_key_hash: string; interval_sec: number } | undefined;
          if (!row) {
            ws.send(JSON.stringify({ type: "error", error: "unknown_machine" }));
            ws.close(1008, "unknown machine");
            return;
          }
          let keyOk = await verifyAgentKey(msg.key, row.agent_key_hash, opts.agentKeySecret);
          if (
            !keyOk &&
            opts.previousAgentKeySecret &&
            opts.previousAgentKeySecret !== opts.agentKeySecret &&
            !row.agent_key_hash.startsWith("$2")
          ) {
            keyOk = await verifyAgentKey(msg.key, row.agent_key_hash, opts.previousAgentKeySecret);
          }
          if (ws.readyState !== WebSocket.OPEN) return;
          if (!keyOk) {
            ws.send(JSON.stringify({ type: "error", error: "bad_key" }));
            ws.close(1008, "bad key");
            return;
          }

          const connectedAt = Date.now();
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
               WHERE id = ? AND deleted_at IS NULL`
            )
            .run(
              connectedAt,
              msg.hostname ?? "",
              msg.osName ?? "",
              msg.osVersion ?? "",
              msg.arch ?? "",
              msg.kernelVersion ?? "",
              msg.cpuModel ?? "",
              msg.cpuCores ?? null,
              row.id
            );

          machineId = row.id;
          authenticating = false;
          clearTimeout(authTimeout);
          const previous = agents.get(machineId);
          agents.set(machineId, { ws, machineId, capabilities: msg.capabilities ?? [] });
          if (previous && previous.ws !== ws) previous.ws.close(1000, "replaced");

          broadcastUi({
            type: "machine_status",
            machineId,
            online: true,
            lastSeenAt: connectedAt,
          });
          ws.send(JSON.stringify({ type: "hello_ok", machineId, intervalSec: row.interval_sec }));
          return;
        }

        if (msg.type === "ping_result") {
          if (machineId == null || agents.get(machineId)?.ws !== ws) return;
          const pending = pendingPings.get(msg.requestId);
          if (pending?.ws === ws) pending.finish({ at: Date.now(), latencyMs: msg.error ? null : msg.latencyMs,
            error: msg.error || (msg.latencyMs == null ? "timeout_or_unreachable" : null) });
          return;
        }

        if (msg.type === "metrics") {
          if (machineId == null) {
            ws.send(JSON.stringify({ type: "error", error: "not_helloed" }));
            return;
          }

          if (agents.get(machineId)?.ws !== ws) return;
          const at = Date.now();
          if (at - lastMetricAt < 1000) return;
          lastMetricAt = at;
          const netRx = msg.net?.rxBytes ?? 0;
          const netTx = msg.net?.txBytes ?? 0;
          const tcpConn = msg.conn?.tcp ?? 0;
          const udpConn = msg.conn?.udp ?? 0;
          const l1 = msg.load?.l1 ?? 0;
          const l5 = msg.load?.l5 ?? 0;
          const l15 = msg.load?.l15 ?? 0;
          const touch = opts.db
            .prepare("UPDATE machines SET last_seen_at = ?, online = 1 WHERE id = ? AND deleted_at IS NULL")
            .run(at, machineId);
          if (touch.changes === 0) {
            ws.close(1008, "unknown machine");
            return;
          }

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
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "error", error: "bad_message" }));
      }
    });

    ws.on("close", () => {
      clearTimeout(authTimeout);
      for (const pending of pendingPings.values()) if (pending.ws === ws) pending.finish({ at: Date.now(), latencyMs: null, error: "agent_offline" });
      if (machineId == null) return;
      const agent = agents.get(machineId);
      if (agent?.ws !== ws) return;
      agents.delete(machineId);
      if (!opts.db.open) return;
      opts.db.prepare("UPDATE machines SET online = 0 WHERE id = ? AND deleted_at IS NULL").run(machineId);
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
      if (client.ws.bufferedAmount > 1024 * 1024) { client.ws.terminate(); continue; }
      client.ws.send(payload);
    }
  }

  function closeAgent(machineId: number, code = 1001, reason = "machine_deleted") {
    for (const session of sshSessions.values()) if (session.machineId === machineId) session.close(reason);
    const agent = agents.get(machineId);
    if (!agent) return;
    try {
      agent.ws.close(code, reason);
    } catch {
      agents.delete(machineId);
    }
  }

  function closeSshSession(id: string) {
    const session = sshSessions.get(id);
    if (!session) return false;
    session.close("closed_by_operator");
    return true;
  }

  function closeUser(userId: number) {
    for (const session of sshSessions.values()) if (session.userId === userId) session.close("credentials_changed");
    for (const [ws, id] of browserUsers) if (id === userId) ws.close(1008, "credentials_changed");
  }
  const alive = new WeakSet<WebSocket>();
  wss.on("connection", (ws) => { alive.add(ws); ws.on("pong", () => alive.add(ws)); });
  const heartbeat = setInterval(() => { for (const ws of wss.clients) {
    if (!opts.db.open) { ws.terminate(); continue; }
    const token = browserTokens.get(ws);
    if (token) { try { const user = currentUser(opts.db, token, opts.jwtSecret); if (user.role !== "admin") throw new Error("forbidden"); } catch { ws.close(1008, "invalid_token"); continue; } }
    if (!alive.has(ws)) { ws.terminate(); continue; } alive.delete(ws); ws.ping();
  } }, 30000);
  heartbeat.unref();
  opts.server.on("close", () => { clearInterval(heartbeat); for (const ws of wss.clients) ws.terminate(); wss.close(); });
  function pingCapability(machineId: number): "ready" | "offline" | "upgrade_required" {
    const agent = agents.get(machineId);
    if (!agent || agent.ws.readyState !== WebSocket.OPEN) return "offline";
    return agent.capabilities.includes("ping-v1") ? "ready" : "upgrade_required";
  }
  return { closeAgent, closeSshSession, probeMachine, closeUser, pingCapability };
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
      .prepare("SELECT billing_anchor_day as anchorDay FROM machines WHERE id = ? AND deleted_at IS NULL")
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
  z.object({ type: z.literal("subscribe"), machineIds: z.array(z.number().int().positive()).max(10_000) }),
]);

const SshMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("connect"),
    machineId: z.number().int().positive(),
    cols: z.number().int().positive().max(500).optional(),
    rows: z.number().int().positive().max(200).optional(),
  }),
  z.object({ type: z.literal("input"), dataB64: z.string().min(1).max(128 * 1024) }),
  z.object({ type: z.literal("resize"), cols: z.number().int().positive().max(500), rows: z.number().int().positive().max(200) }),
]);

const AgentMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ping_result"), requestId: z.string().uuid(), latencyMs: z.number().min(0).max(60000).nullable(), error: z.enum(["bad_target", "ping_unavailable", "timeout_or_unreachable", "invalid_result", "agent_busy"]).optional() }),
  z.object({
    type: z.literal("hello"),
    machineId: z.number().int().positive(),
    key: z.string().min(1).max(4096),
    hostname: z.string().max(255).optional(),
    osName: z.string().max(255).optional(),
    osVersion: z.string().max(255).optional(),
    arch: z.string().max(64).optional(),
    kernelVersion: z.string().max(255).optional(),
    cpuModel: z.string().max(512).optional(),
    cpuCores: z.number().int().nonnegative().optional(),
    capabilities: z.array(z.string().max(32)).max(16).optional(),
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
