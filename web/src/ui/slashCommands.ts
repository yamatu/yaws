export type SlashCommand = {
  name: string;
  description: string;
  source: "builtin" | "extension";
  packageName?: string;
};

export type BuiltinCommand = "new" | "settings" | "stop";

/** Handled in the browser; never sent to the model. */
export const BUILTIN_COMMANDS: Array<SlashCommand & { name: BuiltinCommand }> = [
  { name: "new", description: "开始新对话", source: "builtin" },
  { name: "stop", description: "停止正在运行的这一轮", source: "builtin" },
  { name: "settings", description: "打开 AI 设置", source: "builtin" },
];

/** Same shape the server accepts for prompt templates. */
const NAME = /^[A-Za-z0-9_-]{0,48}$/;

/**
 * The command name being typed, or `null` when the box is not a command:
 * the input must start with `/` and the caret must still be inside the name.
 */
export function slashQuery(input: string, caret: number): string | null {
  if (!input.startsWith("/")) return null;
  const end = input.search(/\s/);
  const nameEnd = end < 0 ? input.length : end;
  if (caret < 1 || caret > nameEnd) return null;
  const name = input.slice(1, nameEnd);
  return NAME.test(name) ? name : null;
}

/** Prefix matches first, then substring matches; case-insensitive. */
export function matchCommands(
  commands: SlashCommand[],
  query: string,
  limit = 8,
): SlashCommand[] {
  const q = query.toLowerCase();
  const seen = new Set<string>();
  const prefix: SlashCommand[] = [];
  const inner: SlashCommand[] = [];
  for (const command of commands) {
    const name = command.name.toLowerCase();
    if (seen.has(name)) continue;
    if (name.startsWith(q)) prefix.push(command);
    else if (q && (name.includes(q) || command.description.toLowerCase().includes(q)))
      inner.push(command);
    else continue;
    seen.add(name);
  }
  return [...prefix, ...inner].slice(0, limit);
}

/** Replaces the typed name with the chosen one and keeps any arguments. */
export function applyCommand(input: string, name: string): string {
  const end = input.search(/\s/);
  const rest = end < 0 ? "" : input.slice(end).replace(/^\s+/, "");
  return `/${name} ${rest}`;
}

/** A whole message that is exactly one of the built-in commands. */
export function builtinCommand(message: string): BuiltinCommand | null {
  const match = /^\/([a-z]+)$/.exec(message.trim());
  const found = BUILTIN_COMMANDS.find((command) => command.name === match?.[1]);
  return found ? found.name : null;
}
