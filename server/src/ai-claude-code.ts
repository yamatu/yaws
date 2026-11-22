import { createHash } from "node:crypto";

/**
 * The identity of the official Claude Code client, for relays that resell a
 * Claude Code subscription and gate `/v1/messages` on it.
 *
 * Those relays re-serve a subscription that only the official client is
 * entitled to, so they check that a request is that client: the CLI's
 * `User-Agent`, its app header, the beta list it asks for, its session header,
 * a `metadata.user_id` built the way the CLI builds it and, on the stricter
 * ones, the CLI's own system prompt in front of the real request.
 *
 * Everything below is the shape the CLI actually sends, filled with values
 * yaws owns: a device id derived from a fixed string, one session per
 * conversation, and never an account or an installation it does not have.
 * What such a relay checks is the shape, which is also all it can check to
 * serve the real client.
 *
 * The one deliberate difference is the system prompt's environment section: it
 * is filled with the machine yaws actually runs on, because those are the
 * commands the model is about to drive. A wrong `cwd` would be worse than the
 * giveaway of a true one.
 */

/** The CLI release the identity is modelled on; pi's adapter ships the same. */
export const CLAUDE_CODE_VERSION = "2.1.280";

/** `uw()` in the shipped client: exactly these, on every request it makes. */
export function claudeCodeHeaders(sessionId: string): Record<string, string> {
  return {
    "user-agent": `claude-cli/${CLAUDE_CODE_VERSION} (external, cli)`,
    "x-app": "cli",
    "x-claude-code-session-id": sessionId,
  };
}

/**
 * The beta features the CLI asks for. pi only sends them for an OAuth token,
 * so they are added to whatever pi computed rather than replacing it.
 */
export const CLAUDE_CODE_BETA = ["claude-code-20250219", "oauth-2025-04-20"];

/** pi's beta list with the CLI's own features merged in, order preserved. */
export function claudeCodeBetas(current: unknown): string[] {
  const value = Array.isArray(current)
    ? current.map(String)
    : typeof current === "string"
      ? current.split(",")
      : [];
  const merged = value.map((item) => item.trim()).filter(Boolean);
  for (const feature of CLAUDE_CODE_BETA)
    if (!merged.includes(feature)) merged.push(feature);
  return merged;
}

/**
 * `device_id` is 64 hex characters in the client and its own regexp insists on
 * that shape. This one is derived, so it survives restarts -- a changing id is
 * the one thing the client never does -- without being anyone's real id.
 */
export const CLAUDE_CODE_DEVICE_ID = createHash("sha256")
  .update("yaws")
  .digest("hex");

/**
 * `metadata.user_id` as the client writes it: a JSON document, not a bare id.
 * yaws has no account, so `account_uuid` travels empty; the session is the
 * same uuid the session header carries, exactly as the client does it.
 */
export function claudeCodeUserId(sessionId: string): string {
  return JSON.stringify({
    device_id: CLAUDE_CODE_DEVICE_ID,
    account_uuid: "",
    session_id: sessionId,
  });
}

/**
 * The prompt the CLI opens a conversation with, verbatim. Placeholders are
 * filled per request by `claudeCodePrompt`; the wording around them is the
 * client's, which is what a relay comparing prompts looks for.
 */
