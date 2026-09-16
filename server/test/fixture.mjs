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

/** Reply for the workspace resource probe (see server/src/system-stats.ts). */const STATS_OUTPUT = [
  "K host fixture-ssh",
  "K kernel Linux 6.1.0-fixture",
  "K uptime 86400.5",
  "K load 0.42 0.30 0.20",
  "K cpus 2",
  "C a cpu  500 10 200 20000 30 0 20 5 0 0",
  "C b cpu  560 10 240 20200 34 0 22 5 0 0",
  "M MemTotal:        3866624 kB",
  "M MemFree:          200000 kB",
  "M MemAvailable:    1200000 kB",
  "M Buffers:           50000 kB",
  "M Cached:           900000 kB",
  "M SwapTotal:        524284 kB",
  "M SwapFree:         400000 kB",
  "D /dev/vda1 20511312 15998823 4512489 78% /",
  "D /dev/vdb1 20511312 19280633 1230679 94% /data",
  "D tmpfs 100000 0 100000 0% /run",
  "P 1111 nginx 8.0 1.0 40000",
  "P 2222 node 30.0 12.0 500000",
  "K net 1000000 2000000",
  "",
].join("\n");

/** `[md]` returns a Markdown answer so the chat rendering can be asserted. `[pre]`
 *  streams a sentence *before* the tool call, like a model that narrates its plan. */
const MD_ANSWER = [
  "## 磁盘排查结论",
  "",
  "根分区 `/` 已用到 **78%**，`/data` 已到 ~~90%~~ **94%**，建议先清理日志。",
  "",
  "处理步骤：",
  "",
  "1. 确认服务正常",
  "2. 清理日志",
  "",
  "- [x] 已检查磁盘",
  "- [ ] 待清理日志",
  "",
  "> 删除前请先备份。",
  "",
  "```sh",
  "df -h /",
  "journalctl --vacuum-size=200M",
  "```",
  "",
  "| 分区 | 用量 |",
  "| --- | ---: |",
  "| / | 78% |",
  "| /data | 94% |",
  "",
  "详见 [官方文档](https://example.com/disk)。",
  "",
].join("\n");

const MARKER_TOOLS = {
  run: { name: "run_command", args: { command: "df -h /", purpose: "检查磁盘" } },
  write: {
    name: "run_command",
    args: { command: "systemctl restart nginx", purpose: "重启 nginx" },
  },
  danger: {
    name: "run_command",
    args: { command: "rm -rf /srv/app", purpose: "清理目录" },
  },
  file: {
    name: "write_file",
    args: {
      path: "/srv/app/config.json",
      content: '{"enabled":true}\n',
      summary: "更新配置",
    },
  },
  list: { name: "list_files", args: { path: "/srv/app" } },
  stats: { name: "server_stats", args: {} },
  log: {
    name: "read_log",
    args: { command: "tail -n 20 /var/log/nginx/error.log" },
  },
  secret: { name: "read_file", args: { path: "/srv/app/.env" } },
};

/** `[run]`/`[file]`/… at the start of a chat message drives one scripted tool call. */
function markerCalls(text, count) {
  if (count > 0) return [];
  if (text.includes("[many]"))
    return [
      MARKER_TOOLS.run,
      { name: "server_stats", args: {} },
      MARKER_TOOLS.list,
    ];
  for (const [marker, call] of Object.entries(MARKER_TOOLS))
    if (text.includes(`[${marker}]`)) return [call];
  return [];
}

function lastUserText(history, chat) {
  for (let i = history.length - 1; i >= 0; i--) {
    const item = history[i];
    if (item.role !== "user") continue;
    if (typeof item.content === "string") return item.content;
    if (Array.isArray(item.content))
      return item.content.map((part) => part.text ?? "").join(" ");
    return chat ? "" : JSON.stringify(item.content ?? "");
  }
  return "";
}

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
          stream.write(
            info.command.includes("MemAvailable")
              ? STATS_OUTPUT
              : "fixture command complete\n",
          );
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
    // The authorization header is kept so tests can tell profiles apart.
    modelRequests.push({ ...body, headers: { authorization: req.headers.authorization ?? "" } });
    const chat = req.url.endsWith("/chat/completions");
    const history = chat ? body.messages : body.input;
    const count = history.filter(
      (m) => m.role === "tool" || m.type === "function_call_output",
    ).length;
    let calls = [];
    const marker = lastUserText(history, chat);
    const markdown = marker.includes("[md]");
    // `[loop]` keeps asking for tools: a long task has to finish in one answer
    // instead of stopping at some step limit.
    const loop = marker.includes("[loop]");
    // A model that narrates first would send content *and* tool_calls together,
    // which makes the assistant bubble arrive before the steps it describes.
    const preamble = marker.includes("[pre]") ? "我先看一下磁盘占用。" : "";
    if (loop && count < 12) calls = [{ name: "list_files", args: { path: "/srv/app" } }];
    else if (markdown) calls = [];
    else if (/\[(run|write|danger|file|list|stats|log|secret|many)\]/.test(marker))
      calls = markerCalls(marker, count);
    else if (count === 0)
      calls = [{ name: "read_file", args: { path: "/srv/app/config.json" } }];
    else if (count === 1)
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
    const answer = markdown ? MD_ANSWER : "已生成配置修改与验证命令。";
    // `[slow]` keeps the model thinking long enough for a browser test to read
    // the live status line before the answer arrives.
    if (marker.includes("[slow]"))
      await new Promise((done) => setTimeout(done, 1200));
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify(
        chat
          ? {
              choices: [
                {
                  message: {
                    content: calls.length ? preamble || null : answer,
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
                          text: answer,
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
          `SELECT m.id,m.name,m.ssh_host as sshHost,m.ssh_user as sshUser,m.ssh_port as sshPort,
                  1 as sshHasPassword,'password' as sshAuthType,m.online,'month' as billingCycle,
                  0 as purchaseAmountCents,0 as autoRenew,'' as groupName,
                  x.at as metricAt,x.cpu_usage as cpuUsage,x.mem_used as memUsed,x.mem_total as memTotal,
                  x.disk_used as diskUsed,x.disk_total as diskTotal,x.load_1 as load1
             FROM machines m
             LEFT JOIN metrics x ON x.id = (SELECT id FROM metrics WHERE machine_id = m.id ORDER BY at DESC LIMIT 1)`,
        )
        .all()
        // The real dashboard seeds its live meters from this field, so the fixture
        // has to expose it too (the fixture inserts no metrics of its own).
        .map((row) => ({
          ...row,
          latestMetric: row.metricAt
            ? {
                at: row.metricAt,
                cpuUsage: row.cpuUsage,
                memUsed: row.memUsed,
                memTotal: row.memTotal,
                diskUsed: row.diskUsed,
                diskTotal: row.diskTotal,
                load1: row.load1,
              }
            : null,
        })),
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
