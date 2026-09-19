/**
 * Extension packages: pi-style bundles that add tools, skills and prompt
 * templates to the assistant.
 *
 * A package is a directory with a `package.json` whose `yaws` key lists what it
 * contributes, or with the conventional `extensions/`, `skills/` and `prompts/`
 * directories. It can be installed from a local path, from npm (`npm:pkg@1`) or
 * from git (`git:github.com/user/repo@v1`), and the admin can enable or disable
 * each package independently.
 *
 * Extensions run inside the server process with its full permissions, exactly
 * like pi extensions do, so only trusted packages belong here.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import type { Db } from "./db.js";
import { encryptText, decryptText } from "./crypto.js";
import { WorkspaceError } from "./ssh.js";

const SETTINGS_KEY = "extensions_enc";
const MAX_PACKAGES = 50;
const MAX_NOTE_LENGTH = 4000;
const MAX_TOTAL_NOTES = 12000;
const MAX_DESCRIPTION = 2000;
const MAX_SKILL_LENGTH = 60000;
const INSTALL_TIMEOUT_MS = 5 * 60_000;
const TOOL_TIMEOUT_MS = 120_000;
const TOOL_PREFIX = "ext__";

/** One installed package, as stored in the settings table. */
export const ExtensionPackageSchema = z.object({
  id: z.string().min(1).max(48),
  name: z.string().max(120).default(""),
  source: z.string().min(1).max(500),
  enabled: z.boolean().default(true),
  addedAt: z.number().default(0),
});
export type ExtensionPackage = z.infer<typeof ExtensionPackageSchema>;

const ExtensionPackagesSchema = z.array(ExtensionPackageSchema).max(MAX_PACKAGES);

/* ------------------------------------------------------------------ storage */

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

export function readExtensionPackages(db: Db, secret: string): ExtensionPackage[] {
  const stored = setting(db, SETTINGS_KEY);
  if (!stored) return [];
  try {
    return ExtensionPackagesSchema.parse(JSON.parse(decryptText(stored, secret)));
  } catch {
    // A corrupt value must not brick the assistant; the admin can reinstall.
    return [];
  }
}

export function writeExtensionPackages(
  db: Db,
  secret: string,
  packages: ExtensionPackage[],
) {
  put(db, SETTINGS_KEY, encryptText(JSON.stringify(packages), secret));
}

/* ------------------------------------------------------------------ sources */

export type ExtensionSource =
  | { kind: "npm"; spec: string; name: string }
  | { kind: "git"; url: string; ref: string }
  | { kind: "local"; dir: string };

/** npm specs are handed to `npm install`, so keep them free of shell syntax. */
const NPM_SPEC = /^(@[a-z0-9-._~]+\/)?[a-z0-9-._~]+(@[a-zA-Z0-9-._~^<>=*+]+)?$/;
const GIT_URL = /^[A-Za-z0-9@:/._~+-]+$/;

function splitVersion(spec: string): { name: string; version: string } {
  const at = spec.lastIndexOf("@");
  if (at <= 0) return { name: spec, version: "" };
  return { name: spec.slice(0, at), version: spec.slice(at + 1) };
}

/**
 * Reads a source string the way pi does: `npm:` specs, `git:` or protocol URLs,
 * and anything else as a local path. Throws `extension_source_invalid`.
 */
