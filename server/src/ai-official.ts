import { randomUUID } from "node:crypto";
import {
  createModels,
  ModelsError,
  type AuthEvent,
  type AuthPrompt,
  type Credential,
  type CredentialStore,
  type Model,
  type Provider,
  type Api,
  type Context,
  type AssistantMessage,
  type Tool,
} from "@earendil-works/pi-ai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import {
  githubCopilotProvider,
} from "@earendil-works/pi-ai/providers/github-copilot";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { encryptText, decryptText } from "./crypto.js";
import type { Db } from "./db.js";
import { WorkspaceError } from "./ssh.js";
import type { AIConfig } from "./ai-profiles.js";
import type { ModelDelta, ModelTurn } from "./ai.js";

/** These are the built-in pi providers we have tested with the yaws tool loop. */
export const OFFICIAL_PROVIDERS = [
  "openai-codex", "anthropic", "github-copilot", "openrouter",
] as const;
export type OfficialProvider = (typeof OFFICIAL_PROVIDERS)[number];
export function officialProvider(id: string): id is OfficialProvider {
  return OFFICIAL_PROVIDERS.some((value) => value === id);
}

/** Official endpoints/models are never supplied by the browser. */
const providers = new Map<string, Provider>(
  [openaiCodexProvider(), anthropicProvider(), githubCopilotProvider(),
    openrouterProvider()].map((provider) => [provider.id, provider]),
);
export function officialCatalog() {
  return OFFICIAL_PROVIDERS.map((id) => {
    const provider = providers.get(id)!;
    return {
      id,
      name: provider.name,
      baseUrl: provider.baseUrl!,
      models: provider.getModels().map((model) => ({
        id: model.id, name: model.name,
      })),
    };
  });
}
export function officialModel(id: string, model: string): Model<Api> | undefined {
  return providers.get(id)?.getModels().find((entry) => entry.id === model);
}
export function checkOfficialConfig(config: AIConfig) {
  const id = config.officialProvider;
  if (!id) return;
  if (!officialProvider(id) || !officialModel(id, config.model))
    throw new WorkspaceError(400, "official_model_invalid");
  if (
    config.baseUrl !== providers.get(id)!.baseUrl ||
    config.apiKey || config.allowPrivate || config.protocol !== "chat" ||
    (!!config.reasoning && !["minimal", "low", "medium", "high", "xhigh", "max"]
      .includes(config.reasoning))
  ) throw new WorkspaceError(400, "official_model_invalid");
}

/**
 * The app's encrypted settings table is the credential store, not pi's
 * ~/.pi/agent/auth.json (which would mix yaws and a local CLI installation).
 * pi-ai performs refresh under `modify`; serialize modifications per provider
 * so concurrent conversations cannot rotate the same refresh token twice.
 */
export class OfficialCredentials implements CredentialStore {
  private locks = new Map<string, Promise<void>>();
  constructor(private db: Db, private secret: string) {}
  private key(id: string) { return `ai_official_auth_${id}`; }
  async read(id: string): Promise<Credential | undefined> {
    if (!officialProvider(id)) return undefined;
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?")
      .get(this.key(id)) as { value: string } | undefined;
    if (!row) return undefined;
    try { return JSON.parse(decryptText(row.value, this.secret)) as Credential; }
    catch { throw new WorkspaceError(500, "official_auth_corrupt"); }
  }
  async list() {
    const ids = [];
    for (const id of OFFICIAL_PROVIDERS) {
      const credential = await this.read(id);
      if (credential) ids.push({ providerId: id, type: credential.type });
    }
    return ids;
  }
  private async serialized<T>(id: string, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(id) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => { release = resolve; });
    this.locks.set(id, next);
    await previous;
    try { return await work(); }
    finally {
      if (this.locks.get(id) === next) this.locks.delete(id);
      release();
    }
  }
  async modify(
    id: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ) {
    if (!officialProvider(id))
      throw new WorkspaceError(400, "official_model_invalid");
    return this.serialized(id, async () => {
      const credential = await fn(await this.read(id));
      if (credential) {
        // Never persist an implausibly large or malformed credential.
        const text = JSON.stringify(credential);
        if (text.length > 32_000 || !["api_key", "oauth"].includes(credential.type))
          throw new WorkspaceError(400, "official_auth_failed");
        this.db.prepare(`INSERT INTO settings (key,value,updated_at) VALUES (?,?,?)
          ON CONFLICT(key) DO UPDATE SET value=excluded.value,
            updated_at=excluded.updated_at`)
          .run(this.key(id), encryptText(text, this.secret), Date.now());
      }
      return credential;
    });
  }
  async delete(id: string) {
    if (!officialProvider(id))
      throw new WorkspaceError(400, "official_model_invalid");
    await this.serialized(id, async () => {
      this.db.prepare("DELETE FROM settings WHERE key = ?").run(this.key(id));
    });
  }
}

