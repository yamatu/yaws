/**
 * Model Context Protocol (MCP) client.
 *
 * YAWS can mount external MCP servers and expose their tools to the AI chat
 * next to the built-in server tools. Two transports are supported:
 *
 *  - `stdio`  spawns a server process and talks newline-delimited JSON-RPC over
 *             its stdin/stdout (the usual `npx -y some-mcp-server` setup).
 *  - `http`   talks to a remote Streamable HTTP / SSE endpoint.
 *
 * Server definitions are stored encrypted in the settings table and are edited
 * by an admin only, so a mounted server is a deliberate capability grant, just
 * like an installed CLI tool. Tool names are namespaced as
 * `mcp__<serverId>__<toolName>` to avoid colliding with the built-in tools.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { decryptText, encryptText } from "./crypto.js";
import type { Db } from "./db.js";
import { WorkspaceError } from "./ssh.js";

/** Latest revision most servers negotiate; older servers answer with their own. */
const PROTOCOL_VERSION = "2024-11-05";
const INIT_TIMEOUT_MS = 20_000;
const LIST_TIMEOUT_MS = 20_000;
const CALL_TIMEOUT_MS = 120_000;
const MAX_SERVERS = 50;
const SETTINGS_KEY = "mcp_servers_enc";

export const MCPServerSchema = z.object({
  id: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_-]{1,32}$/),
  name: z.string().trim().min(1).max(60),
  enabled: z.boolean().default(true),
  transport: z.enum(["stdio", "http"]).default("stdio"),
  /** stdio transport: the executable to spawn. */
  command: z.string().trim().max(1024).default(""),
  args: z.array(z.string().max(4096)).max(64).default([]),
  env: z.record(z.string().max(65536)).default({}),
  /** http transport: the endpoint URL. */
  url: z.string().trim().max(2048).default(""),
  headers: z.record(z.string().max(8192)).default({}),
});
export type MCPServer = z.infer<typeof MCPServerSchema>;
export type MCPServerInput = MCPServer;

export const MCPServersSchema = z.array(MCPServerSchema).max(MAX_SERVERS);

/** Empty env/header values mean "keep the stored secret" on save, like API keys. */
export function mergeMcpSecrets(
  next: MCPServerInput[],
  previous: MCPServer[],
): MCPServer[] {
  const keep = (incoming: Record<string, string>, old: Record<string, string>) => {
    const merged: Record<string, string> = {};
    for (const [key, value] of Object.entries(incoming)) {
      merged[key] = value || old[key] || "";
    }
    return merged;
  };
  return next.map((server) => {
    const old = previous.find((p) => p.id === server.id);
    return {
      ...server,
      env: keep(server.env, old?.env ?? {}),
      headers: keep(server.headers, old?.headers ?? {}),
    };
  });
}

/** The browser never sees stored env/header values, only the keys. */
export function publicMcpServers(servers: MCPServer[]) {
  const mask = (record: Record<string, string>) =>
    Object.fromEntries(Object.keys(record).map((key) => [key, ""]));
  return {
    servers: servers.map((server) => ({
      id: server.id,
      name: server.name,
      enabled: server.enabled,
      transport: server.transport,
      command: server.command,
      args: server.args,
      env: mask(server.env),
      url: server.url,
      headers: mask(server.headers),
    })),
  };
}

/** Rejected before a connection is attempted. */
export function mcpServerError(server: MCPServer): string | null {
  if (server.transport === "stdio") {
    if (!server.command) return "mcp_command_required";
    return null;
  }
  let endpoint: URL;
  try {
    endpoint = new URL(server.url);
  } catch {
    return "mcp_url_invalid";
  }
  if (!["http:", "https:"].includes(endpoint.protocol)) return "mcp_url_invalid";
  return null;
}

function setting(db: Db, key: string): string {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? "";
}

function put(db: Db, key: string, value: string) {
  db.prepare(
    "INSERT INTO settings (key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
  ).run(key, value, Date.now());
}

export function readMcpServers(db: Db, secret: string): MCPServer[] {
  const stored = setting(db, SETTINGS_KEY);
  if (!stored) return [];
  try {
    return MCPServersSchema.parse(JSON.parse(decryptText(stored, secret)));
  } catch {
    // A corrupt value must not brick AI chat; the admin can rewrite it.
    return [];
  }
}

