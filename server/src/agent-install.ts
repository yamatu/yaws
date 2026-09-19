import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { Client } from "ssh2";
import type { Db } from "./db.js";
import type { Env } from "./env.js";
import {
  WorkspaceError,
  connectMachine,
  credentialState,
  hostTrusted,
  shellQuote,
  sshMachine,
} from "./ssh.js";
import { decryptText } from "./crypto.js";
import {
  AGENT_CHANNELS,
  agentSourcePlan,
  bundledAgentVersion,
  httpBaseFromWs,
  isAgentChannel,
  type AgentChannel,
} from "./agent-release.js";
import { renderInstallScript } from "./install-script.js";
import { requestSignal } from "./workspace.js";

const INSTALL_TIMEOUT_MS = 10 * 60_000;
const MAX_LOG_LINES = 400;
const MAX_LINE_LENGTH = 500;

export type AgentInstallEvent =
  | { type: "start"; machineId: number; channel: AgentChannel; plan: unknown }
  | { type: "log"; stream: "out" | "err"; text: string }
  | { type: "done"; code: number; provider: string; version: string }
  | { type: "error"; error: string };

/** Machine ids with an install in flight: two installers would fight over
 *  /usr/local/bin and restart the agent twice. */
const running = new Set<number>();

type MachineRow = {
  id: number;
  interval_sec: number;
  agent_ws_url: string;
  agent_key_enc: string;
  ssh_host: string;
};

function machineForInstall(db: Db, id: number): MachineRow {
  const row = db
    .prepare(
      `SELECT id, interval_sec, agent_ws_url, agent_key_enc, ssh_host
         FROM machines WHERE id = ? AND deleted_at IS NULL`,
    )
    .get(id) as MachineRow | undefined;
  if (!row) throw new WorkspaceError(404, "not_found");
  if (!row.agent_key_enc) throw new WorkspaceError(409, "no_key");
  return row;
}

/**
 * The address the target itself uses to reach the panel (`agent_ws_url`), not
 * the address the operator's browser used: the machine was configured with the
 * one that works from its own network.
 */
export function controllerBaseFor(req: Request, machine: MachineRow): string {
  const configured = httpBaseFromWs(machine.agent_ws_url ?? "");
  if (configured) return configured;
  const proto = req.get("x-forwarded-proto")?.split(",")[0]?.trim() || req.protocol || "http";
  const host = req.get("x-forwarded-host")?.split(",")[0]?.trim() || req.get("host") || "";
  return host ? `${proto}://${host}` : "";
}

/** Last resort agent address when the machine row has none yet. */
function agentWsUrlFor(req: Request): string {
  const proto =
    req.get("x-forwarded-proto")?.split(",")[0]?.trim() || req.protocol || "http";
  const host =
    req.get("x-forwarded-host")?.split(",")[0]?.trim() || req.get("host") || "localhost:3001";
  return `${proto.toLowerCase() === "https" ? "wss" : "ws"}://${host}/ws/agent`;
}

export function renderMachineInstallScript(opts: {
  db: Db;
  secret: string;
  env: Env;
  req: Request;
  machineId: number;
  channel: AgentChannel;
}): { script: string; plan: ReturnType<typeof agentSourcePlan> } {
  const machine = machineForInstall(opts.db, opts.machineId);
  const bundled = bundledAgentVersion(opts.env);
  const plan = agentSourcePlan({
    env: opts.env,
    channel: opts.channel,
    controllerBase: controllerBaseFor(opts.req, machine),
    targetVersion: bundled.version,
  });
  const script = renderInstallScript({
    machineId: machine.id,
    wsUrl: machine.agent_ws_url || agentWsUrlFor(opts.req),
    key: decryptText(machine.agent_key_enc, opts.secret),
    intervalSec: machine.interval_sec,
    order: plan.order,
    githubRepo: plan.githubRepo,
    giteeRepo: plan.giteeRepo,
    releaseTag: plan.releaseTag,
    githubBase: plan.githubBase,
    giteeBase: plan.giteeBase,
    controllerBase: plan.controllerBase,
    targetVersion: plan.targetVersion,
  });
  return { script, plan };
}

/**
 * Writes the installer to a temp file on the target and runs it as root.
 * Passing the script through a file (instead of `bash -s`) keeps `$0` valid, so
 * the installer can re-exec itself through sudo when the SSH user is not root.
 */
export function installCommand(args: string[]): string {
  const quoted = args.map(shellQuote).join(" ");
  return (
    `sh -c 'd="$(mktemp -d)" || exit 1; cat > "$d/install.sh" || exit 1; ` +
    `bash "$d/install.sh" ${quoted}; rc=$?; rm -rf "$d"; exit $rc'`
  );
}