export function parseExtensionSource(raw: string): ExtensionSource {
  const source = raw.trim();
  if (!source) throw new WorkspaceError(400, "extension_source_invalid");
  if (source.startsWith("npm:")) {
    const spec = source.slice(4).trim();
    if (!NPM_SPEC.test(spec) || spec.startsWith("-"))
      throw new WorkspaceError(400, "extension_source_invalid");
    const { name } = splitVersion(spec);
    return { kind: "npm", spec, name };
  }
  if (source.startsWith("git:")) {
    const rest = source.slice(4).trim();
    const { name: url, version: ref } = splitVersion(rest);
    if (!GIT_URL.test(url) || !url.includes("/"))
      throw new WorkspaceError(400, "extension_source_invalid");
    if (ref && !/^[A-Za-z0-9._/-]+$/.test(ref))
      throw new WorkspaceError(400, "extension_source_invalid");
    return { kind: "git", url, ref };
  }
  if (/^(https?|ssh|git):\/\//.test(source)) {
    const { name: url, version: ref } = splitVersion(source);
    if (!GIT_URL.test(url)) throw new WorkspaceError(400, "extension_source_invalid");
    return { kind: "git", url, ref };
  }
  if (source.length > 400 || /[\0\r\n]/.test(source))
    throw new WorkspaceError(400, "extension_source_invalid");
  return { kind: "local", dir: source };
}

/** Stable id derived from the source, so reinstalling keeps the same tools. */
export function extensionId(source: string): string {
  const digest = createHash("sha1").update(source).digest("hex").slice(0, 10);
  return `ext_${digest}`;
}

function slug(text: string, fallback = "package"): string {
  const cleaned = text.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned || fallback;
}

/* -------------------------------------------------------------- package disk */

type Manifest = {
  extensions?: string[];
  skills?: string[];
  prompts?: string[];
  name?: string;
};

type ResolvedPackage = {
  /** Directory the resources are read from. */
  dir: string;
  name: string;
  manifest: Manifest;
};

const CONVENTION = {
  extensions: ["extensions"],
  skills: ["skills"],
  prompts: ["prompts"],
};

function readJson(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** `yaws` manifest key; convention directories are handled by the caller. */
function readManifest(pkg: Record<string, unknown>): Manifest {
  const raw =
    pkg.yaws && typeof pkg.yaws === "object"
      ? (pkg.yaws as Record<string, unknown>)
      : {};
  const manifest: Manifest = {};
  if (typeof pkg.name === "string") manifest.name = pkg.name;
  for (const key of ["extensions", "skills", "prompts"] as const) {
    const value = raw[key];
    if (Array.isArray(value))
      manifest[key] = value.filter((item): item is string => typeof item === "string");
  }
  return manifest;
}

function conventionPaths(dir: string) {
  const manifest: Manifest = {};
  for (const key of ["extensions", "skills", "prompts"] as const) {
    const candidate = path.join(dir, key);
    if (fs.existsSync(candidate)) manifest[key] = CONVENTION[key];
  }
  return manifest;
}

/* ---------------------------------------------------------------- loading */

export type ExtensionToolResult =
  | string
  | { text?: string; output?: string; isError?: boolean };

export type ExtensionToolContext = {
  packageId: string;
  packageName: string;
  log: (...parts: unknown[]) => void;
};

export type ExtensionToolDefinition = {
  name: string;
  title?: string;
  description: string;
  parameters?: Record<string, unknown>;
  /** Labels the tool as read-only in the transcript; it still auto-runs. */
  readOnly?: boolean;
  run: (
    args: Record<string, unknown>,
    ctx: ExtensionToolContext,
  ) => Promise<ExtensionToolResult> | ExtensionToolResult;
};

export type ExtensionSkill = {
  name: string;
  description: string;
  content: string;
};

export type ExtensionPrompt = {
  name: string;
  description: string;
  content: string;
};

export type ExtensionToolCallEvent = {
  name: string;
  args: Record<string, unknown>;
};

export type ExtensionGuardResult = void | { block?: boolean; reason?: string };

export type ExtensionApi = {
  id: string;
  name: string;
  registerTool: (definition: ExtensionToolDefinition) => void;
  registerSkill: (skill: ExtensionSkill) => void;
  registerPrompt: (prompt: ExtensionPrompt) => void;
  /** Extra instructions appended to the assistant's system prompt. */
  registerPromptNote: (note: string) => void;
  /** `tool_call` handlers may block a tool before it runs. */
  on: (
    event: "tool_call",
    handler: (event: ExtensionToolCallEvent) => ExtensionGuardResult | Promise<ExtensionGuardResult>,
  ) => void;
  log: (...parts: unknown[]) => void;
};

export type LoadedExtensionTool = {
  packageId: string;
  packageName: string;
  toolName: string;
  /** Namespaced name the model sees. */
  name: string;
  title: string;
  description: string;
  parameters: Record<string, unknown>;
  readOnly: boolean;
  run: ExtensionToolDefinition["run"];
};

export type LoadedExtensionSkill = ExtensionSkill & {
  packageId: string;
  packageName: string;
};

export type LoadedExtensionPrompt = ExtensionPrompt & {
  packageId: string;
  packageName: string;
};

export type ExtensionGuard = (
  event: ExtensionToolCallEvent,
) => ExtensionGuardResult | Promise<ExtensionGuardResult>;

export type LoadedExtensions = {
  tools: LoadedExtensionTool[];
  skills: LoadedExtensionSkill[];
  prompts: LoadedExtensionPrompt[];
  notes: string[];
  guards: ExtensionGuard[];
  errors: string[];
};

const EMPTY = (): LoadedExtensions => ({
  tools: [],
  skills: [],
  prompts: [],
  notes: [],
  guards: [],
  errors: [],
});

const TOOL_NAME = /^[A-Za-z0-9_-]{1,48}$/;
const EMPTY_PARAMETERS = {
  type: "object",
  properties: {},
  additionalProperties: false,
};

/** `ext__<package>__<tool>`, trimmed so the whole name fits the model limit. */
export function extensionToolName(packageId: string, toolName: string): string {
  const full = `${TOOL_PREFIX}${packageId}__${toolName}`;
  return full.length <= 64 ? full : full.slice(0, 64);
}

function javaScriptFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isFile() && /\.(mjs|cjs|js)$/.test(entry.name)) files.push(full);
    else if (entry.isDirectory()) {
      for (const candidate of ["index.mjs", "index.js", "index.cjs"]) {
        const index = path.join(full, candidate);
        if (fs.existsSync(index)) {
          files.push(index);
          break;
        }
      }
    }
  }
  return files.sort();
}

