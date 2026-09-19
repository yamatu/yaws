import type { Request, Response } from "express";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Env } from "./env.js";

/** Assets the controller knows how to hand out (see agent/Makefile). */
export const AGENT_ASSETS = ["yaws-agent-linux-amd64", "yaws-agent-linux-arm64"] as const;
export type AgentAsset = (typeof AGENT_ASSETS)[number];

export function isAgentAsset(value: string): value is AgentAsset {
  return (AGENT_ASSETS as readonly string[]).includes(value);
}

/**
 * Where an installer can get the agent from. `controller` is the panel itself,
 * which ships the binaries in `agent/bin`, so a host that can reach the panel
 * (every host that will run an agent can) installs without touching the internet.
 */
export type AgentProvider = "controller" | "gitee" | "github";

/** Domestic vs overseas preference; every channel still falls back to the rest. */
export type AgentChannel = "cn" | "global";

export const AGENT_CHANNELS: ReadonlyArray<{
  id: AgentChannel;
  label: string;
  hint: string;
}> = [
  {
    id: "cn",
    label: "国内线路",
    hint: "优先 Gitee 发行版，其次主控自带，最后 GitHub",
  },
  {
    id: "global",
    label: "国外线路",
    hint: "优先 GitHub 发行版，其次主控自带，最后 Gitee",
  },
];

export function isAgentChannel(value: unknown): value is AgentChannel {
  return value === "cn" || value === "global";
}

/**
 * Fallback order for a channel. Both orders end at the controller so a host
 * with no (or slow) international connectivity still installs.
 */
export function agentProviderOrder(channel: AgentChannel): AgentProvider[] {
  return channel === "global"
    ? ["github", "controller", "gitee"]
    : ["gitee", "controller", "github"];
}

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Repository root: this file lives in `<root>/server/src` or `<root>/server/dist`. */
export function repoRoot(): string {
  return path.resolve(HERE, "..", "..");
}

/** Directory holding the agent builds that the controller serves. */
export function agentBinaryDir(env: Env): string {
  const configured = env.AGENT_BINARY_DIR?.trim();
  return configured ? path.resolve(configured) : path.join(repoRoot(), "agent", "bin");
}

export function sha256File(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

export type BundledAgent = {
  asset: AgentAsset;
  path: string;
  bytes: number;
  sha256: string;
  /** Version the binary reports; empty when the controller cannot execute it. */
  version: string;
};

// Reading the version means running the binary once; keep the answer per build.
const versionCache = new Map<string, string>();

/** Ask a bundled agent for its version. Returns "" when it cannot run here
 *  (a Windows dev box, a truncated download) — callers must handle that. */
export function agentVersion(file: string): string {
  let key: string;
  try {
    const stat = fs.statSync(file);
    key = `${file}:${stat.size}:${stat.mtimeMs}`;
  } catch {
    return "";
  }
  const cached = versionCache.get(key);
  if (cached !== undefined) return cached;
  let version = "";
  try {
    const result = spawnSync(file, ["-version"], { timeout: 5000, encoding: "utf8" });
    const line = String(result.stdout ?? "").split("\n")[0].trim();
    if (result.status === 0 && line) version = line.slice(0, 64);
  } catch {
    version = "";
  }
  versionCache.set(key, version);
  return version;
}

export function readBundledAgent(env: Env, asset: AgentAsset): BundledAgent | null {
  const file = path.join(agentBinaryDir(env), asset);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return null;
  }
  if (!stat.isFile() || stat.size === 0) return null;
  return {
    asset,
    path: file,
    bytes: stat.size,
    sha256: sha256File(file),
    version: agentVersion(file),
  };
}

/** Version the panel ships (both architectures are built from the same tag). */
export function bundledAgentVersion(env: Env): {
  version: string;
  asset: AgentAsset | null;
  bytes: number;
} {
  for (const asset of AGENT_ASSETS) {
    const bundled = readBundledAgent(env, asset);
    if (bundled) return { version: bundled.version, asset, bytes: bundled.bytes };
  }
  return { version: "", asset: null, bytes: 0 };
}

/**
 * Public download endpoint for the bundled agent builds. The installer on a
 * target host has no credential yet, and these bytes are the same ones GitHub
 * and Gitee publish, so this stays unauthenticated; the asset name is an
 * allow-list so nothing else in the directory can be requested. Mounted by the
 * controller and by the test fixture, which is why it lives here.
 */
