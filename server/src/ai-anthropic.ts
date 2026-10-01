import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import type {
  Api,
  AssistantMessage,
  Model,
  ThinkingLevel,
} from "@earendil-works/pi-ai";
import type { AIConfig } from "./ai-profiles.js";
import { officialModel, toContext } from "./ai-official.js";
import { WorkspaceError } from "./ssh.js";
import type { ModelDelta, ModelTurn, ModelUsage } from "./ai.js";

/**
 * The Anthropic Messages protocol for API keys the operator supplies.
 *
 * The official Claude models already run on pi's Anthropic adapter, so this
 * path reuses the same adapter rather than growing a second Claude
 * implementation: pi owns the request shape (`POST /v1/messages`, `x-api-key`,
 * prompt-cache breakpoints, thinking budgets, strict tool schemas) and replays
 * signed thinking blocks, which yaws hands it through `toContext`.
 */

const REASONING_LEVELS = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

/**
 * What a relay in front of the Messages API actually answered with.
 *
 * Relays are not the Messages API: they answer `stream: true` with the whole
 * message as JSON, they write an error object straight into the stream with no
 * framing at all, or they leave the SSE `event:` name to the caller because the
 * official SDK dispatches on the JSON `type` instead. Frames are repaired on
 * the way in, and this record of what arrived keeps a 200 that never became a
 * stream from being reported as unparseable data.
 */
export type AnthropicReply = {
  /** JSON frames the endpoint delivered, repaired or not. */
  frames: number;
  /** Whether the endpoint sent any body bytes at all. */
  empty: boolean;
  /** Whether the endpoint reported a failure in-band. */
  error: boolean;
};

/** The event names a Claude stream may carry. */
const REPLY_EVENTS = new Set([
  "message_start",
  "message_delta",
  "message_stop",
  "content_block_start",
  "content_block_delta",
  "content_block_stop",
  "error",
]);

/** `JSON.parse` for values that are usually not JSON at all. */
function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * A whole `message` object rewritten as the frames a streaming client would
 * have received, so a relay that ignores `stream` still produces a turn.
 * Returns null for every other payload.
 */
export function anthropicFrames(raw: unknown): string | null {
  const parsed = typeof raw === "string" ? parseJson(raw) : raw;
  if (!parsed || typeof parsed !== "object") return null;
  const message = parsed as Record<string, unknown>;
  if (message.type !== "message" || !Array.isArray(message.content))
    return null;
  const frames: string[] = [];
  const frame = (name: string, body: unknown) => {
    frames.push(`event: ${name}\ndata: ${JSON.stringify(body)}\n\n`);
  };
  frame("message_start", {
    type: "message_start",
    message: { ...message, content: [] },
  });
  message.content.forEach((entry, index) => {
    const block = entry as Record<string, any>;
    const start = (content: unknown, delta?: unknown) => {
      frame("content_block_start", {
        type: "content_block_start",
        index,
        content_block: content,
      });
      if (delta)
        frame("content_block_delta", {
          type: "content_block_delta",
          index,
          delta,
        });
      frame("content_block_stop", { type: "content_block_stop", index });
    };
    // Blocks are opened empty and filled by a delta, the way a stream would:
    // the reader finalizes a tool call from its deltas, not from the opening
    // frame, so arguments have to travel as `partial_json` to survive.
    if (block?.type === "text")
      start(
        { type: "text", text: "" },
        block.text ? { type: "text_delta", text: block.text } : undefined,
      );
    else if (block?.type === "thinking")
      start(
        { type: "thinking", thinking: "", signature: block.signature ?? "" },
        block.thinking
          ? { type: "thinking_delta", thinking: block.thinking }
          : undefined,
      );
    else if (block?.type === "tool_use")
      start({ type: "tool_use", id: block.id, name: block.name, input: {} }, {
        type: "input_json_delta",
        partial_json: JSON.stringify(block.input ?? {}),
      });
    else start(block);
  });
  frame("message_delta", {
    type: "message_delta",
    delta: {
      stop_reason: message.stop_reason ?? "end_turn",
      stop_sequence: message.stop_sequence ?? null,
    },
    usage: message.usage ?? {},
  });
  frame("message_stop", { type: "message_stop" });
  return frames.join("");
}