function send(res: Response, event: AgentInstallEvent) {
  if (res.writableEnded || res.destroyed) return;
  try {
    res.write(`${JSON.stringify(event)}\n`);
  } catch {
    // The browser went away mid-install; the abort path is already running.
  }
}

/** Splits raw SSH output into complete lines so the browser can render a log. */
function lineWriter(onLine: (line: string) => void) {
  let buffer = "";
  let lines = 0;
  return {
    push(chunk: Buffer) {
      buffer += chunk.toString("utf8");
      let index = buffer.indexOf("\n");
      while (index >= 0 && lines < MAX_LOG_LINES) {
        const line = buffer.slice(0, index).replace(/\r$/, "");
        buffer = buffer.slice(index + 1);
        lines += 1;
        onLine(line.slice(0, MAX_LINE_LENGTH));
        index = buffer.indexOf("\n");
      }
      // Keep the tail of a very long final line from filling memory.
      if (buffer.length > MAX_LINE_LENGTH * 4) buffer = buffer.slice(-MAX_LINE_LENGTH);
    },
    flush() {
      const line = buffer.replace(/\r$/, "");
      buffer = "";
      if (line.trim()) onLine(line.slice(0, MAX_LINE_LENGTH));
    },
  };
}

function openExec(client: Client, command: string): Promise<any> {
  return new Promise((resolve, reject) => {
    try {
      client.exec(command, (error: Error | undefined, stream: any) => {
        if (error) {
          const detail = String(error.message || "exec rejected").slice(-200);
          reject(new WorkspaceError(502, `ssh_exec_failed:${detail}`));
        } else {
          resolve(stream);
        }
      });
    } catch (e) {
      const detail = String((e as Error)?.message ?? e).slice(-200);
      reject(new WorkspaceError(502, `ssh_exec_failed:${detail}`));
    }
  });
}

/**
 * GET  /machines/:id/agent/install   -> what the two buttons would do
 * GET  /machines/:id/install-script  -> the same installer as a text file
 * POST /machines/:id/agent/install   -> install over SSH, streaming the log
 *
 * The script embeds the machine's agent key, so both routes are admin only.
 */