export function agentBinaryHandler(env: Env) {
  return (req: Request, res: Response) => {
    const requested = String(req.params.asset ?? "");
    const wantChecksum = requested.endsWith(".sha256");
    const asset = wantChecksum ? requested.slice(0, -7) : requested;
    if (!isAgentAsset(asset)) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const bundled = readBundledAgent(env, asset);
    if (!bundled) {
      res.status(503).json({ error: "agent_binary_missing" });
      return;
    }
    if (wantChecksum) {
      res.setHeader("content-type", "text/plain; charset=utf-8");
      res.end(`${bundled.sha256}  ${asset}\n`);
      return;
    }
    res.setHeader("content-type", "application/octet-stream");
    res.setHeader("x-agent-sha256", bundled.sha256);
    res.setHeader("content-disposition", `attachment; filename="${asset}"`);
    res.sendFile(bundled.path);
  };
}

/** `wss://panel.example.com/ws/agent` -> `https://panel.example.com`. */
export function httpBaseFromWs(wsUrl: string): string {
  try {
    const url = new URL(wsUrl);
    if (url.protocol === "ws:") url.protocol = "http:";
    else if (url.protocol === "wss:") url.protocol = "https:";
    else return "";
    // Keep a path prefix (`https://host/yaws/ws/agent`) but drop the agent part.
    const prefix = url.pathname.replace(/\/ws\/agent\/?$/, "").replace(/\/+$/, "");
    return `${url.protocol}//${url.host}${prefix}`;
  } catch {
    return "";
  }
}

export function trimBase(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

/** Base URL of the GitHub release, `/releases/latest/download` unless pinned. */
export function githubReleaseBase(env: Env): string {
  const override = env.AGENT_RELEASE_BASE_URL?.trim();
  if (override) return trimBase(override);
  const repo = env.AGENT_GITHUB_REPO.trim();
  const tag = env.AGENT_RELEASE_TAG?.trim();
  return tag
    ? `https://github.com/${repo}/releases/download/${tag}`
    : `https://github.com/${repo}/releases/latest/download`;
}

/**
 * Base URL of the Gitee release. Gitee has no `/releases/latest/download`
 * alias, so without a pinned tag this stays empty and the installer asks the
 * Gitee API for the newest tag instead.
 */
export function giteeReleaseBase(env: Env): string {
  const override = env.AGENT_GITEE_RELEASE_BASE_URL?.trim();
  if (override) return trimBase(override);
  const repo = env.AGENT_GITEE_REPO.trim();
  const tag = env.AGENT_RELEASE_TAG?.trim();
  return repo && tag ? `https://gitee.com/${repo}/releases/download/${tag}` : "";
}

/** Release API the installer calls when no base is pinned. */
export function releaseApi(provider: "github" | "gitee", repo: string): string {
  return provider === "github"
    ? `https://api.github.com/repos/${repo}/releases/latest`
    : `https://gitee.com/api/v5/repos/${repo}/releases/latest`;
}

/**
 * Everything the generated installer needs to know about its sources. Kept in
 * one place so the manual script and the SSH installer can never disagree.
 */
export type AgentSourcePlan = {
  order: AgentProvider[];
  channel: AgentChannel;
  githubRepo: string;
  giteeRepo: string;
  releaseTag: string;
  githubBase: string;
  giteeBase: string;
  controllerBase: string;
  /** Version the controller ships; the installer skips a download when it matches. */
  targetVersion: string;
  /** Human readable description of each candidate, for the UI and the log. */
  sources: Array<{ provider: AgentProvider; label: string; detail: string }>;
};

export function agentSourcePlan(opts: {
  env: Env;
  channel: AgentChannel;
  controllerBase: string;
  targetVersion: string;
}): AgentSourcePlan {
  const { env, channel } = opts;
  const githubBase = githubReleaseBase(env);
  const giteeBase = giteeReleaseBase(env);
  const githubRepo = env.AGENT_GITHUB_REPO.trim();
  const giteeRepo = env.AGENT_GITEE_REPO.trim();
  const plan: AgentSourcePlan = {
    order: agentProviderOrder(channel),
    channel,
    githubRepo,
    giteeRepo,
    releaseTag: env.AGENT_RELEASE_TAG?.trim() ?? "",
    githubBase,
    giteeBase,
    controllerBase: trimBase(opts.controllerBase),
    targetVersion: opts.targetVersion,
    sources: [],
  };
  for (const provider of plan.order) {
    if (provider === "controller") {
      if (!plan.controllerBase) continue;
      plan.sources.push({
        provider,
        label: "主控自带",
        detail: `${plan.controllerBase}/api/agent/binary/<架构>`,
      });
    } else if (provider === "gitee") {
      if (!giteeRepo) continue;
      plan.sources.push({
        provider,
        label: "Gitee",
        detail: giteeBase || `自动查询 ${releaseApi("gitee", giteeRepo)}`,
      });
    } else {
      if (!githubRepo) continue;
      plan.sources.push({
        provider,
        label: "GitHub",
        detail: githubBase || `自动查询 ${releaseApi("github", githubRepo)}`,
      });
    }
  }
  return plan;
}