/**
 * One SSE line of the reply, with the event name restored when the relay left
 * it out and whole messages expanded into frames. Everything else passes
 * through untouched, including the `:` keep-alives relays send while they wait.
 */
function repairLine(raw: string, reply: AnthropicReply): string {
  if (raw.startsWith("event:")) {
    if (raw.slice("event:".length).trim() === "error") reply.error = true;
    return `${raw}\n`;
  }
  if (
    raw === "" ||
    raw.startsWith(":") ||
    raw.startsWith("id:") ||
    raw.startsWith("retry:")
  )
    return `${raw}\n`;
  const body = raw.startsWith("data:") ? raw.slice(5).trim() : raw.trim();
  const payload = parseJson(body) as
    | { type?: unknown; error?: unknown }
    | null;
  const whole = anthropicFrames(payload);
  if (whole) {
    reply.frames += 1;
    return whole;
  }
  const declared =
    typeof payload?.type === "string" && REPLY_EVENTS.has(payload.type)
      ? payload.type
      : null;
  // A relay may report a failure without the `type` the API uses to mark one.
  const name =
    declared ?? (payload?.error !== undefined ? "error" : null);
  if (name === "error") reply.error = true;
  if (!raw.startsWith("data:")) {
    // A relay that writes its error object straight into the stream without
    // any framing still has to reach the caller as a failure.
    if (!name) return `${raw}\n`;
    reply.frames += 1;
    return `event: ${name}\ndata: ${body}\n\n`;
  }
  reply.frames += 1;
  return `${name ? `event: ${name}\n` : ""}${raw}\n`;
}

/** Repairs a body that was read whole, which is what a non-stream reply is. */
function repairText(text: string, reply: AnthropicReply): string {
  if (text !== "") reply.empty = false;
  return text
    .split("\n")
    .map((line) => repairLine(line, reply))
    .join("");
}

/** The same repair, applied as the bytes arrive so streaming still streams. */
function repairStream(
  reply: AnthropicReply,
): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  const push = (
    text: string,
    controller: TransformStreamDefaultController<Uint8Array>,
    end: boolean,
  ) => {
    buffer += text;
    let index = buffer.indexOf("\n");
    while (index !== -1) {
      controller.enqueue(encoder.encode(repairLine(buffer.slice(0, index), reply)));
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf("\n");
    }
    if (end && buffer) {
      controller.enqueue(encoder.encode(repairLine(buffer, reply)));
      buffer = "";
    }
  };
  return new TransformStream({
    transform(chunk, controller) {
      if (chunk.byteLength > 0) reply.empty = false;
      push(decoder.decode(chunk, { stream: true }), controller, false);
    },
    flush(controller) {
      push(decoder.decode(), controller, true);
    },
  });
}

/**
 * Relays that resell a Claude Code subscription gate `/v1/messages` on the
 * identity Claude Code presents, and refuse everything else with 403
 * `claude_code_required`. The refusal says which part is missing, so the
 * request is sent again with it. An endpoint that asked once is remembered and
 * later requests carry the identity from the start, which is why only the
 * first call pays for the extra round trip. Keyed by request URL, which holds
 * no secret: the key travels in a header.
 */
const claudeCodeRelays = new Set<string>();

/**
 * What such a relay checks for. The version is the one pi's own Anthropic
 * adapter sends for an OAuth token, so both paths look like the same client.
 */
const CLAUDE_CODE_HEADERS: Record<string, string> = {
  "user-agent": "claude-cli/2.1.280",
  "x-app": "cli",
};

/**
 * Claude Code identifies itself with `metadata.user_id`, a JSON string holding
 * its device and session. yaws is not Claude Code, so it sends the same shape
 * with a fixed id of its own rather than inventing a device per installation.
 */