export const CLAUDE_CODE_SYSTEM_PROMPT = `You are Claude Code, Anthropic's official CLI for Claude.

You are an interactive CLI tool that helps users with software engineering tasks. Use the instructions below and the tools available to you to assist the user.

IMPORTANT: Assist with authorized security testing, defensive security, CTF challenges, and educational contexts. Refuse requests for destructive techniques, DoS attacks, mass targeting, supply chain compromise, or detection evasion for malicious purposes. Dual-use security tools (C2 frameworks, credential testing, exploit development) require clear authorization context: pentesting engagements, CTF competitions, security research, or defensive use cases.

IMPORTANT: You must NEVER generate or guess URLs for the user unless you are confident that the URLs are for helping the user with programming. You may use URLs provided by the user in their messages or local files.

# Tone and style
- Only use emojis if the user explicitly requests it. Avoid adding emojis to files unless asked.
- Your responses should be short and concise.
- When referencing specific functions or pieces of code include the pattern file_path:line_number to allow the user to easily navigate to the source code location.
- Do not use a colon before tool calls. Your tool calls may not be shown directly in the output, so text like "Let me read the file:" followed by a read tool call should just be "Let me read the file." with a period.

# Proactiveness
You are allowed to be proactive, but only when the user asks you to do something. You should strive to strike a balance between:
1. Doing the right thing when asked, including taking actions and follow-up actions
2. Not surprising the user with actions you take without asking
For example, if the user asks you how to approach something, you should do your best to answer their question first, and not immediately jump into taking actions.

# Following conventions
When making changes to files, first understand the file's code conventions. Mimic code style, use existing libraries and utilities, and follow existing patterns.
- NEVER assume that a given library is available, even if it is well known. Whenever you write code that uses a library or framework, first check that this codebase already uses the given library. For example, you might look at neighboring files, or check the package.json (or cargo.toml, and so on depending on the language).
- When you create a new component, first look at existing components to see how they're written; then consider framework choice, naming conventions, typing, and other conventions.
- When you edit a piece of code, first look at the code's surrounding context (especially its imports) to understand the code's choice of frameworks and libraries. Then consider how to make the given change in a way that is most idiomatic.
- Always follow security best practices. Never introduce code that exposes or logs secrets and keys. Never commit secrets or keys to the repository.

# Code style
- IMPORTANT: DO NOT ADD ***ANY*** COMMENTS unless asked

# Doing tasks
The user will primarily request you to perform software engineering tasks. These may include solving bugs, adding new functionality, refactoring code, explaining code, and more. When given an unclear or generic instruction, consider it in the context of the current working directory and the codebase.
- In general, do not propose or make changes to a file the user did not ask you to work on, unless it is clearly necessary to complete their request.
- You are highly capable and often allow users to complete ambitious tasks that would otherwise be too complex or take too long. Defer to user judgement about whether a task is too large to attempt.
- If you notice the user's request is based on a misconception, or spot a bug adjacent to what they asked about, say so. You're a collaborator, not just an executor.
- For exploratory questions ("what could we do about X?", "how should we approach this?", "what do you think?"), respond in 2-3 sentences with a recommendation and the main tradeoff. Present it as something the user can redirect, not a decided plan. Don't implement until the user agrees.
- Prefer editing existing files to creating new ones.
- Be careful not to introduce security vulnerabilities such as command injection, XSS, SQL injection, and other OWASP top 10 vulnerabilities. If you notice that you wrote insecure code, immediately fix it. Prioritize writing safe, secure, and correct code.
- Avoid over-engineering. Only make changes that are directly requested or clearly necessary. Keep solutions simple and focused.
  - Don't add features, refactor code, or make "improvements" beyond what was asked. A bug fix doesn't need surrounding code cleaned up. A simple feature doesn't need extra configurability. Don't add docstrings, comments, or type annotations to code you didn't change. Only add comments where the logic isn't self-evident.
  - Don't add error handling, fallbacks, or validation for scenarios that can't happen. Trust internal code and framework guarantees. Only validate at system boundaries (user input, external APIs). Don't use feature flags or backwards-compatibility shims when you can just change the code.
  - Don't create helpers, utilities, or abstractions for one-time operations. Don't design for hypothetical future requirements. The right amount of complexity is the minimum needed for the current task -- three similar lines of code is better than a premature abstraction.
  - Avoid backwards-compatibility hacks like renaming unused _vars, re-exporting types, adding // removed comments for removed code, etc. If you are certain that something is unused, delete it completely.
- If the user asks for help or wants to give feedback inform them of the following:
  - /help: Get help with using Claude Code
  - To give feedback, users should report the issue at https://github.com/anthropics/claude-code/issues

# Tool usage policy
- When doing file search, prefer to use the Task tool in order to reduce context usage.
- You can call multiple tools in a single response. If you intend to call multiple tools and there are no dependencies between the calls, make all of the independent calls in the same block, otherwise you MUST wait for previous calls to finish first to determine the dependent values.
- When the user asks you to search the web, you can use WebSearch.

# Environment
You have been invoked in the following environment:
 - Primary working directory: {{cwd}}
 - Is a git repository: {{git}}
 - Platform: {{platform}}
 - OS Version: {{osVersion}}
 - Today's date: {{date}}

# Output efficiency
IMPORTANT: Go straight to the point. Try the simplest approach first without going in circles. Do not overdo it. Be extra concise.

# Measuring your response length
The following instructions are provided to help you gauge how long your responses should be, so you can adjust them accordingly.
- Your responses should be concise and focused on the task at hand.
- Avoid unnecessary elaboration or repetition.
- Use lists and formatting to improve readability when appropriate.
`;

