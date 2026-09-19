import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "../src/db.js";
import {
  MCPServerSchema,
  McpManager,
  mcpServerError,
  mcpToolNamespace,
  mergeMcpSecrets,
  probeMcpServer,
  publicMcpServers,
  readMcpServers,
  renderMcpResult,
  writeMcpServers,
} from "../src/mcp.js";

const secret = "s".repeat(32);
const here = path.dirname(fileURLToPath(import.meta.url));

const server = (over = {}) =>
  MCPServerSchema.parse({
    id: "one",
    name: "本地服务",
    enabled: true,
    transport: "stdio",
    command: "node",
    args: ["server.js"],
    env: {},
    url: "",
    headers: {},
    ...over,
  });

test("mcp", async (t) => {
  await t.test("fills defaults and validates transport config", () => {
    assert.equal(server().enabled, true);
    assert.equal(mcpServerError(server()), null);
    assert.equal(
      mcpServerError(server({ command: "" })),
      "mcp_command_required",
    );
    assert.equal(
      mcpServerError(
        server({ transport: "http", url: "not-a-url" }),
      ),
      "mcp_url_invalid",
    );
    assert.equal(
      mcpServerError(
        server({ transport: "http", url: "https://mcp.example.com/mcp" }),
      ),
      null,
    );
  });

  await t.test("namespaces tool names and caps them at 64 chars", () => {
    assert.equal(mcpToolNamespace("github", "list_repos"), "mcp__github__list_repos");
    assert.equal(mcpToolNamespace("a", "weird name/with:chars"), "mcp__a__weird_name_with_chars");
    assert.ok(mcpToolNamespace("a", "x".repeat(200)).length <= 64);
  });

  await t.test("keeps stored secrets when the incoming value is empty", () => {
    const old = server({ env: { TOKEN: "secret", PLAIN: "keep" } });
    const next = server({
      env: { TOKEN: "", PLAIN: "new", ADDED: "yes" },
    });
    const [merged] = mergeMcpSecrets([next], [old]);
    assert.deepEqual(merged.env, {
      TOKEN: "secret",
      PLAIN: "new",
      ADDED: "yes",
    });
  });

  await t.test("masks secrets in the public view but keeps the keys", () => {
    const view = publicMcpServers([
      server({ env: { TOKEN: "secret" }, headers: { Authorization: "Bearer x" } }),
    ]).servers[0];
    assert.deepEqual(view.env, { TOKEN: "" });
    assert.deepEqual(view.headers, { Authorization: "" });
  });

  await t.test("encrypts definitions at rest", () => {
    const db = openDb(":memory:");
    writeMcpServers(db, secret, [server({ env: { TOKEN: "secret" } })]);
    const raw = db
      .prepare("SELECT value FROM settings WHERE key = 'mcp_servers_enc'")
      .get().value;
    assert.ok(!raw.includes("secret"));
    assert.equal(readMcpServers(db, secret)[0].env.TOKEN, "secret");
    db.close();
  });

  await t.test("renders text and structured tool results", () => {
    assert.deepEqual(
      renderMcpResult({ content: [{ type: "text", text: "hi" }] }),
      { text: "hi", isError: false },
    );
    assert.deepEqual(
      renderMcpResult({ content: [], structuredContent: { a: 1 } }),
      { text: '{"a":1}', isError: false },
    );
    assert.equal(renderMcpResult({ content: [{ type: "text", text: "bad" }], isError: true }).isError, true);
  });

  await t.test("probes a stdio server and calls its tools", async () => {
    const db = openDb(":memory:");
    const fixture = path.join(here, "fixtures", "mcp-stdio.mjs");
    const definition = server({
      id: "fixture",
      name: "Fixture",
      command: process.execPath,
      args: [fixture],
    });
    writeMcpServers(db, secret, [definition]);
    const manager = new McpManager(db, secret);
    try {
      const { tools, errors } = await manager.listTools();
      assert.deepEqual(errors, []);
      assert.equal(tools.length, 1);
      assert.equal(tools[0].name, "mcp__fixture__echo");
      assert.equal(tools[0].serverName, "Fixture");
      const result = await manager.call("fixture", "echo", { text: "你好" });
      assert.equal(result.text, "echo:你好");
      assert.equal(result.isError, false);
      const probe = await probeMcpServer(definition);
      assert.deepEqual(probe.tools, ["echo"]);
    } finally {
      manager.closeAll();
      db.close();
    }
  });

  await t.test("lists and calls tools over http", async () => {
    const requests = [];
    const httpServer = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        const message = JSON.parse(body);
        requests.push({ method: message.method, session: req.headers["mcp-session-id"] });
        res.setHeader("content-type", "application/json");
        res.setHeader("mcp-session-id", "test-session");
        if (message.method === "initialize")
          return res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: message.id,
              result: { protocolVersion: "2024-11-05", capabilities: {} },
            }),
          );
        if (message.method === "tools/list")
          return res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: message.id,
              result: { tools: [{ name: "ping", description: "pong" }] },
            }),
          );
        if (message.method === "tools/call")
          return res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: message.id,
              result: { content: [{ type: "text", text: "pong" }] },
            }),
          );
        res.end(
          JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} }),
        );
      });
    });
    await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const port = httpServer.address().port;
    const db = openDb(":memory:");
    writeMcpServers(db, secret, [
      server({
        id: "remote",
        name: "Remote",
        transport: "http",
        command: "",
        args: [],
        url: `http://127.0.0.1:${port}/mcp`,
      }),
    ]);
    const manager = new McpManager(db, secret);
    try {
      const { tools, errors } = await manager.listTools();
      assert.deepEqual(errors, []);
      assert.equal(tools[0].name, "mcp__remote__ping");
      const result = await manager.call("remote", "ping", {});
      assert.equal(result.text, "pong");
      // The session id from `initialize` travels on every later request.
      assert.equal(requests.find((r) => r.method === "tools/list").session, "test-session");
    } finally {
      manager.closeAll();
      db.close();
      httpServer.close();
    }
  });

  await t.test("a broken server only loses its own tools", async () => {
    const db = openDb(":memory:");
    const fixture = path.join(here, "fixtures", "mcp-stdio.mjs");
    writeMcpServers(db, secret, [
      server({
        id: "good",
        name: "Good",
        command: process.execPath,
        args: [fixture],
      }),
      server({
        id: "bad",
        name: "Bad",
        command: path.join(here, "does-not-exist-xyz"),
        args: [],
      }),
    ]);
    const manager = new McpManager(db, secret);
    try {
      const { tools, errors } = await manager.listTools();
      assert.equal(tools.length, 1);
      assert.equal(tools[0].serverId, "good");
      assert.equal(errors.length, 1);
      assert.match(errors[0], /^Bad: /);
    } finally {
      manager.closeAll();
      db.close();
    }
  });
});