function manifestFiles(dir: string, patterns: string[] | undefined): string[] {
  if (!patterns || !patterns.length) return javaScriptFiles(dir);
  const include: string[] = [];
  const exclude = new Set<string>();
  for (const pattern of patterns) {
    if (typeof pattern !== "string") continue;
    if (pattern.startsWith("!")) {
      exclude.add(path.resolve(dir, pattern.slice(1)));
      continue;
    }
    // A trailing /* (or a directory) means "every module in there".
    const bare = pattern.replace(/\/\*+$/, "");
    const target = path.resolve(dir, bare);
    if (!fs.existsSync(target)) continue;
    if (fs.statSync(target).isDirectory()) include.push(...javaScriptFiles(target));
    else include.push(target);
  }
  return include.filter((file) => !exclude.has(path.resolve(file))).sort();
}

/** Minimal front matter reader: `---\nname: x\ndescription: y\n---`. */
function frontMatter(text: string): { meta: Record<string, string>; body: string } {
  if (!text.startsWith("---")) return { meta: {}, body: text };
  const end = text.indexOf("\n---", 3);
  if (end < 0) return { meta: {}, body: text };
  const meta: Record<string, string> = {};
  for (const line of text.slice(3, end).split("\n")) {
    const at = line.indexOf(":");
    if (at <= 0) continue;
    const key = line.slice(0, at).trim().toLowerCase();
    const value = line.slice(at + 1).trim().replace(/^["']|["']$/g, "");
    if (key && value) meta[key] = value;
  }
  return { meta, body: text.slice(end + 4).replace(/^\n+/, "") };
}

function firstLine(text: string): string {
  for (const line of text.split("\n")) {
    const trimmed = line.trim().replace(/^#+\s*/, "");
    if (trimmed && !trimmed.startsWith("---")) return trimmed.slice(0, 200);
  }
  return "";
}

function markdownFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) files.push(full);
  }
  return files.sort();
}