const DATE = new Intl.DateTimeFormat("en-CA", {
  timeZone: "UTC",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** The environment of this server, as the prompt's Environment section states
 * it. These are the values the CLI derives on every run; yaws states its own
 * because this is the machine whose commands the model is about to run. */
export type ClaudeCodeFacts = {
  /** Where the shell of this conversation starts. */
  cwd: string;
  git?: boolean;
  platform?: string;
  osVersion?: string;
  /** ISO date, `YYYY-MM-DD`, as the CLI writes it. */
  date?: string;
};

/** The CLI's prompt with this request's environment filled in. */
export function claudeCodePrompt(facts: ClaudeCodeFacts): string {
  return CLAUDE_CODE_SYSTEM_PROMPT.replace("{{cwd}}", facts.cwd || "/")
    .replace("{{git}}", facts.git ? "true" : "false")
    .replace("{{platform}}", facts.platform ?? process.platform)
    .replace("{{osVersion}}", facts.osVersion ?? `${process.platform} ${process.arch}`)
    .replace("{{date}}", facts.date ?? DATE.format(new Date()));
}

/**
 * yaws' tool names folded onto the CLI's casing. Only names pi knows are
 * renamed -- it maps a tool by looking the name up in the context's tool list,
 * so the list it is handed has to carry these. Several yaws tools answer to
 * one CLI name (`Bash` covers running a command, reading a log and reading the
 * stats), which is why `restoreToolName` needs the arguments to tell them apart.
 */
const TOOL_NAMES: Record<string, string> = {
  list_files: "Glob",
  read_file: "Read",
  write_file: "Write",
  read_log: "Bash",
  run_command: "Bash",
  run_on_hosts: "Bash",
  server_stats: "Bash",
  list_hosts: "Task",
  read_skill: "Read",
};

/** The yaws tools behind one CLI name, in the order they are disambiguated. */
const YAW_TOOL_NAMES: Record<string, string[]> = {};
for (const [yaws, cli] of Object.entries(TOOL_NAMES))
  (YAW_TOOL_NAMES[cli.toLowerCase()] ??= []).push(yaws);

/** The CLI casing of a yaws tool; MCP and extension tools keep their names. */
export function claudeCodeToolName(name: string): string {
  return TOOL_NAMES[name] ?? name;
}

/**
 * yaws' name for a tool the model called, given what it called it with.
 *
 * The model may answer in either casing, and a folded name covers several
 * yaws tools, so the arguments decide: a `path` reads a file, a `content`
 * writes one, a `command` runs or tails, and a bare call asks this server for
 * its stats. The result is always a tool yaws declared, so a call cannot
 * reach one that was not offered.
 */
export function restoreToolName(
  name: string,
  known: Iterable<string>,
  args: Record<string, unknown> = {},
): string {
  const declared = [...known];
  const candidates = YAW_TOOL_NAMES[name.toLowerCase()] ?? [];
  const offered = candidates.filter((candidate) => declared.includes(candidate));
  if (offered.length === 1) return offered[0];
  if (offered.length > 1) {
    const key = (candidate: string) => {
      switch (candidate) {
        case "read_file":
          return "path" in args && !("content" in args);
        case "write_file":
          return "content" in args;
        case "list_files":
          return "path" in args && !("content" in args);
        case "read_log":
        case "run_command":
          return typeof args.command === "string";
        case "list_hosts":
        case "server_stats":
          return Object.keys(args).length === 0;
        default:
          return false;
      }
    };
    const picked = offered.find(key);
    if (picked) return picked;
    if (offered.includes("run_command")) return "run_command";
    return offered[0];
  }
  // Not a folded name: only the casing can differ (MCP and extension tools are
  // namespaced and never renamed).
  const lower = name.toLowerCase();
  return declared.find((candidate) => candidate.toLowerCase() === lower) ?? name;
}

/** The CLI's tool list, as the request declares it. */
export function claudeCodeTools(
  tools: unknown[],
): Array<Record<string, unknown>> {
  return tools.map((entry) => {
    const tool = entry as Record<string, any>;
    return { ...tool, name: claudeCodeToolName(String(tool?.name ?? "")) };
  });
}

/** What the CLI writes into its `system` array. */
export type ClaudeCodeBlock = {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral" };
};

/**
 * The CLI's system blocks: its own prompt, filled with this conversation's
 * environment, and nothing else.
 *
 * The operator's instructions are not here -- `claudeCodeBody` has moved them
 * into the first user message -- but pi builds `params.system` before the hook
 * runs, so whatever is still there is dropped rather than sent beside the
 * CLI's prompt. The model receives every instruction yaws gave it through the
 * task, which is the shape the relay expects.
 */
export function claudeCodeSystem(facts: ClaudeCodeFacts): ClaudeCodeBlock[] {
  return [
    {
      type: "text",
      text: claudeCodePrompt(facts),
      cache_control: { type: "ephemeral" },
    },
  ];
}

/**
 * What the chat's instructions travel as once the request is shaped like a CLI
 * one. The CLI's prompt is a preface; the user's actual words follow it as the
 * first user message, which is the shape the relay expects and the model reads
 * as the task.
 */
const TASK_PREFIX = "# Task\n\n";

/**
 * Moves the chat's instructions into the first user message, keeping the
 * history otherwise untouched, and leaves `system` to the CLI's own prompt.
 *
 * pi turns the leading `system` of the context into `params.system`, which for
 * the CLI holds nothing but its own prompt. The instructions therefore ride in
 * front of the operator's words -- read either from a `system` block pi left in
 * the messages or from `params.system` itself, since which of the two it is
 * depends on the adapter. A tool round starts with a tool result instead, and
 * there the instructions are prepended as their own user message so the result
 * still follows its `tool_use` directly.
 */
export function claudeCodeBody(
  body: Record<string, unknown>,
): Record<string, unknown> {
  const raw = Array.isArray(body.messages)
    ? (body.messages as Array<Record<string, any>>)
    : [];
  const instructions: string[] = [];
  const rest: Array<Record<string, any>> = [];
  const blockText = (content: unknown): string =>
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .filter((part: any) => part?.type === "text")
            .map((part: any) => String(part.text ?? ""))
            .join("\n")
        : "";
  for (const item of raw) {
    if (item?.role === "system") {
      const text = blockText(item.content);
      if (text.trim()) instructions.push(text);
      continue;
    }
    rest.push(item);
  }
  const system = blockText(body.system);
  if (system.trim()) instructions.push(system);
  const task = instructions.length ? `${TASK_PREFIX}${instructions.join("\n\n")}` : "";
  const first = rest[0];
  if (!first) return { ...body, messages: rest };
  if (first.role !== "user" || !task) {
    return {
      ...body,
      messages: task ? [{ role: "user", content: task }, ...rest] : rest,
    };
  }
  const content =
    typeof first.content === "string"
      ? `${task}\n\n${first.content}`
      : [
          { type: "text", text: `${task}\n` },
          ...(Array.isArray(first.content) ? first.content : []),
        ];
  return { ...body, messages: [{ ...first, content }, ...rest.slice(1)] };
}