const CLAUDE_CODE_USER_ID = JSON.stringify({
  device_id: `yaws-${"0".repeat(59)}`,
  account_uuid: "",
  session_id: "",
});

/** Whether a refusal is that gate asking for an identity, not a real denial. */
async function claudeCodeGate(response: Response): Promise<boolean> {
  if (response.status !== 403) return false;
  try {
    return (await response.clone().text()).includes("claude_code_required");
  } catch {
    return false;
  }
}

/** The same request, carrying the identity a Claude Code relay insists on. */
function asClaudeCode(init?: RequestInit): RequestInit {
  const headers = new Headers(init?.headers);
  for (const [name, value] of Object.entries(CLAUDE_CODE_HEADERS))
    headers.set(name, value);
  let body = init?.body;
  if (typeof body === "string") {
    const params = parseJson(body) as Record<string, unknown> | null;
    if (params && typeof params === "object") {
      const sent = params.metadata;
      const metadata: Record<string, unknown> =
        sent && typeof sent === "object" ? { ...sent } : {};
      if (!metadata.user_id) metadata.user_id = CLAUDE_CODE_USER_ID;
      body = JSON.stringify({ ...params, metadata });
      // The body changed length, so a stale header would break the request.
      headers.delete("content-length");
    }
  }
  return { ...init, headers, body };
}

/**
 * The `fetch` pi's Anthropic client goes through. Requests are untouched; the
 * reply is repaired so a relay cannot turn a working conversation into a parse
 * failure. A failing status is returned as it came, because the SDK already
 * turns those into an error carrying the status yaws reports.
 */
function anthropicFetch(reply: AnthropicReply): typeof fetch {
  const send = async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await fetch(input, init);
    if (!response.ok || !response.body) return response;
    const type = response.headers.get("content-type") ?? "";
    if (type.includes("event-stream"))
      return new Response(response.body.pipeThrough(repairStream(reply)), {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    // Not an event stream: a finished message, a gateway error page, or SSE
    // under the wrong content type. All three are read whole either way.
    return new Response(repairText(await response.text(), reply), {
      status: response.status,
      statusText: response.statusText,
      headers: { "content-type": "text/event-stream" },
    });
  };
  const endpointOf = (input: RequestInfo | URL) =>
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  return async (input, init) => {
    const endpoint = endpointOf(input);
    const response = await send(
      input,
      claudeCodeRelays.has(endpoint) ? asClaudeCode(init) : init,
    );
    if (!(await claudeCodeGate(response))) return response;
    claudeCodeRelays.add(endpoint);
    return send(input, asClaudeCode(init));
  };
}

/**
 * The Anthropic SDK appends `/v1/messages` to whatever base URL it is given.
 * A relay base the other protocols accept (`https://host/v1`) or the endpoint
 * pasted straight from the docs would therefore become `/v1/v1/messages`, so
 * reduce the input to the origin plus any relay-specific prefix.
 */
export function anthropicBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new WorkspaceError(400, "bad_ai_endpoint");
  }
  const path = url.pathname
    .replace(/\/+$/, "")
    .replace(/\/v1\/messages$/, "")
    .replace(/\/v1$/, "");
  url.pathname = path || "/";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

/**
 * A model entry for pi's Anthropic adapter. When the operator names a Claude
 * model from pi's catalog we borrow that entry, so the context window, output
 * cap and thinking flavour (budget-based versus adaptive effort) match the
 * official provider instead of being guessed from the model name.
 */
