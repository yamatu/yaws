import express from "express";
import http from "node:http";
import path from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { fileURLToPath } from "node:url";
import ssh2 from "ssh2";
const { Server } = ssh2;
import WebSocket from "ws";
import { openDb } from "../dist/db.js";
import { hashAgentKey, hashPassword, signToken } from "../dist/auth.js";
import { authMiddleware } from "../dist/http.js";
import { encryptText } from "../dist/crypto.js";
import { attachWebSockets } from "../dist/ws.js";
import { workspaceRouter } from "../dist/workspace.js";
import { aiRouter } from "../dist/ai.js";
import { createPingService } from "../dist/ping.js";
import { WorkspaceError } from "../dist/ssh.js";
import { z } from "zod";

export async function harness(port = 0) {
  const secret = "fixture-only-secret-123456789";
  const db = openDb(":memory:");
  const password = "Fixture-Password-Only";
  db.prepare(
    "INSERT INTO users(id,username,password_hash,role,created_at) VALUES (1,'fixture',?,'admin',0),(2,'viewer',?,'viewer',0)",
  ).run(await hashPassword(password), await hashPassword(password));
  const token = signToken(
    { id: 1, username: "fixture", role: "admin", version: 0 },
    secret,
  );
  const viewerToken = signToken(
    { id: 2, username: "viewer", role: "viewer", version: 0 },
    secret,
  );
  const files = new Map([
    ["/srv/app/config.json", Buffer.from('{"enabled":false}\n')],
    ["/srv/app/.env", Buffer.from("SECRET=do-not-send")],
    ["/etc/nginx/nginx.conf", Buffer.from("events {}\nhttp {}\n")],
    ["/srv/app/binary.dat", Buffer.from([0, 255, 1])],
  ]);
  const directories = new Set([
    "/",
    "/srv",
    "/srv/app",
    "/etc",
    "/etc/nginx",
    "/root",
  ]);
  const stat = (name) =>
    directories.has(name)
      ? { mode: 0o40755, uid: 1000, gid: 1000, size: 0, atime: 1, mtime: 1 }
      : files.has(name)
        ? {
            mode: 0o100644,
            uid: 1000,
            gid: 1000,
            size: files.get(name).length,
            atime: 1,
            mtime: 1,
          }
        : null;
  const privateKey = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  }).privateKey;
  const clients = new Set();
  const commands = [];
  const ssh = new Server({ hostKeys: [privateKey] }, (client) => {
    clients.add(client);
    client.on("error", () => {});
    client.on("close", () => clients.delete(client));
    client.on("authentication", (ctx) =>
      ctx.method === "password" &&
      ctx.username === "fixture" &&
      ctx.password === password
        ? ctx.accept()
        : ctx.reject(),
    );
    client.on("ready", () =>
      client.on("session", (accept) => {
        const session = accept();
        session.on("pty", (accept) => accept());
        session.on("window-change", (accept) => accept?.());
        session.on("shell", (accept) => {
          const stream = accept();
          stream.write("fixture ready\r\n$ ");
          stream.on("data", (chunk) => {
            stream.write(chunk);
            if (chunk.toString().includes("exit")) {
              stream.exit(0);
              stream.end();
            }
          });
        });
        session.on("exec", (accept, _reject, info) => {
          commands.push(info.command);
          const stream = accept();
          stream.write("fixture command complete\n");
          stream.exit(0);
          stream.end();
        });
        session.on("sftp", (accept) => {
          const sftp = accept(),
            handles = new Map();
          let counter = 0;
          const status = (id, code = 0) => sftp.status(id, code);
          sftp.on("REALPATH", (id, p) => {
            p = p === "." ? "/srv/app" : path.posix.normalize(p);
            if (p === "/srv/app/escape") p = "/etc/nginx";
            if (!stat(p)) return status(id, 2);
            sftp.name(id, [{ filename: p, longname: p, attrs: stat(p) }]);
          });
          for (const event of ["STAT", "LSTAT"])
            sftp.on(event, (id, p) => {
              const attrs = stat(p);
              attrs ? sftp.attrs(id, attrs) : status(id, 2);
            });
          sftp.on("OPEN", (id, p, flags) => {
            const create = !!(flags & 8),
              exclusive = !!(flags & 32);
            if (exclusive && files.has(p)) return status(id, 4);
            if (!files.has(p) && !create) return status(id, 2);
            if (create && !files.has(p)) files.set(p, Buffer.alloc(0));
            const handle = Buffer.from(String(++counter));
            handles.set(handle.toString(), { path: p });
            sftp.handle(id, handle);
          });
          sftp.on("FSTAT", (id, handle) => {
            const h = handles.get(handle.toString());
            h && stat(h.path) ? sftp.attrs(id, stat(h.path)) : status(id, 2);
          });
          sftp.on("READ", (id, handle, offset, length) => {
            const h = handles.get(handle.toString());
            const b = files.get(h?.path);
            if (!b) return status(id, 2);
            if (offset >= b.length) return status(id, 1);
            sftp.data(id, b.subarray(offset, offset + length));
          });
          sftp.on("WRITE", (id, handle, offset, data) => {
            const h = handles.get(handle.toString());
            if (!h) return status(id, 2);
            const old = files.get(h.path) ?? Buffer.alloc(0);
            const buffer = Buffer.alloc(
              Math.max(old.length, offset + data.length),
            );
            old.copy(buffer);
            data.copy(buffer, offset);
            files.set(h.path, buffer);
            status(id);
          });
          sftp.on("CLOSE", (id, handle) => {
            handles.delete(handle.toString());
            status(id);
          });
          sftp.on("OPENDIR", (id, p) => {
            if (!directories.has(p)) return status(id, 2);
            const handle = Buffer.from(String(++counter));
            handles.set(handle.toString(), { path: p, read: false });
            sftp.handle(id, handle);
          });
          sftp.on("READDIR", (id, handle) => {
            const h = handles.get(handle.toString());
            if (!h || h.read) return status(id, 1);
            h.read = true;
            const list = [...directories, ...files.keys()]
              .filter((p) => p !== h.path && path.posix.dirname(p) === h.path)
              .map((p) => ({
                filename: path.posix.basename(p),
                longname: p,
                attrs: stat(p),
              }));
            if (!list.length) return status(id, 1);
            sftp.name(id, list);
          });
          for (const event of ["SETSTAT", "FSETSTAT"])
            sftp.on(event, (id) => status(id));
          sftp.on("REMOVE", (id, p) => {
            if (!files.delete(p)) return status(id, 2);
            status(id);
          });
          const rename = (id, src, dst, replace) => {
            if (!files.has(src)) return status(id, 2);
            if (!replace && files.has(dst)) return status(id, 4);
            files.set(dst, files.get(src));
            files.delete(src);
            status(id);
          };
          sftp.on("RENAME", (id, src, dst) => rename(id, src, dst, false));
          sftp.on("EXTENDED", (id, name, ...args) => {
            if (name === "posix-rename@openssh.com")
              rename(id, args[0], args[1], true);
            else status(id, 8);
          });
        });
      }),
    );
  });
  await new Promise((resolve) => ssh.listen(0, "127.0.0.1", resolve));
  const sshPort = ssh.address().port;
  for (const id of [1, 2, 3])
    db.prepare(
      `INSERT INTO machines(id,name,ssh_host,ssh_port,ssh_user,ssh_password_enc,agent_key_hash,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,0,0)`,
    ).run(
      id,
      `Fixture ${id}`,
      "127.0.0.1",
      sshPort,
      "fixture",
      encryptText(password, secret),
      hashAgentKey("fixture-agent-key", secret),
    );
  const modelRequests = [];
  const model = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    modelRequests.push(body);
    const chat = req.url.endsWith("/chat/completions");
    const history = chat ? body.messages : body.input;
    const count = history.filter(
      (m) => m.role === "tool" || m.type === "function_call_output",
    ).length;
    let calls = [];
    if (count === 0)
      calls = [{ name: "read_file", args: { path: "/srv/app/config.json" } }];
    if (count === 1)
      calls = [
        {
          name: "propose_file",
          args: { path: "/srv/app/config.json", content: '{"enabled":true}\n' },
        },
        { name: "propose_command", args: { command: "printf validation" } },
      ];
    const toolCalls = calls.map((call, i) => ({
      id: `call_${count}_${i}`,
      type: "function",
      function: { name: call.name, arguments: JSON.stringify(call.args) },
    }));
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify(
        chat
          ? {
              choices: [
                {
                  message: {
                    content: calls.length ? null : "已生成配置修改与验证命令。",
                    ...(calls.length ? { tool_calls: toolCalls } : {}),
                  },
                },
              ],
            }
          : {
              output: calls.length
                ? toolCalls.map((call) => ({
                    type: "function_call",
                    call_id: call.id,
                    name: call.function.name,
                    arguments: call.function.arguments,
                  }))
                : [
                    {
                      type: "message",
                      role: "assistant",
                      content: [
                        {
                          type: "output_text",
                          text: "已生成配置修改与验证命令。",
                        },
                      ],
                    },
                  ],
            },
      ),
    );
  });
  await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
  const modelUrl = `http://127.0.0.1:${model.address().port}/v1`;
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  const server = http.createServer(app);
  const hub = attachWebSockets({
    server,
    db,
    jwtSecret: secret,
    agentKeySecret: secret,
  });
  const ping = createPingService(db, () => true, hub.probeMachine, hub.pingCapability);
  const auth = authMiddleware(secret, db);
  const admin = (req, res, next) =>
    req.user.role === "admin"
      ? next()
      : res.status(403).json({ error: "forbidden" });
  app.post("/api/auth/login", async (req, res) => {
    if (req.body.username !== "fixture" || req.body.password !== password)
      return res.status(401).json({ error: "invalid_credentials" });
    res.json({ token });
  });
  app.get("/api/me", auth, (req, res) => res.json({ user: req.user }));
  app.get("/api/machines", auth, admin, (_req, res) =>
    res.json({
      machines: db
        .prepare(
          "SELECT id,name,ssh_host as sshHost,ssh_user as sshUser,ssh_port as sshPort,1 as sshHasPassword,'password' as sshAuthType,online FROM machines",
        )
        .all(),
    }),
  );
  app.get("/api/machines/summary", auth, admin, (_req, res) =>
    res.json({
      machines: db
        .prepare(
          "SELECT id,name,ssh_host as sshHost,ssh_user as sshUser,ssh_port as sshPort,1 as sshHasPassword,'password' as sshAuthType,online,'month' as billingCycle,0 as purchaseAmountCents,0 as autoRenew,'' as groupName FROM machines",
        )
        .all(),
    }),
  );
  app.get("/api/public/summary", (_req, res) => res.json({ machines: [] }));
  app.get("/api/machines/:id", auth, admin, (req, res) =>
    res.json({
      machine: db
        .prepare("SELECT id,name FROM machines WHERE id=?")
        .get(req.params.id),
    }),
  );
  app.use(
    "/api/machines/:id/workspace",
    auth,
    admin,
    workspaceRouter(db, secret),
  );
  app.use("/api/ai", auth, admin, aiRouter(db, secret));
  app.use("/api/ping", auth, admin, ping.router);
  app.get("/api/ssh/sessions", auth, admin, (_req, res) =>
    res.json({
      sessions: db
        .prepare(
          "SELECT id,machine_name as machineName,operator,destination,started_at as startedAt,status FROM ssh_sessions WHERE ended_at IS NULL",
        )
        .all(),
    }),
  );
  app.use((error, _req, res, _next) => {
    if (error instanceof WorkspaceError)
      return res.status(error.status).json({ error: error.message });
    if (error instanceof z.ZodError)
      return res.status(400).json({ error: "bad_request" });
    console.error("fixture error", error);
    res.status(500).json({ error: "internal_error" });
  });
  const dist = fileURLToPath(new URL("../../web/dist", import.meta.url));
  app.use(express.static(dist));
  app.get("/{*splat}", (_req, res) =>
    res.sendFile(path.join(dist, "index.html")),
  );
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const agents = [];
  for (const id of [1, 2, 3]) {
    const agent = new WebSocket(url.replace("http", "ws") + "/ws/agent");
    agents.push(agent);
    await new Promise((resolve, reject) => {
      agent.on("error", reject);
      agent.on("open", () =>
        agent.send(
          JSON.stringify({
            type: "hello",
            machineId: id,
            key: "fixture-agent-key",
            capabilities: id === 3 ? [] : ["ping-v1"],
          }),
        ),
      );
      agent.on("message", (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === "hello_ok") resolve();
        if (msg.type === "ping")
          agent.send(
            JSON.stringify({
              type: "ping_result",
              requestId: msg.requestId,
              latencyMs: id * 10,
            }),
          );
      });
    });
  }
  return {
    url,
    db,
    token,
    viewerToken,
    modelUrl,
    files,
    commands,
    modelRequests,
    hub,
    secret,
    password,
    async close() {
      ping.stop();
      for (const agent of agents) agent.terminate();
      for (const c of clients) c.end();
      await new Promise((resolve) => server.close(resolve));
      await new Promise((resolve) => ssh.close(resolve));
      await new Promise((resolve) => model.close(resolve));
      db.close();
    },
  };
}

if (process.argv.includes("--serve")) {
  const fixture = await harness(Number(process.env.FIXTURE_PORT ?? 3301));
  console.log(`Fixture running at ${fixture.url}`);
  const quit = () => {
    void fixture.close().then(() => process.exit(0));
  };
  process.on("SIGINT", quit);
  process.on("SIGTERM", quit);
}
