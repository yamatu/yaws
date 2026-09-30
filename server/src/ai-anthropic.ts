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
export function anthropicFailure(message: AssistantMessage): WorkspaceError {
  if (message.stopReason === "aborted")
    return new WorkspaceError(499, "cancelled");
  const text = String(message.errorMessage ?? "");
  const status = /^\s*(\d{3})\b/.exec(text)?.[1];
  if (status) return new WorkspaceError(502, `model_http_${status}`);
  // A 200 that never became an Anthropic stream means the URL is not the
  // Messages endpoint, which is the common relay mistake.
  if (/without a stop reason|refused|sensitive/i.test(text))
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
  let message: AssistantMessage | null = null;
  const events = anthropicMessagesApi().streamSimple(
    model,
    normalizeContext(context),
    {
      apiKey: config.apiKey,
      signal,
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
        throw anthropicFailure(event.error);
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