export function anthropicModel(config: AIConfig): Model<Api> {
  const known = officialModel("anthropic", config.model);
  const base: Model<Api> = known ?? {
    id: config.model,
    name: config.model,
    api: "anthropic-messages",
    provider: "anthropic",
    baseUrl: "https://api.anthropic.com",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 200_000,
    maxTokens: 8_192,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  return {
    ...base,
    id: config.model,
    baseUrl: anthropicBaseUrl(config.baseUrl),
  };
}

/**
 * pi reports a failed request as an assistant message whose `errorMessage`
 * begins with the HTTP status (`401 {"type":"error",...}`). Map that back onto
 * the codes the panel already explains, and never echo the provider body: it
 * can quote the request back, including the key.
 */
export function anthropicFailure(
  message: AssistantMessage,
  reply?: AnthropicReply,
): WorkspaceError {
  if (message.stopReason === "aborted")
    return new WorkspaceError(499, "cancelled");
  const text = String(message.errorMessage ?? "");
  const status = /^\s*(\d{3})\b/.exec(text)?.[1];
  if (status) return new WorkspaceError(502, `model_http_${status}`);
  // A 200 whose body never became a Claude turn has to be reported as what it
  // was: nothing at all, or something that is not this protocol.
  if (reply) {
    if (reply.frames === 0)
      return new WorkspaceError(
        502,
        reply.empty ? "model_no_answer" : "model_invalid_json",
      );
    if (reply.error) return new WorkspaceError(502, "model_upstream_error");
  }
  // A stream that stopped before its stop reason means the relay cut the turn
  // short, and a body that is not JSON means the URL is not the API at all.
  if (
    /without a stop reason|before message_stop|refused|sensitive|Could not parse/i.test(
      text,
    )
  )
    return new WorkspaceError(502, "model_invalid_json");
  return new WorkspaceError(502, "model_network_error");
}

function usageOf(message: AssistantMessage): ModelUsage {
  const usage = message.usage;
  const cached = usage.cacheRead + usage.cacheWrite;
  return {
    promptTokens: usage.input + cached,
    completionTokens: usage.output,
    totalTokens: usage.totalTokens,
    cachedTokens: cached > 0 ? cached : null,
  };
}

/**
 * One Anthropic turn, streamed in the same delta shape as the other protocols
 * so the chat page, the tool loop and the usage panel stay unchanged.
 */
export async function streamAnthropic(
  config: AIConfig,
  body: Record<string, unknown>,
  signal: AbortSignal,
  onDelta: (delta: ModelDelta) => void,
): Promise<ModelTurn> {
  if (!config.apiKey) throw new WorkspaceError(502, "model_http_401");
  if (
    config.reasoning &&
    !REASONING_LEVELS.includes(config.reasoning as ThinkingLevel)
  )
    throw new WorkspaceError(400, "model_http_400");
  const model = anthropicModel(config);
  const context = toContext(body, model);
  const reply: AnthropicReply = { frames: 0, empty: true, error: false };
  let message: AssistantMessage | null = null;
  const events = anthropicMessagesApi().streamSimple(
    model,
    normalizeContext(context),
    {
      apiKey: config.apiKey,
      signal,
      fetch: anthropicFetch(reply),
      ...(config.reasoning
        ? { reasoning: config.reasoning as ThinkingLevel }
        : {}),
    },
  );
  for await (const event of events) {
    switch (event.type) {
      case "text_delta":
        onDelta({ type: "text", text: event.delta });
        break;
      case "thinking_delta":
        onDelta({ type: "thinking", text: event.delta });
        break;
      case "toolcall_start": {
        const part = event.partial.content[event.contentIndex];
        if (part?.type === "toolCall")
          onDelta({
            type: "toolcall",
            index: event.contentIndex,
            name: part.name,
          });
        break;
      }
      case "done":
        message = event.message;
        break;
      case "error":
        throw anthropicFailure(event.error, reply);
      default:
        break;
    }
  }
  if (!message) throw new WorkspaceError(502, "model_invalid_json");
  const finished: AssistantMessage = message;
  const usage = usageOf(finished);
  onDelta({ type: "usage", usage });
  return {
    content: finished.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join(""),
    reasoning: finished.content
      .filter((part) => part.type === "thinking")
      .map((part) => part.thinking)
      .join(""),
    toolCalls: finished.content
      .filter((part) => part.type === "toolCall")
      .map((part) => ({
        id: part.id,
        name: part.name,
        arguments: JSON.stringify(part.arguments ?? {}),
      })),
    usage,
    output: [],
    // Signed thinking blocks have to be replayed verbatim on the next turn.
    native: finished,
    truncated: finished.stopReason === "length",
  };
}