function readSkills(dir: string, patterns: string[] | undefined): ExtensionSkill[] {
  const skills: ExtensionSkill[] = [];
  const targets = patterns?.length ? patterns : fs.existsSync(dir) ? ["."] : [];
  for (const pattern of targets) {
    if (typeof pattern !== "string" || pattern.startsWith("!")) continue;
    const target = path.resolve(dir, pattern.replace(/\/\*+$/, ""));
    if (!fs.existsSync(target)) continue;
    const stat = fs.statSync(target);
    const files: Array<{ file: string; fallback: string }> = [];
    if (stat.isFile()) files.push({ file: target, fallback: path.basename(target, ".md") });
    else {
      // `skills/name/SKILL.md` (pi layout) and flat `skills/name.md` both work.
      for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          const skill = path.join(target, entry.name, "SKILL.md");
          if (fs.existsSync(skill)) files.push({ file: skill, fallback: entry.name });
        } else if (entry.name.toLowerCase().endsWith(".md")) {
          files.push({ file: path.join(target, entry.name), fallback: path.basename(entry.name, ".md") });
        }
      }
    }
    for (const { file, fallback } of files) {
      let text = "";
      try {
        text = fs.readFileSync(file, "utf8");
      } catch {
        continue;
      }
      const { meta, body } = frontMatter(text);
      const name = (meta.name || fallback).trim();
      if (!name) continue;
      skills.push({
        name,
        description: (meta.description || firstLine(body)).slice(0, MAX_DESCRIPTION),
        content: body.slice(0, MAX_SKILL_LENGTH),
      });
    }
  }
  return skills;
}

function readPrompts(dir: string, patterns: string[] | undefined): ExtensionPrompt[] {
  const prompts: ExtensionPrompt[] = [];
  const targets = patterns?.length ? patterns : fs.existsSync(dir) ? ["."] : [];
  for (const pattern of targets) {
    if (typeof pattern !== "string" || pattern.startsWith("!")) continue;
    const target = path.resolve(dir, pattern.replace(/\/\*+$/, ""));
    if (!fs.existsSync(target)) continue;
    const stat = fs.statSync(target);
    const files = stat.isFile()
      ? [target]
      : markdownFiles(target);
    for (const file of files) {
      if (!file.toLowerCase().endsWith(".md")) continue;
      let text = "";
      try {
        text = fs.readFileSync(file, "utf8");
      } catch {
        continue;
      }
      const { meta, body } = frontMatter(text);
      prompts.push({
        name: (meta.name || path.basename(file, ".md")).trim(),
        description: (meta.description || firstLine(body)).slice(0, MAX_DESCRIPTION),
        content: body,
      });
    }
  }
  return prompts;
}

