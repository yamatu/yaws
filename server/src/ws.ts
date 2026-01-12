import type { IncomingMessage } from "node:http";
import WebSocket, { WebSocketServer } from "ws";
import { z } from "zod";
import type { Db } from "./db.js";
import { verifyToken } from "./auth.js";
import bcrypt from "bcryptjs";

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
}) {
  const wss = new WebSocketServer({ noServer: true });
  const uiClients = new Set<UiClient>();
  const agents = new Map<number, AgentClient>();

  opts.server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    if (url.pathname !== "/ws/ui" && url.pathname !== "/ws/agent") {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  wss.on("connection", (ws, req: IncomingMessage) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    if (url.pathname === "/ws/ui") handleUi(ws, req, url);
    else handleAgent(ws, req, url);
  });

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
          const l1 = msg.load?.l1 ?? 0;
          const l5 = msg.load?.l5 ?? 0;
          const l15 = msg.load?.l15 ?? 0;
          opts.db
            .prepare(
              `INSERT INTO metrics (
                 machine_id, at,
                 cpu_usage, mem_used, mem_total, disk_used, disk_total,
                 net_rx_bytes, net_tx_bytes, load_1, load_5, load_15
               )
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
              l1,
              l5,
              l15
            );
          opts.db
            .prepare("UPDATE machines SET last_seen_at = ?, online = 1 WHERE id = ?")
            .run(at, machineId);

          const monthTraffic = msg.net ? updateMonthlyTraffic(opts.db, machineId, at, netRx, netTx) : null;

          broadcastUi({
            type: "metrics",
            machineId,
            metric: {
              at,
              cpu: msg.cpu,
              mem: msg.mem,
              disk: msg.disk,
              net: msg.net,
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
    load: z.object({ l1: z.number().nonnegative(), l5: z.number().nonnegative(), l15: z.number().nonnegative() }).optional(),
  }),
]);