export function writeMcpServers(db: Db, secret: string, servers: MCPServer[]) {
  put(db, SETTINGS_KEY, encryptText(JSON.stringify(servers), secret));
}

type JsonRpcMessage = {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
};

function rpcError(message: JsonRpcMessage): Error {
  const detail = message.error;
  return new Error(detail ? `mcp_rpc_${detail.code}: ${detail.message}` : "mcp_rpc_error");
}

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

interface Transport {
  request(method: string, params: unknown, timeoutMs: number): Promise<unknown>;
  notify(method: string, params?: unknown): Promise<void>;
  close(): void;
}

/** Shared handshake + tool helpers; the transport only moves JSON-RPC frames. */
class McpConnection {
  private handshake: Promise<{ protocolVersion: string; serverInfo?: unknown }> | null =
    null;

  constructor(
    private readonly transport: Transport,
    readonly label: string,
  ) {}

  private initialize() {
    if (!this.handshake) {
      this.handshake = this.transport
        .request(
          "initialize",
          {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: "yaws", version: "1.0.0" },
          },
          INIT_TIMEOUT_MS,
        )
        .then(async (raw) => {
          const result = (raw ?? {}) as {
            protocolVersion?: string;
            serverInfo?: unknown;
          };
          await this.transport.notify("notifications/initialized");
          return {
            protocolVersion: result.protocolVersion || PROTOCOL_VERSION,
            serverInfo: result.serverInfo,
          };
        })
        .catch((error) => {
          // A failed handshake must not be cached, or a later retry is stuck.
          this.handshake = null;
          throw error;
        });
    }
    return this.handshake;
  }

  async listTools(): Promise<MCPTool[]> {
    await this.initialize();
    const raw = (await this.transport.request(
      "tools/list",
      {},
      LIST_TIMEOUT_MS,
    )) as { tools?: unknown };
    const parsed = z
      .array(
        z
          .object({
            name: z.string(),
            description: z.string().optional(),
            inputSchema: z.record(z.unknown()).optional(),
          })
          .passthrough(),
      )
      .safeParse(raw?.tools ?? []);
    if (!parsed.success) throw new Error("mcp_invalid_tool_list");
    return parsed.data.map((tool) => ({
      name: tool.name,
      description: tool.description ?? "",
      inputSchema: tool.inputSchema ?? { type: "object", properties: {} },
    }));
  }

  async callTool(name: string, args: Record<string, unknown>) {
    await this.initialize();
    return this.transport.request(
      "tools/call",
      { name, arguments: args },
      CALL_TIMEOUT_MS,
    );
  }

  close() {
    try {
      this.transport.close();
    } catch {
      // already gone
    }
  }
}

export type MCPTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