/** Normalizes whatever `run` returned into text plus a failure flag. */
export function renderExtensionResult(result: ExtensionToolResult): {
  text: string;
  isError: boolean;
} {
  if (typeof result === "string") return { text: result, isError: false };
  if (!result || typeof result !== "object") return { text: "", isError: false };
  const text = result.text ?? result.output ?? "";
  return { text: String(text), isError: !!result.isError };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function importModule(file: string) {
  const stamp = Math.floor(fs.statSync(file).mtimeMs);
  const url = `${pathToFileURL(file).href}?v=${stamp}`;
  return (await import(url)) as Record<string, unknown>;
}

/**
 * Runs one extension file: either `export default function (api) {...}`,
 * `export function activate(api) {...}`, an object with `activate`, or a plain
 * object listing `tools`, `skills`, `prompts` and `notes`.
 */
async function activateModule(file: string, api: ExtensionApi, baseDir: string) {
  let module: Record<string, unknown>;
  try {
    module = await importModule(file);
  } catch (error) {
    const text = message(error);
    throw new Error(
      /Unknown file extension|Cannot find module/.test(text)
        ? `extension_unloadable: ${path.basename(file)} (${text.split("\n")[0]})`
        : text,
    );
  }
  const exported = module.default ?? module.activate;
  const activate =
    typeof exported === "function"
      ? exported
      : exported &&
          typeof exported === "object" &&
          typeof (exported as { activate?: unknown }).activate === "function"
        ? (exported as { activate: (api: ExtensionApi) => unknown }).activate
        : null;
  if (activate) {
    await activate(api);
    return;
  }
  const declared = (
    exported && typeof exported === "object" ? exported : module
  ) as Record<string, unknown>;
  const list = (key: string) => (Array.isArray(declared[key]) ? (declared[key] as unknown[]) : []);
  for (const note of list("notes")) api.registerPromptNote(String(note));
  for (const tool of list("tools"))
    api.registerTool(tool as ExtensionToolDefinition);
  const addFiles = (key: "skills" | "prompts") => {
    for (const entry of list(key)) {
      if (!entry || typeof entry !== "object") continue;
      const file = path.resolve(baseDir, String((entry as { file?: string }).file ?? ""));
      if (!fs.existsSync(file)) continue;
      const { meta, body } = frontMatter(fs.readFileSync(file, "utf8"));
      if (key === "skills")
        api.registerSkill({
          name: String((entry as { name?: string }).name ?? meta.name ?? path.basename(file, ".md")),
          description: String(
            (entry as { description?: string }).description ?? meta.description ?? firstLine(body),
          ),
          content: body,
        });
      else
        api.registerPrompt({
          name: String((entry as { name?: string }).name ?? meta.name ?? path.basename(file, ".md")),
          description: String(
            (entry as { description?: string }).description ?? meta.description ?? firstLine(body),
          ),
          content: body,
        });
    }
  };
  addFiles("skills");
  addFiles("prompts");
  if (!activate && !list("tools").length && !list("skills").length && !list("prompts").length && !list("notes").length)
    throw new Error("extension_no_activate");
}

/* -------------------------------------------------------------- installing */

function runCommand(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  shell = false,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      shell,
      env: { ...process.env, npm_config_yes: "true" },
      windowsHide: true,
    });
    let out = "";
    let settled = false;
    const finish = (error: Error | null, text = "") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      error ? reject(error) : resolve(text);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error("extension_install_timeout"));
    }, timeoutMs);
    timer.unref?.();
    child.stdout?.on("data", (chunk: Buffer) => {
      out = (out + chunk.toString()).slice(-4000);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      out = (out + chunk.toString()).slice(-4000);
    });
    child.on("error", (error) => finish(error));
    child.on("close", (code) =>
      finish(
        code === 0 ? null : new Error(`extension_install_failed: ${out.trim().split("\n").slice(-3).join(" ")}`),
      ),
    );
  });
}

