/**
 * Live status of one assistant run.
 *
 * The chat used to show the state of the last tool call, so a finished tool
 * ("完成") looked like a finished answer while the model was still working.
 * These rules turn the stream of server events into a line that always says
 * what is happening *now* — thinking, which file or command is being handled,
 * writing the answer, waiting for the operator — and only reports a finished
 * run when the run really finished.
 *
 * Pure on purpose: no React, no timer, no DOM, so the phase rules can be
 * tested under `node --test`.
 */

export type ProgressKind =
  | "thinking"
  | "tool"
  | "writing"
  | "waiting"
  | "done"
  | "failed"
  | "stopped";

export type Progress = {
  kind: ProgressKind;
  /** Round of the model loop, 1-based. */
  step: number;
  /** What the current (or last) tool works on: a path, a command, "". */
  detail: string;
  /** Tool name of the current (or last) step. */
  tool: string;
  /** Tool steps that finished successfully. */
  ok: number;
  /** Tool steps that failed. */
  failed: number;
  /** Operations that went to the operator for approval. */
  pending: number;
  /** How the previous tool step ended: "" | "ok" | "error". */
  last: "" | "ok" | "error";
};

type Event = Record<string, unknown>;

/** [busy, finished] wording for every tool the assistant can call. */
const VERBS: Record<string, [string, string]> = {
  list_files: ["正在查看目录", "已查看目录"],
  read_file: ["正在读取文件", "已读取文件"],
  read_log: ["正在读取日志", "已读取日志"],
  run_command: ["正在执行命令", "已执行命令"],
  write_file: ["正在写入文件", "已写入文件"],
  server_stats: ["正在读取服务器占用", "已读取服务器占用"],
};

export function startProgress(): Progress {
  return {
    kind: "thinking",
    step: 1,
    detail: "",
    tool: "",
    ok: 0,
    failed: 0,
    pending: 0,
    last: "",
  };
}

export function toolVerb(name: string, finished = false): string {
  const pair = VERBS[name];
  if (pair) return pair[finished ? 1 : 0];
  return finished ? "已执行" : "正在执行";
}

/** Applies one server event. Unknown events leave the status untouched. */
export function acceptEvent(prev: Progress | null, event: Event): Progress | null {
  const kind = String(event.type ?? "");
  if (kind === "start") return startProgress();
  if (!prev) return prev;
  if (kind === "phase") {
    // Reserved for a future server-side phase hint.
    return { ...prev, kind: "thinking", step: prev.step + 1, last: "" };
  }
  if (kind === "tool") {
    const tool = (event.tool ?? {}) as Record<string, unknown>;
    const state = String(tool.state ?? "running");
    const detail = String(tool.detail ?? "");
    const name = String(tool.name ?? "");
    if (state === "running")
      return { ...prev, kind: "tool", detail, tool: name, last: "" };
    if (state === "awaiting")
      return {
        ...prev,
        kind: "waiting",
        detail,
        tool: name,
        pending: prev.pending + 1,
        last: "",
      };
    if (state === "ok")
      return {
        ...prev,
        kind: "thinking",
        step: prev.step + 1,
        detail,
        tool: name,
        ok: prev.ok + 1,
        last: "ok",
      };
    return {
      ...prev,
      kind: "thinking",
      step: prev.step + 1,
      detail,
      tool: name,
      failed: prev.failed + 1,
      last: "error",
    };
  }
  if (kind === "delta" || kind === "answer")
    return prev.kind === "writing" ? prev : { ...prev, kind: "writing", last: "" };
  if (kind === "error") return { ...prev, kind: "failed", last: "" };
  // Only `done` finishes the run. Operations still waiting for the operator are
  // part of the final line instead of turning it back into "working".
  if (kind === "done") return { ...prev, kind: "done", last: "" };
  return prev;
}

/** The answer stopped because the operator cancelled it. */
export function stopProgress(prev: Progress | null): Progress | null {
  return prev ? { ...prev, kind: "stopped" } : prev;
}

/** The run ended in an error before a `failed` event could arrive. */
export function failProgress(prev: Progress | null): Progress | null {
  return prev && prev.kind !== "failed" ? { ...prev, kind: "failed" } : prev;
}

export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total} 秒`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60)
    return `${minutes} 分 ${String(total % 60).padStart(2, "0")} 秒`;
  return `${Math.floor(minutes / 60)} 小时 ${String(minutes % 60).padStart(2, "0")} 分`;
}

/** `pending` comes from the conversation itself: it is the authoritative count. */
export function progressLabel(
  progress: Progress,
  elapsedMs: number,
  pending = progress.pending,
): string {
  const time = formatElapsed(elapsedMs);
  const step = `第 ${progress.step} 步`;
  const target = progress.detail ? ` ${progress.detail}` : "";
  switch (progress.kind) {
    case "tool":
      return `${step} · ${toolVerb(progress.tool)}${target} · ${time}`;
    case "writing":
      return `${step} · 正在整理回答… · ${time}`;
    case "waiting":
      if (pending > 0)
        return `等待你确认 ${pending} 个操作 · ${time}`;
      return `${step} · 正在继续处理… · ${time}`;
    case "done": {
      const steps = progress.ok + progress.failed;
      const done = `已完成 · 用时 ${time}${steps > 1 ? ` · 共 ${steps} 个步骤` : ""}`;
      return pending > 0 ? `${done} · ${pending} 个操作等待确认` : done;
    }
    case "failed":
      return `执行失败 · 用时 ${time}`;
    case "stopped":
      return `已停止 · 用时 ${time}`;
    default:
      if (progress.last === "ok")
        return `${step} · ${toolVerb(progress.tool, true)}${target}，继续分析 · ${time}`;
      if (progress.last === "error")
        return `${step} · ${progress.detail || "上一步"}出错，正在换思路 · ${time}`;
      return `${step} · 正在思考… · ${time}`;
  }
}

/** Colour family for the status line. */
export function progressTone(progress: Progress): "busy" | "ok" | "warn" | "bad" {
  if (progress.kind === "done") return progress.pending > 0 ? "warn" : "ok";
  if (progress.kind === "waiting") return "warn";
  if (progress.kind === "failed") return "bad";
  if (progress.kind === "stopped") return "warn";
  return "busy";
}