type PendingPrompt = {
  resolve: (value: string) => void;
  reject: (reason: Error) => void;
  signal?: AbortSignal;
  abort?: () => void;
};
type Login = {
  provider: OfficialProvider;
  userId: number;
  controller: AbortController;
  status: "running" | "done" | "failed" | "cancelled";
  event: AuthEvent | { type: "prompt"; message: string; secret?: boolean;
    options?: readonly { id: string; label: string }[] } | null;
  authEvent: Extract<AuthEvent, { type: "auth_url" | "device_code" }> | null;
  pending: PendingPrompt | null;
  createdAt: number;
};

export class OfficialModels {
  readonly credentials: OfficialCredentials;
  readonly models;
  private logins = new Map<string, Login>();
  constructor(db: Db, secret: string, overrides: readonly Provider[] = []) {
    this.credentials = new OfficialCredentials(db, secret);
    this.models = createModels({ credentials: this.credentials });
    for (const id of OFFICIAL_PROVIDERS) this.models.setProvider(providers.get(id)!);
    for (const provider of overrides) {
      if (!officialProvider(provider.id))
        throw new WorkspaceError(400, "official_model_invalid");
      this.models.setProvider(provider);
    }
  }
  async catalog() {
    const catalog = officialCatalog();
    return Promise.all(catalog.map(async (item) => {
      const credential = await this.credentials.read(item.id);
      const available = providers.get(item.id)!.filterModels?.(
        providers.get(item.id)!.getModels(), credential,
      );
      return {
        ...item,
        connected: !!credential,
        // Copilot's account can have fewer models enabled than the catalog.
        models: available?.map((model) => ({ id: model.id, name: model.name }))
          ?? item.models,
      };
    }));
  }
  start(id: string, userId: number) {
    if (!officialProvider(id))
      throw new WorkspaceError(400, "official_model_invalid");
    for (const login of this.logins.values())
      if (login.provider === id && login.status === "running")
        throw new WorkspaceError(409, "official_login_busy");
    // Only finished attempts are pruned. Never abort another login to make room.
    for (const [key, login] of this.logins)
      if (login.status !== "running" && Date.now() - login.createdAt > 300_000)
        this.logins.delete(key);
    const loginId = randomUUID();
    const login: Login = {
      provider: id, userId, controller: new AbortController(),
      status: "running", event: null, authEvent: null,
      pending: null, createdAt: Date.now(),
    };
    this.logins.set(loginId, login);
    const timer = setTimeout(() => login.controller.abort(), 10 * 60_000);
    timer.unref?.();
    void this.models.login(id, "oauth", {
      signal: login.controller.signal,
      notify: (event) => {
        if (login.status !== "running") return;
        // Fail closed rather than displaying or silently discarding an OAuth
        // link pointed at a host other than that provider's real login site.
        if ((event.type === "auth_url" && !safeAuthUrl(event.url, id)) ||
          (event.type === "device_code" &&
            !safeAuthUrl(event.verificationUri, id))) {
          login.status = "failed";
          login.controller.abort();
          return;
        }
        if (event.type === "auth_url" || event.type === "device_code")
          login.authEvent = event;
        else if (!login.pending) login.event = event;
      },
      prompt: async (prompt) => {
        // Device authorization works across computers; unlike a loopback
        // callback, it does not require the browser to run on the panel host.
        if (id === "openai-codex" && prompt.type === "select") {
          const device = prompt.options.find((option) => /device/i.test(option.id));
          if (device) return device.id;
        }
        // An arbitrary Enterprise host is not an official endpoint whitelist
        // entry. Don't let a browser-supplied domain receive OAuth traffic.
        if (id === "github-copilot" && prompt.type === "text" &&
          prompt.message.includes("GitHub Enterprise")) return "";
        return this.prompt(login, prompt);
      },
    }).then(() => {
      if (login.status === "running") { login.status = "done"; login.event = null; }
    }).catch(() => {
      if (login.status === "running") {
        login.status = login.controller.signal.aborted ? "cancelled" : "failed";
        // Provider errors may contain tokens; never return them to the UI.
        login.event = null;
      }
    }).finally(() => {
      clearTimeout(timer);
      login.pending?.reject(new Error("login ended"));
      login.pending = null;
    });
    return { loginId };
  }
  private prompt(login: Login, prompt: AuthPrompt): Promise<string> {
    if (login.controller.signal.aborted)
      return Promise.reject(new Error("cancelled"));
    return new Promise<string>((resolve, reject) => {
      const abort = () => {
        login.pending = null;
        reject(new Error("cancelled"));
      };
      login.pending = { resolve, reject, signal: prompt.signal, abort };
      login.event = {
        type: "prompt", message: prompt.message,
        secret: prompt.type === "secret",
        ...(prompt.type === "select" ? {
          options: prompt.options.map(({ id, label }) => ({ id, label })),
        } : {}),
      };
      prompt.signal?.addEventListener("abort", abort, { once: true });
      login.controller.signal.addEventListener("abort", abort, { once: true });
    });
  }
  private owned(loginId: string, userId: number) {
    const login = this.logins.get(loginId);
    if (!login || login.userId !== userId)
      throw new WorkspaceError(404, "not_found");
    return login;
  }
  status(loginId: string, userId: number) {
    const { status, event, authEvent, provider } = this.owned(loginId, userId);
    return { status, event, authEvent: status === "running" ? authEvent : null,
      provider };
  }
  answer(loginId: string, userId: number, value: string) {
    const login = this.owned(loginId, userId);
    const pending = login.pending;
    if (login.status !== "running" || !pending || !value || value.length > 4096)
      throw new WorkspaceError(409, "official_login_step");
    if (login.event?.type === "prompt" && login.event.options?.length &&
      !login.event.options.some((option) => option.id === value))
      throw new WorkspaceError(400, "official_login_step");
    pending.signal?.removeEventListener("abort", pending.abort!);
    login.controller.signal.removeEventListener("abort", pending.abort!);
    login.pending = null;
    login.event = { type: "progress", message: "正在完成授权…" };
    pending.resolve(value);
  }
  cancel(loginId: string, userId: number) {
    const login = this.owned(loginId, userId);
    if (login.status === "running") {
      login.status = "cancelled";
      login.controller.abort();
    }
  }
  async logout(id: string) {
    if (!officialProvider(id))
      throw new WorkspaceError(400, "official_model_invalid");
    for (const login of this.logins.values())
      if (login.provider === id && login.status === "running")
        throw new WorkspaceError(409, "official_login_busy");
    await this.models.logout(id);
  }
  async stream(
    config: AIConfig, body: Record<string, unknown>, signal: AbortSignal,
    onDelta: (delta: ModelDelta) => void,
  ): Promise<ModelTurn> {
    checkOfficialConfig(config);
    const model = this.models.getModel(config.officialProvider, config.model);
    if (!model) throw new WorkspaceError(400, "official_model_invalid");
    if (!await this.credentials.read(config.officialProvider))
      throw new WorkspaceError(409, "official_not_logged_in");
    if (!(await this.models.getAvailable(config.officialProvider))
      .some((entry) => entry.id === model.id))
      throw new WorkspaceError(409, "official_model_unavailable");
    const context = toContext(body, model);
    let message: AssistantMessage | null = null;
    try {
      const events = this.models.streamSimple(model, context, {
        signal,
        ...(config.reasoning ? {
          reasoning: config.reasoning as "minimal" | "low" | "medium" |
            "high" | "xhigh" | "max",
        } : {}),
      });
      for await (const event of events) {
        if (event.type === "text_delta")
          onDelta({ type: "text", text: event.delta });
        if (event.type === "thinking_delta")
          onDelta({ type: "thinking", text: event.delta });
        if (event.type === "toolcall_start") {
          const call = event.partial.content[event.contentIndex];
          if (call?.type === "toolCall") onDelta({
            type: "toolcall", index: event.contentIndex, name: call.name,
          });
        }
        if (event.type === "done") message = event.message;
        if (event.type === "error")
          throw new WorkspaceError(502, "official_model_failed");
      }
    } catch (error) {
      if (signal.aborted) throw new WorkspaceError(499, "cancelled");
      if (error instanceof WorkspaceError) throw error;
      if (error instanceof ModelsError && error.code === "oauth")
        throw new WorkspaceError(401, "official_auth_expired");
      // Provider errors may include request headers or tokens. Never echo them.
      throw new WorkspaceError(502, "official_model_failed");
    }
    if (!message) throw new WorkspaceError(502, "official_model_failed");
    const usage = message.usage;
    if (usage) onDelta({
      type: "usage", usage: {
        promptTokens: usage.input + usage.cacheRead + usage.cacheWrite,
        completionTokens: usage.output,
        totalTokens: usage.totalTokens,
        cachedTokens: usage.cacheRead > 0 ? usage.cacheRead : null,
      },
    });
    return {
      content: message.content.filter((item) => item.type === "text")
        .map((item) => item.text).join(""),
      reasoning: message.content.filter((item) => item.type === "thinking")
        .map((item) => item.thinking).join(""),
      toolCalls: message.content.filter((item) => item.type === "toolCall")
        .map((item) => ({
          id: item.id, name: item.name, arguments: JSON.stringify(item.arguments),
        })),
      usage: usage ? {
        promptTokens: usage.input + usage.cacheRead + usage.cacheWrite,
        completionTokens: usage.output,
        totalTokens: usage.totalTokens,
        cachedTokens: usage.cacheRead > 0 ? usage.cacheRead : null,
      } : null,
      output: [], native: message,
      truncated: message.stopReason === "length",
    };
  }
}