export function agentInstallRouter(db: Db, secret: string, env: Env) {
  const router = Router({ mergeParams: true });

  router.get("/:id/install-script", (req: Request, res: Response) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "bad_id" });
      return;
    }
    const channel: AgentChannel = isAgentChannel(req.query.channel) ? req.query.channel : "cn";
    try {
      const { script } = renderMachineInstallScript({
        db,
        secret,
        env,
        req,
        machineId: id,
        channel,
      });
      res.setHeader("content-type", "text/plain; charset=utf-8");
      res.end(script);
    } catch (e) {
      const error = e instanceof WorkspaceError ? e : new WorkspaceError(500, "internal_error");
      res.status(error.status).json({ error: error.message });
    }
  });

  const info = (req: Request, channel: AgentChannel) => {
    const id = Number(req.params.id);
    const machine = machineForInstall(db, id);
    const bundled = bundledAgentVersion(env);
    const plan = agentSourcePlan({
      env,
      channel,
      controllerBase: controllerBaseFor(req, machine),
      targetVersion: bundled.version,
    });
    const ssh = sshMachine(db, id);
    return {
      machineId: id,
      channel,
      channels: AGENT_CHANNELS,
      bundledVersion: bundled.version,
      bundledBytes: bundled.bytes,
      credentialState: credentialState(ssh, secret),
      hostTrusted: hostTrusted(ssh),
      intervalSec: machine.interval_sec,
      plan,
      scriptUrl: `/api/machines/${id}/install-script?channel=${channel}`,
    };
  };

  router.get("/:id/agent/install", (req: Request, res: Response) => {
    const channel = isAgentChannel(req.query.channel) ? req.query.channel : "cn";
    res.json(info(req, channel));
  });

  router.post("/:id/agent/install", async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "bad_id" });
      return;
    }
    const body = z
      .object({ channel: z.string().optional(), force: z.boolean().optional() })
      .parse(req.body ?? {});
    const channel: AgentChannel = isAgentChannel(body.channel) ? body.channel : "cn";

    if (running.has(id)) {
      res.status(409).json({ error: "agent_install_running" });
      return;
    }
    let prepared: { script: string; plan: ReturnType<typeof agentSourcePlan> };
    try {
      prepared = renderMachineInstallScript({ db, secret, env, req, machineId: id, channel });
    } catch (e) {
      const error = e instanceof WorkspaceError ? e : new WorkspaceError(500, "internal_error");
      res.status(error.status).json({ error: error.message });
      return;
    }
    // Refuse before opening a stream: an untrusted host key would only fail on
    // connect, and the operator needs a normal JSON error to act on.
    try {
      if (!hostTrusted(sshMachine(db, id))) {
        res.status(409).json({ error: "ssh_host_untrusted" });
        return;
      }
    } catch (e) {
      const error = e instanceof WorkspaceError ? e : new WorkspaceError(500, "internal_error");
      res.status(error.status).json({ error: error.message });
      return;
    }

    running.add(id);
    const signal = AbortSignal.any([requestSignal(res), AbortSignal.timeout(INSTALL_TIMEOUT_MS)]);
    res.status(200);
    res.setHeader("content-type", "application/x-ndjson; charset=utf-8");
    res.setHeader("cache-control", "no-store");
    res.setHeader("x-accel-buffering", "no");
    res.flushHeaders?.();

    let log = "";
    let client: Client | undefined;
    let finished = false;
    const finish = (event: AgentInstallEvent) => {
      if (finished) return;
      finished = true;
      send(res, event);
      try {
        if (!res.writableEnded) res.end();
      } catch {
        // already closed
      }
    };

    const emitLog = (stream: "out" | "err", text: string) => {
      log += `${text}\n`;
      send(res, { type: "log", stream, text });
    };

    send(res, { type: "start", machineId: id, channel, plan: prepared.plan });

    try {
      client = await connectMachine(db, id, secret, signal);
    } catch (e) {
      const error = e instanceof WorkspaceError ? e.message : "ssh_connect_failed";
      emitLog("err", `连接失败: ${error}`);
      running.delete(id);
      finish({ type: "error", error });
      return;
    }

    const args = body.force ? ["--force"] : [];
    let stream: any;
    try {
      stream = await openExec(client, installCommand(args));
    } catch (e) {
      client.end();
      const error = e instanceof WorkspaceError ? e.message : "ssh_exec_failed";
      emitLog("err", `无法执行安装命令: ${error}`);
      running.delete(id);
      finish({ type: "error", error });
      return;
    }

    const out = lineWriter((line) => emitLog("out", line));
    const err = lineWriter((line) => emitLog("err", line));
    let settled = false;
    const cleanup = () => {
      running.delete(id);
      signal.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      if (settled) return;
      settled = true;
      try {
        stream.close();
      } catch {
        // already gone
      }
      try {
        client?.end();
      } catch {
        // already gone
      }
      cleanup();
      finish({ type: "error", error: "cancelled" });
    };
    signal.addEventListener("abort", onAbort, { once: true });
    // The browser may already be gone (closed the page while we connected): the
    // abort listener would never fire for an aborted-before-subscribe signal.
    if (signal.aborted) {
      onAbort();
      return;
    }

    stream.on("data", (chunk: Buffer) => out.push(chunk));
    stream.stderr?.on("data", (chunk: Buffer) => err.push(chunk));
    stream.on("error", (e: Error) => {
      if (settled) return;
      settled = true;
      out.flush();
      err.flush();
      cleanup();
      emitLog("err", `安装中断: ${String(e?.message ?? e).slice(0, 200)}`);
      finish({ type: "error", error: "agent_install_failed" });
    });
    stream.on("close", async (code: number) => {
      if (settled) return;
      settled = true;
      out.flush();
      err.flush();
      const failed = Number(code ?? 0) !== 0;
      let version = "";
      if (!failed) {
        try {
          version = await probeVersion(client!, signal);
        } catch {
          version = "";
        }
      }
      try {
        client?.end();
      } catch {
        // already gone
      }
      cleanup();
      if (failed) {
        finish({ type: "error", error: `agent_install_failed:${Number(code ?? 1)}` });
        return;
      }
      const provider = /已通过 (\S+) 安装/.exec(log)?.[1] ?? "";
      finish({ type: "done", code: 0, provider, version });
    });

    // The whole script is a few kilobytes; write it and close stdin so bash runs.
    stream.end(prepared.script);
  });

  return router;
}

/** Ask the freshly installed agent what version it reports. */
async function probeVersion(client: Client, signal: AbortSignal): Promise<string> {
  const command = "/usr/local/bin/yaws-agent -version 2>/dev/null | head -n1";
  const stream = await openExec(client, command);
  return new Promise<string>((resolve) => {
    let text = "";
    let settled = false;
    const done = (value: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => done(""), 15_000);
    signal.addEventListener("abort", () => done(""), { once: true });
    stream.on("data", (chunk: Buffer) => {
      text += chunk.toString();
      if (text.length > 200) stream.close();
    });
    stream.on("close", () => done(text.split("\n")[0].trim().slice(0, 64)));
    stream.on("error", () => done(""));
  });
}