/** One MCP tool flattened for the chat, with the namespaced model tool name. */
export type MappedMcpTool = {
  serverId: string;
  serverName: string;
  toolName: string;
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

export function mcpToolNamespace(serverId: string, toolName: string): string {
  const clean = toolName.replace(/[^A-Za-z0-9_-]/g, "_");
  const prefix = `mcp__${serverId}__`;
  // OpenAI-style tool names are capped at 64 characters.
  return `${prefix}${clean}`.slice(0, 64);
}

/** stdio transport: newline-delimited JSON-RPC over the child's stdio. */
class StdioTransport implements Transport {
  private proc: ChildProcess;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private buffer = "";
  private stderr = "";
  private finished: Error | null = null;

  constructor(command: string, args: string[], env: Record<string, string>) {
    // On Windows a bare `npx`/`uvx` has to go through the shell so cmd resolves
    // the `.cmd` shim; an existing executable path must not, or the shell would
    // mangle a path that contains spaces.
    const shell =
      process.platform === "win32" && !fs.existsSync(command);
    this.proc = spawn(command, args, {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
      shell,
      windowsHide: true,
    });
    this.proc.stdout?.setEncoding("utf8");
    this.proc.stdout?.on("data", (chunk: string) => this.onData(chunk));
    this.proc.stderr?.setEncoding("utf8");
    this.proc.stderr?.on("data", (chunk: string) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-4000);
    });
    this.proc.on("error", (error) => this.fail(error));
    this.proc.on("exit", (code, signal) =>
      this.fail(
        new Error(
          `mcp_exit_${code ?? signal ?? "unknown"}${this.stderr ? `: ${this.stderr.trim().slice(0, 300)}` : ""}`,
        ),
      ),
    );
  }

  private onData(chunk: string) {
    this.buffer += chunk;
    let index: number;
    while ((index = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      let message: JsonRpcMessage;
      try {
        message = JSON.parse(line) as JsonRpcMessage;
      } catch {
        continue; // servers occasionally log plain text to stdout
      }
      this.dispatch(message);
    }
    // Guard against a server that never emits a newline.
    if (this.buffer.length > 4 * 1024 * 1024) this.buffer = "";
  }

  private dispatch(message: JsonRpcMessage) {
    if (message.id === undefined || message.id === null) return; // notification
    const pending = this.pending.get(Number(message.id));
    if (!pending) return;
    this.pending.delete(Number(message.id));
    clearTimeout(pending.timer);
    if (message.error) pending.reject(rpcError(message));
    else pending.resolve(message.result);
  }

  private fail(error: Error) {
    if (this.finished) return;
    this.finished = error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    if (this.finished) return Promise.reject(this.finished);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`mcp_timeout_${method}`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      const frame = `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;
      this.proc.stdin?.write(frame, (error) => {
        if (error) {
          this.pending.delete(id);
          clearTimeout(timer);
          reject(error);
        }
      });
    });
  }

  async notify(method: string, params?: unknown): Promise<void> {
    if (this.finished) return;
    const frame = `${JSON.stringify({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) })}\n`;
    this.proc.stdin?.write(frame);
  }

  close() {
    this.fail(new Error("mcp_closed"));
    try {
      this.proc.stdin?.end();
      this.proc.kill();
    } catch {
      // already gone
    }
  }
}

/** http transport: Streamable HTTP, accepting JSON or SSE responses. */
class HttpTransport implements Transport {
  private nextId = 1;
  private sessionId = "";
  private protocolVersion = PROTOCOL_VERSION;

  constructor(
    private readonly url: string,
    private readonly headers: Record<string, string>,
  ) {}

  private async handleResponse(response: Response, id: number): Promise<JsonRpcMessage> {
    const session = response.headers.get("mcp-session-id");
    if (session) this.sessionId = session;
    if (!response.ok) throw new Error(`mcp_http_${response.status}`);
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("text/event-stream")) {
      const text = await response.text();
      let fallback: JsonRpcMessage | null = null;
      for (const line of text.split(/\r?\n/)) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        let message: JsonRpcMessage;
        try {
          message = JSON.parse(payload) as JsonRpcMessage;
        } catch {
          continue;
        }
        if (Number(message.id) === id) return message;
        if (message.id !== undefined && message.result !== undefined) fallback = message;
      }
      if (fallback) return fallback;
      throw new Error("mcp_no_response");
    }
    return (await response.json()) as JsonRpcMessage;
  }

  async request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const id = this.nextId++;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    try {
      const response = await fetch(this.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...(this.sessionId ? { "mcp-session-id": this.sessionId } : {}),
          ...(method === "initialize"
            ? {}
            : { "mcp-protocol-version": this.protocolVersion }),
          ...this.headers,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        signal: controller.signal,
      });
      const message = await this.handleResponse(response, id);
      if (method === "initialize") {
        const version = (message.result as { protocolVersion?: string } | undefined)
          ?.protocolVersion;
        if (version) this.protocolVersion = version;
      }
      if (message.error) throw rpcError(message);
      return message.result;
    } catch (error) {
      if ((error as Error).name === "AbortError")
        throw new Error(`mcp_timeout_${method}`);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async notify(method: string, params?: unknown): Promise<void> {
    try {
      const response = await fetch(this.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...(this.sessionId ? { "mcp-session-id": this.sessionId } : {}),
          "mcp-protocol-version": this.protocolVersion,
          ...this.headers,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method,
          ...(params === undefined ? {} : { params }),
        }),
      });
      // Drain the body so the socket can be reused instead of left hanging.
      await response.arrayBuffer().catch(() => undefined);
    } catch {
      // Notifications are best-effort per the spec.
    }
  }

  close() {
    // Stateless HTTP: nothing to release. Servers expire sessions themselves.
  }
}

function connect(server: MCPServer): McpConnection {
  if (server.transport === "stdio")
    return new McpConnection(
      new StdioTransport(server.command, server.args, server.env),
      server.name,
    );
  return new McpConnection(
    new HttpTransport(server.url, server.headers),
    server.name,
  );
}

/** Renders a `tools/call` result as text for the model and the transcript. */
export function renderMcpResult(result: unknown): { text: string; isError: boolean } {
  const payload = (result ?? {}) as {
    content?: Array<Record<string, unknown>>;
    isError?: boolean;
    structuredContent?: unknown;
  };
  const parts: string[] = [];
  for (const item of payload.content ?? []) {
    if (item.type === "text" && typeof item.text === "string") parts.push(item.text);
    else if (item.type === "image") parts.push(`[图片 ${String(item.mimeType ?? "")}]`);
    else if (item.type === "resource" && item.resource)
      parts.push(`[资源 ${JSON.stringify(item.resource)}]`);
    else parts.push(JSON.stringify(item));
  }
  if (!parts.length && payload.structuredContent !== undefined)
    parts.push(JSON.stringify(payload.structuredContent));
  return { text: parts.join("\n") || "(空结果)", isError: !!payload.isError };
}

/**
 * Keeps one live connection per configured server. Connections are created
 * lazily on first use and reused across turns; a broken connection is dropped
 * so the next call reconnects instead of failing forever.
 */
export class McpManager {
  private connections = new Map<string, Promise<McpConnection>>();

  constructor(
    private readonly db: Db,
    private readonly secret: string,
  ) {}

  servers(onlyEnabled = true): MCPServer[] {
    const list = readMcpServers(this.db, this.secret);
    return onlyEnabled ? list.filter((server) => server.enabled) : list;
  }

  private connection(server: MCPServer): Promise<McpConnection> {
    const existing = this.connections.get(server.id);
    if (existing) {
      return existing.catch((error) => {
        this.connections.delete(server.id);
        throw error;
      });
    }
    const created = Promise.resolve()
      .then(() => connect(server))
      .catch((error) => {
        this.connections.delete(server.id);
        throw error;
      });
    this.connections.set(server.id, created);
    return created;
  }

  /**
   * Tools from every enabled server. A server that is down is reported in
   * `errors` and skipped, so one bad MCP entry cannot take the whole chat down.
   */
  async listTools(): Promise<{ tools: MappedMcpTool[]; errors: string[] }> {
    const tools: MappedMcpTool[] = [];
    const errors: string[] = [];
    await Promise.all(
      this.servers().map(async (server) => {
        try {
          const connection = await this.connection(server);
          for (const tool of await connection.listTools())
            tools.push({
              serverId: server.id,
              serverName: server.name,
              toolName: tool.name,
              name: mcpToolNamespace(server.id, tool.name),
              description: tool.description || `${server.name} · ${tool.name}`,
              parameters: tool.inputSchema,
            });
        } catch (error) {
          this.connections.delete(server.id);
          errors.push(`${server.name}: ${(error as Error).message}`);
        }
      }),
    );
    return { tools, errors };
  }

  async call(
    serverId: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<{ text: string; isError: boolean }> {
    const server = this.servers().find((item) => item.id === serverId);
    if (!server) throw new WorkspaceError(404, "mcp_server_not_found");
    const connection = await this.connection(server);
    try {
      return renderMcpResult(await connection.callTool(toolName, args));
    } catch (error) {
      this.connections.delete(server.id);
      throw error;
    }
  }

  /** Drops a cached connection so the next call re-reads the saved config. */
  invalidate(serverId?: string) {
    if (serverId) {
      this.connections.get(serverId)?.then(
        (connection) => connection.close(),
        () => undefined,
      );
      this.connections.delete(serverId);
      return;
    }
    for (const pending of this.connections.values())
      pending.then(
        (connection) => connection.close(),
        () => undefined,
      );
    this.connections.clear();
  }

  closeAll() {
    this.invalidate();
  }
}

/**
 * Connects to one server definition (used by the "test" button) without
 * caching the connection. Returns the tool names the server advertises.
 */
export async function probeMcpServer(
  server: MCPServer,
): Promise<{ serverInfo?: unknown; tools: string[] }> {
  const error = mcpServerError(server);
  if (error) throw new WorkspaceError(400, error);
  const connection = connect(server);
  try {
    const tools = await connection.listTools();
    return { tools: tools.map((tool) => tool.name) };
  } finally {
    connection.close();
  }
}

/** Unique helper for the UI when a new server is added. */
export function newMcpId(): string {
  return `srv_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}
