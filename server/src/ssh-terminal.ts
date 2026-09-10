import type { Client, ClientChannel } from "ssh2";
import WebSocket from "ws";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { Db } from "./db.js";
import type { JwtUser } from "./auth.js";
import { connectMachine, sshMachine } from "./ssh.js";

const Message = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("connect"),
    machineId: z.number().int().positive(),
    cols: z.number().int().min(2).max(500),
    rows: z.number().int().min(2).max(200),
  }),
  z.object({
    type: z.literal("input"),
    dataB64: z
      .string()
      .max(64 * 1024)
      .regex(/^[A-Za-z0-9+/]*={0,2}$/),
  }),
  z.object({
    type: z.literal("resize"),
    cols: z.number().int().min(2).max(500),
    rows: z.number().int().min(2).max(200),
  }),
]);
export type TerminalSession = {
  ws: WebSocket;
  close: (reason: string) => void;
  machineId: number;
  userId: number;
};

export function terminalSocket(
  ws: WebSocket,
  db: Db,
  secret: string,
  user: JwtUser,
  sessions: Map<string, TerminalSession>,
) {
  let client: Client | undefined;
  let stream: ClientChannel | undefined;
  let started = false;
  let finished = false;
  let sessionId: string | undefined;
  let lastActivity = Date.now();
  const ctrl = new AbortController();
  let output: Buffer[] = [],
    outputBytes = 0;
  let flushTimer: NodeJS.Timeout | undefined;
  const send = (value: unknown) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(value));
  };
  const finish = (reason: string, failed = false) => {
    if (finished) return;
    finished = true;
    clearTimeout(connectTimer);
    clearInterval(idleTimer);
    clearTimeout(flushTimer);
    ctrl.abort();
    stream?.destroy();
    client?.destroy();
    output = [];
    if (sessionId) {
      sessions.delete(sessionId);
      if (db.open)
        db.prepare(
          "UPDATE ssh_sessions SET ended_at = ?, status = ?, reason = ? WHERE id = ? AND ended_at IS NULL",
        ).run(Date.now(), failed ? "error" : "closed", reason, sessionId);
    }
    send({ type: failed ? "error" : "exit", error: reason });
    ws.close(failed ? 1011 : 1000, reason.slice(0, 100));
  };
  const connectTimer = setTimeout(() => finish("connect_timeout", true), 20000);
  const idleTimer = setInterval(() => {
    if (Date.now() - lastActivity > 30 * 60_000) finish("idle_timeout");
  }, 30000);
  const flush = () => {
    flushTimer = undefined;
    if (finished || !outputBytes) return;
    if (ws.bufferedAmount > 1024 * 1024) return finish("slow_client", true);
    send({ type: "output", dataB64: Buffer.concat(output).toString("base64") });
    output = [];
    outputBytes = 0;
  };
  ws.on("close", () => finish("socket_closed"));
  ws.on("error", () => finish("socket_error", true));
  ws.on("message", (raw) => {
    if (finished) return;
    let msg: z.infer<typeof Message>;
    try {
      msg = Message.parse(JSON.parse(raw.toString()));
    } catch {
      return finish("bad_message", true);
    }
    lastActivity = Date.now();
    if (msg.type === "input") {
      if (stream && !stream.destroyed) {
        if (stream.writableLength > 256 * 1024)
          return finish("input_limit", true);
        stream.write(Buffer.from(msg.dataB64, "base64"));
      }
      return;
    }
    if (msg.type === "resize") {
      stream?.setWindow(msg.rows, msg.cols, 0, 0);
      return;
    }
    if (started) return finish("duplicate_connect", true);
    started = true;
    if (
      sessions.size >= 32 ||
      [...sessions.values()].filter((s) => s.userId === user.id).length >= 8
    )
      return finish("session_limit", true);
    void (async () => {
      const machine = sshMachine(db, msg.machineId);
      sessionId = randomUUID();
      db.prepare(
        "INSERT INTO ssh_sessions (id, machine_id, machine_name, operator, destination, started_at, status) VALUES (?, ?, ?, ?, ?, ?, 'connecting')",
      ).run(
        sessionId,
        machine.id,
        machine.name,
        user.username,
        `${machine.username}@${machine.host}:${machine.port}`,
        Date.now(),
      );
      sessions.set(sessionId, {
        ws,
        userId: user.id,
        machineId: machine.id,
        close: (reason) => finish(reason),
      });
      client = await connectMachine(db, machine.id, secret, ctrl.signal);
      if (finished) {
        client.destroy();
        return;
      }
      client.once("close", () => finish("ssh_closed"));
      client.on("error", () => finish("ssh_error", true));
      client.shell(
        { term: "xterm-256color", cols: msg.cols, rows: msg.rows },
        (err, channel) => {
          if (finished) {
            channel?.destroy();
            return;
          }
          if (err) return finish("shell_failed", true);
          stream = channel;
          clearTimeout(connectTimer);
          db.prepare(
            "UPDATE ssh_sessions SET status = 'connected' WHERE id = ?",
          ).run(sessionId);
          send({ type: "ready", sessionId });
          channel.on("data", (data: Buffer) => {
            output.push(data);
            outputBytes += data.length;
            if (outputBytes >= 32 * 1024) {
              clearTimeout(flushTimer);
              flush();
            } else if (!flushTimer) flushTimer = setTimeout(flush, 16);
          });
          channel.once("close", () => {
            flush();
            finish("exit");
          });
          channel.once("error", () => finish("shell_error", true));
        },
      );
    })().catch((error: unknown) =>
      finish(
        error instanceof Error ? error.message : "ssh_connect_failed",
        true,
      ),
    );
  });
}