const AUTH_HOSTS: Record<OfficialProvider, string> = {
  "openai-codex": "auth.openai.com",
  anthropic: "claude.ai",
  "github-copilot": "github.com",
  openrouter: "openrouter.ai",
};
function safeAuthUrl(value: string, id: OfficialProvider) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === AUTH_HOSTS[id] &&
      !url.username && !url.password && !url.port;
  } catch { return false; }
}

/** Translate yaws's Chat Completions history to pi's native, provider-neutral
 * messages. This preserves tool calls/results across every round; replayed
 * finished turns are text only, as they were before official login support. */
export function toContext(
  body: Record<string, unknown>, model: Model<Api>,
): Context {
  const raw = body.messages as Array<Record<string, any>> | undefined;
  if (!Array.isArray(raw)) throw new WorkspaceError(400, "official_model_invalid");
  const context: Context = { messages: [], tools: [] };
  for (const item of raw) {
    if (item.role === "system") {
      context.systemPrompt = String(item.content ?? "");
      continue;
    }
    if (item.role === "user") {
      context.messages.push({
        role: "user", content: String(item.content ?? ""),
        timestamp: Date.now(),
      });
    } else if (item.role === "assistant") {
      const native = item.native as AssistantMessage | undefined;
      if (native?.role === "assistant" && native.provider === model.provider &&
        native.model === model.id && Array.isArray(native.content)) {
        context.messages.push(native);
        continue;
      }
      const content: AssistantMessage["content"] = [];
      if (item.content) content.push({ type: "text", text: String(item.content) });
      for (const call of item.tool_calls ?? []) {
        let args: Record<string, unknown> = {};
        try { args = JSON.parse(call.function.arguments); } catch { /* old call */ }
        content.push({ type: "toolCall", id: call.id,
          name: call.function.name, arguments: args });
      }
      context.messages.push({ role: "assistant", content,
        api: model.api, provider: model.provider, model: model.id,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
          totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0,
            cacheWrite: 0, total: 0 } },
        stopReason: item.tool_calls?.length ? "toolUse" : "stop",
        timestamp: Date.now(),
      });
    } else if (item.role === "tool") {
      const previous = [...context.messages].reverse()
        .find((value) => value.role === "assistant" &&
          value.content.some((part) => part.type === "toolCall" &&
            part.id === item.tool_call_id));
      const call = previous?.role === "assistant" ? previous.content
        .find((part) => part.type === "toolCall" &&
          part.id === item.tool_call_id) : null;
      context.messages.push({ role: "toolResult",
        toolCallId: item.tool_call_id,
        toolName: call?.type === "toolCall" ? call.name : "tool",
        content: [{ type: "text", text: String(item.content ?? "") }],
        isError: false, timestamp: Date.now() });
    }
  }
  const rawTools = body.tools as Array<{ function: Tool }> | undefined;
  context.tools = (rawTools ?? []).map((entry) => entry.function);
  return context;
}