/** Resolves the source to the on-disk package, installing it when needed. */
async function materialize(
  root: string,
  source: ExtensionSource,
): Promise<ResolvedPackage> {
  if (source.kind === "local") {
    const dir = path.resolve(root, source.dir);
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory())
      throw new WorkspaceError(400, "extension_package_missing");
    const pkg = readJson(path.join(dir, "package.json")) ?? {};
    const manifest = Object.keys(pkg).length ? readManifest(pkg) : {};
    return {
      dir,
      name: manifest.name || path.basename(dir),
      manifest: { ...conventionPaths(dir), ...manifest },
    };
  }
  if (source.kind === "npm") {
    const home = npmHome(root, source.spec);
    const dir = path.join(home, "node_modules", ...source.name.split("/"));
    // Installing is only done once; later loads reuse the checkout.
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(home, { recursive: true });
      await runCommand(
        npmCommand(),
        ["install", "--no-audit", "--no-fund", "--loglevel=error", source.spec],
        home,
        INSTALL_TIMEOUT_MS,
        // npm is a .cmd shim on Windows, which needs a shell; the spec was
        // validated to contain no shell syntax.
        process.platform === "win32",
      );
    }
    if (!fs.existsSync(dir))
      throw new WorkspaceError(400, "extension_package_missing");
    const pkg = readJson(path.join(dir, "package.json")) ?? {};
    const manifest = readManifest(pkg);
    return {
      dir,
      name: manifest.name || source.name,
      manifest: { ...conventionPaths(dir), ...manifest },
    };
  }
  const home = gitHome(root, source.url);
  fs.mkdirSync(path.dirname(home), { recursive: true });
  if (!fs.existsSync(path.join(home, ".git"))) {
    fs.rmSync(home, { recursive: true, force: true });
    const args = ["clone", "--depth", "1"];
    if (source.ref) args.push("--branch", source.ref);
    args.push(source.url, home);
    await runCommand("git", args, root, INSTALL_TIMEOUT_MS);
  }
  const pkg = readJson(path.join(home, "package.json"));
  // Dependencies are installed once, on the first load after the clone.
  if (pkg && !fs.existsSync(path.join(home, "node_modules")))
    await runCommand(npmCommand(), ["install", "--no-audit", "--no-fund", "--loglevel=error"], home, INSTALL_TIMEOUT_MS, process.platform === "win32");
  const manifest = pkg ? readManifest(pkg) : {};
  return {
    dir: home,
    name: manifest.name || path.basename(home),
    manifest: { ...conventionPaths(home), ...manifest },
  };
}

/** Checkout directories for managed sources, shared by install and remove. */
function npmHome(root: string, spec: string): string {
  return path.join(root, "npm", slug(spec));
}

