import { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";

/**
 * Language detection for the remote file editor.
 *
 * `LanguageDescription.matchFilename` already covers file names and extensions that
 * CodeMirror ships a mode for, but operational configuration files that are common on
 * servers (`.env`, `*.service`, dotfiles, `Dockerfile.dev`, extensionless scripts with a
 * shebang) fall through it. Those are resolved by the alias tables below so that opening
 * them highlights instead of showing plain text.
 */

export function basename(path: string): string {
  const clean = path.replace(/[\\/]+$/, "");
  const parts = clean.split(/[\\/]/);
  return parts[parts.length - 1] ?? "";
}

/** Dotfiles such as `.env` and `.bashrc` have their name as the extension. */
export function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot < 0) return "";
  return name.slice(dot + 1).toLowerCase();
}

const EXTENSION_ALIASES: Record<string, string> = {
  // ini style configuration: `.env`, `app.cfg`, systemd units, desktop entries
  env: "Properties files",
  cfg: "Properties files",
  cnf: "Properties files",
  conf: "Properties files",
  service: "Properties files",
  socket: "Properties files",
  timer: "Properties files",
  target: "Properties files",
  mount: "Properties files",
  path: "Properties files",
  desktop: "Properties files",
  // shells and dotfiles
  dash: "Shell",
  ash: "Shell",
  fish: "Shell",
  bashrc: "Shell",
  bash_profile: "Shell",
  bash_aliases: "Shell",
  bash_history: "Shell",
  profile: "Shell",
  zshrc: "Shell",
  zprofile: "Shell",
  zsh_history: "Shell",
  kshrc: "Shell",
  // nginx style virtual hosts
  vhost: "Nginx",
  // json supersets
  jsonc: "JSON",
  json5: "JSON",
  // misc aliases for extensions CodeMirror only knows by another spelling
  yml: "YAML",
  phtml: "PHP",
  kts: "Kotlin",
  htm: "HTML",
  xhtml: "HTML",
  mjs: "JavaScript",
  cjs: "JavaScript",
  mts: "TypeScript",
  cts: "TypeScript",
  md: "Markdown",
  rs: "Rust",
};

const FILENAME_ALIASES: Array<[RegExp, string]> = [
  [/^dockerfile(\..+)?$/i, "Dockerfile"],
  [/\.dockerfile$/i, "Dockerfile"],
  [/^nginx.*\.conf$/i, "Nginx"],
  [/^(\.?bashrc|\.?bash_profile|\.?bash_aliases|\.?bash_login|\.?profile|\.?zshrc|\.?zprofile|\.?zlogin|\.?kshrc|\.?shrc)$/i, "Shell"],
  [/^(\.?env(\..+)?)$/i, "Properties files"],
  [/^(\.?npmrc|\.?yarnrc|\.?editorconfig|\.?gitconfig)$/i, "Properties files"],
];

const SHEBANG_ALIASES: Record<string, string> = {
  sh: "Shell",
  bash: "Shell",
  zsh: "Shell",
  ksh: "Shell",
  dash: "Shell",
  ash: "Shell",
  fish: "Shell",
  python: "Python",
  python2: "Python",
  python3: "Python",
  node: "JavaScript",
  nodejs: "JavaScript",
  bun: "JavaScript",
  deno: "JavaScript",
  perl: "Perl",
  ruby: "Ruby",
  php: "PHP",
  lua: "Lua",
  groovy: "Groovy",
  pwsh: "PowerShell",
  powershell: "PowerShell",
};

/**
 * Interpreters named in a `#!` line, e.g. `#!/usr/bin/env python3 -u` -> "Python".
 */
export function shebangLanguage(content: string): string | null {
  const line = content.slice(0, 256).split("\n", 1)[0].trim();
  if (!line.startsWith("#!")) return null;
  const words = line.slice(2).trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return null;
  let command = basename(words[0]);
  if (command === "env") {
    // Skip flags and VAR=value assignments: `env -S deno run`, `env FOO=1 bash`
    const rest = words.slice(1).filter((w) => !w.startsWith("-") && !w.includes("="));
    command = basename(rest[0] ?? "");
  }
  return SHEBANG_ALIASES[command] ?? null;
}

/**
 * Resolve the CodeMirror language for a remote path. `content` is only used for shebang
 * sniffing, so callers may pass the first few hundred bytes.
 */
export function detectLanguage(
  path: string,
  content = "",
): LanguageDescription | null {
  const name = basename(path);
  if (!name) return null;

  const direct = LanguageDescription.matchFilename(languages, name);
  if (direct) return direct;

  const extension = extensionOf(name);
  const aliased =
    EXTENSION_ALIASES[extension] ??
    FILENAME_ALIASES.find(([pattern]) => pattern.test(name))?.[1] ??
    (content ? shebangLanguage(content) : null);
  if (!aliased) return null;

  return LanguageDescription.matchLanguageName(languages, aliased);
}

/** Human readable language name, or null when the file is shown as plain text. */
export function languageLabel(path: string, content = ""): string | null {
  return detectLanguage(path, content)?.name ?? null;
}

/** Highlighting is skipped for very large files so the editor stays responsive. */
export const MAX_HIGHLIGHT_BYTES = 400_000;