function gitHome(root: string, url: string): string {
  return path.join(
    root,
    "git",
    ...url.replace(/^[a-z]+:\/\//i, "").split("/").filter(Boolean),
  );
}

function npmCommand(): string {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

/* ------------------------------------------------------------------ manager */

export type ExtensionInstallResult = {
  package: ExtensionPackage;
  loaded: LoadedExtensions;
};

/**
 * Loads every enabled package once and caches the result. A package that fails
 * to load is reported in `errors` and skipped; the other packages and the rest
 * of the assistant keep working.
 */
export class ExtensionManager {
  private cache: Promise<LoadedExtensions> | null = null;

  constructor(
    private readonly db: Db,
    private readonly secret: string,
    private readonly root: string,
  ) {}

  get directory(): string {
    return this.root;
  }

  packages(onlyEnabled = true): ExtensionPackage[] {
    const list = readExtensionPackages(this.db, this.secret);
    return onlyEnabled ? list.filter((item) => item.enabled) : list;
  }

  invalidate() {
    this.cache = null;
  }

  load(): Promise<LoadedExtensions> {
    if (!this.cache) {
      this.cache = this.read().catch((error) => {
        this.cache = null;
        throw error;
      });
    }
    return this.cache;
  }

  private async read(): Promise<LoadedExtensions> {
    const packages = this.packages();
    if (!packages.length) return EMPTY();
    const loaded: LoadedExtensions = {
      tools: [],
      skills: [],
      prompts: [],
      notes: [],
      guards: [],
      errors: [],
    };
    await Promise.all(
      packages.map(async (entry) => {
        const api = this.api(entry, loaded);
        let resolved: ResolvedPackage;
        try {
          resolved = await materialize(this.root, parseExtensionSource(entry.source));
        } catch (error) {
          loaded.errors.push(`${entry.source}: ${message(error)}`);
          return;
        }
        const { dir, manifest } = resolved;
        try {
          for (const skill of readSkills(dir, manifest.skills))
            api.registerSkill(skill);
          for (const prompt of readPrompts(dir, manifest.prompts))
            api.registerPrompt(prompt);
          const files = manifestFiles(dir, manifest.extensions);
          if (!files.length && !manifest.skills && !manifest.prompts)
            throw new Error("extension_no_activate");
          for (const file of files) await activateModule(file, api, dir);
        } catch (error) {
          loaded.errors.push(`${entry.name || entry.source}: ${message(error)}`);
        }
      }),
    );
    const notes: string[] = [];
    let noteBytes = 0;
    for (const note of loaded.notes) {
      const clipped = note.slice(0, MAX_NOTE_LENGTH);
      if (noteBytes + clipped.length > MAX_TOTAL_NOTES) break;
      noteBytes += clipped.length;
      notes.push(clipped);
    }
    loaded.notes = notes;
    return loaded;
  }

  private api(entry: ExtensionPackage, loaded: LoadedExtensions): ExtensionApi {
    const id = entry.id;
    const name = entry.name || entry.source;
    const label = `${name}(${id})`;
    const log = (...parts: unknown[]) => {
      console.log(`[extension:${id}]`, ...parts);
    };
    const tool = (definition: ExtensionToolDefinition) => {
      try {
        if (!definition || typeof definition !== "object")
          throw new Error("extension_tool_invalid");
        const toolName = String(definition.name ?? "").trim();
        if (!TOOL_NAME.test(toolName)) throw new Error(`extension_tool_invalid: ${toolName || "(empty)"}`);
        if (typeof definition.run !== "function")
          throw new Error(`extension_tool_invalid: ${toolName} has no run()`);
        loaded.tools.push({
          packageId: id,
          packageName: name,
          toolName,
          name: extensionToolName(id, toolName),
          title: String(definition.title ?? toolName),
          description: String(definition.description ?? "").slice(0, MAX_DESCRIPTION) || `${label} · ${toolName}`,
          parameters:
            definition.parameters && typeof definition.parameters === "object"
              ? definition.parameters
              : EMPTY_PARAMETERS,
          readOnly: !!definition.readOnly,
          run: definition.run,
        });
      } catch (error) {
        loaded.errors.push(`${label}: ${message(error)}`);
      }
    };
    const skill = (value: ExtensionSkill) => {
      const skillName = String(value?.name ?? "").trim();
      if (!skillName) return;
      loaded.skills.push({
        packageId: id,
        packageName: name,
        name: skillName,
        description: String(value.description ?? "").slice(0, MAX_DESCRIPTION) || firstLine(String(value.content ?? "")),
        content: String(value.content ?? "").slice(0, MAX_SKILL_LENGTH),
      });
    };
    const prompt = (value: ExtensionPrompt) => {
      const promptName = String(value?.name ?? "").trim();
      if (!promptName) return;
      loaded.prompts.push({
        packageId: id,
        packageName: name,
        name: promptName,
        description: String(value.description ?? "").slice(0, MAX_DESCRIPTION),
        content: String(value.content ?? ""),
      });
    };
    return {
      id,
      name,
      log,
      registerTool: tool,
      registerSkill: skill,
      registerPrompt: prompt,
      registerPromptNote: (note) => {
        const text = String(note ?? "").trim();
        if (text) loaded.notes.push(text);
      },
      on: (event, handler) => {
        if (event !== "tool_call" || typeof handler !== "function") return;
        loaded.guards.push(handler);
      },
    };
  }

  /** Runs a namespaced tool. Guarding happens in the chat turn, which is the
   * only caller and knows the real tool name for every tool kind. */
  async call(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ text: string; isError: boolean; title: string; packageName: string }> {
    const loaded = await this.load();
    const tool = loaded.tools.find((item) => item.name === name);
    if (!tool) throw new WorkspaceError(404, "extension_tool_not_found");
    const log = (...parts: unknown[]) =>
      console.log(`[extension:${tool.packageId}]`, ...parts);
    let timer: NodeJS.Timeout | undefined;
    try {
      const result = await Promise.race([
        Promise.resolve(
          tool.run(args, {
            packageId: tool.packageId,
            packageName: tool.packageName,
            log,
          }),
        ),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error("extension_timeout")),
            TOOL_TIMEOUT_MS,
          );
          timer.unref?.();
        }),
      ]);
      const rendered = renderExtensionResult(result);
      return { ...rendered, title: tool.title, packageName: tool.packageName };
    } catch (error) {
      return {
        text: message(error),
        isError: true,
        title: tool.title,
        packageName: tool.packageName,
      };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Installs a source, records it and reloads. */
  async install(raw: string): Promise<ExtensionInstallResult> {
    const source = raw.trim();
    const parsed = parseExtensionSource(source);
    const id = extensionId(source);
    const list = readExtensionPackages(this.db, this.secret);
    if (list.some((item) => item.id === id))
      throw new WorkspaceError(409, "duplicate_extension");
    if (list.length >= MAX_PACKAGES)
      throw new WorkspaceError(400, "extension_limit");
    const resolved = await materialize(this.root, parsed);
    const entry: ExtensionPackage = {
      id,
      name: resolved.name,
      source,
      enabled: true,
      addedAt: Date.now(),
    };
    writeExtensionPackages(this.db, this.secret, [...list, entry]);
    this.invalidate();
    const loaded = await this.load();
    // A package that contributes nothing is a typo, not a package: roll the
    // record back and tell the operator which file failed.
    const count = (items: Array<{ packageId: string }>) =>
      items.filter((item) => item.packageId === id).length;
    if (!count(loaded.tools) && !count(loaded.skills) && !count(loaded.prompts)) {
      writeExtensionPackages(this.db, this.secret, list);
      this.invalidate();
      const why = loaded.errors.find((text) => text.startsWith(`${entry.name}:`));
      throw new WorkspaceError(
        400,
        why
          ? `extension_no_activate: ${why.slice(entry.name.length + 2)}`
          : "extension_no_activate",
      );
    }
    return { package: entry, loaded };
  }

  /** Forgets a package; managed checkouts are deleted from disk. */
  remove(id: string): ExtensionPackage[] {
    const list = readExtensionPackages(this.db, this.secret);
    const entry = list.find((item) => item.id === id);
    if (!entry) throw new WorkspaceError(404, "extension_not_found");
    const next = list.filter((item) => item.id !== id);
    writeExtensionPackages(this.db, this.secret, next);
    this.invalidate();
    try {
      const parsed = parseExtensionSource(entry.source);
      if (parsed.kind === "npm")
        fs.rmSync(npmHome(this.root, parsed.spec), { recursive: true, force: true });
      else if (parsed.kind === "git")
        fs.rmSync(gitHome(this.root, parsed.url), { recursive: true, force: true });
    } catch {
      // The record is gone either way; a leftover checkout is harmless.
    }
    return next;
  }

  setEnabled(enabled: Map<string, boolean>): ExtensionPackage[] {
    const list = readExtensionPackages(this.db, this.secret);
    for (const entry of list) {
      const value = enabled.get(entry.id);
      if (value !== undefined) entry.enabled = value;
    }
    writeExtensionPackages(this.db, this.secret, list);
    this.invalidate();
    return list;
  }
}

/** Expands `/name rest` with an extension prompt template. */
export function expandExtensionPrompt(
  prompts: Array<{ name: string; content: string }>,
  text: string,
): string {
  const match = /^\/([A-Za-z0-9_-]{1,48})(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!match) return text;
  const prompt = prompts.find((item) => item.name === match[1]);
  if (!prompt) return text;
  const args = (match[2] ?? "").trim();
  return prompt.content
    .replace(/\$ARGUMENTS/g, args)
    .replace(/\{\{\s*args\s*\}\}/g, args)
    .trim();
}
