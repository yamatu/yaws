import test from "node:test";
import assert from "node:assert/strict";
import {
  acceptEvent,
  formatElapsed,
  progressLabel,
  progressTone,
  startProgress,
  stopProgress,
  toolVerb,
} from "../src/ui/aiProgress.ts";

/** Feeds a list of events through the state machine. */
function run(events) {
  let progress = null;
  for (const event of events) progress = acceptEvent(progress, event);
  return progress;
}

const tool = (name, detail, state) => ({
  type: "tool",
  tool: { id: name + detail, name, detail, state },
});

test("a run starts by thinking instead of claiming a result", () => {
  const progress = run([{ type: "start" }]);
  assert.equal(progress.kind, "thinking");
  assert.equal(progress.step, 1);
  assert.match(progressLabel(progress, 3000), /^第 1 步 · 正在思考… · 3 秒$/);
  assert.equal(progressTone(progress), "busy");
});

test("every tool says what it is working on", () => {
  let progress = run([{ type: "start" }, tool("read_file", "/etc/nginx/nginx.conf", "running")]);
  assert.equal(progress.kind, "tool");
  assert.equal(
    progressLabel(progress, 5000),
    "第 1 步 · 正在读取文件 /etc/nginx/nginx.conf · 5 秒",
  );
  progress = acceptEvent(progress, tool("run_command", "nginx -t", "running"));
  assert.match(progressLabel(progress, 9000), /正在执行命令 nginx -t/);
  assert.equal(toolVerb("server_stats"), "正在读取服务器占用");
  assert.equal(toolVerb("unknown_tool", true), "已执行");
});

test("a finished tool is not a finished answer", () => {
  const progress = run([
    { type: "start" },
    tool("read_log", "/var/log/nginx/error.log", "running"),
    tool("read_log", "/var/log/nginx/error.log", "ok"),
  ]);
  assert.equal(progress.kind, "thinking");
  assert.equal(progress.step, 2);
  assert.equal(progress.ok, 1);
  assert.equal(progress.pending, 0);
  // Never the bare word "完成": the model still has to look at what it read.
  assert.equal(
    progressLabel(progress, 65000),
    "第 2 步 · 已读取日志 /var/log/nginx/error.log，继续分析 · 1 分 05 秒",
  );
});

test("a failed tool keeps the run going with a warning", () => {
  const progress = run([
    { type: "start" },
    tool("run_command", "nginx -t", "error"),
  ]);
  assert.equal(progress.kind, "thinking");
  assert.equal(progress.failed, 1);
  assert.match(progressLabel(progress, 2000), /nginx -t出错，正在换思路/);
});

test("an operation waiting for approval is called out while the run runs", () => {
  const progress = run([
    { type: "start" },
    tool("run_command", "systemctl restart nginx", "awaiting"),
  ]);
  assert.equal(progress.kind, "waiting");
  assert.equal(progress.pending, 1);
  assert.equal(progressLabel(progress, 4000), "等待你确认 1 个操作 · 4 秒");
  assert.equal(progressTone(progress), "warn");
});

test("streaming text means the answer is being written", () => {
  const progress = run([
    { type: "start" },
    tool("read_file", "/a", "ok"),
    { type: "delta", text: "磁盘" },
  ]);
  assert.equal(progress.kind, "writing");
  assert.match(progressLabel(progress, 12000), /第 2 步 · 正在整理回答… · 12 秒/);
});

test("streamed reasoning keeps the run in the thinking state", () => {
  const progress = run([
    { type: "start" },
    tool("read_file", "/a", "ok"),
    { type: "thinking", text: "先确认目录结构" },
  ]);
  assert.equal(progress.kind, "thinking");
  assert.equal(progress.step, 2);
  assert.equal(progress.last, "");
  assert.match(progressLabel(progress, 3000), /第 2 步 · 正在思考… · 3 秒/);
  // Reasoning must not undo an answer that is already streaming.
  const writing = run([{ type: "start" }, { type: "delta", text: "结论" }]);
  assert.equal(acceptEvent(writing, { type: "thinking", text: "又想了想" }).kind, "writing");
  // Usage is reporting, not progress.
  assert.equal(
    acceptEvent(writing, { type: "usage", usage: { totalTokens: 9 } }),
    writing,
  );
});

test("only the done event reports a finished run", () => {
  const progress = run([
    { type: "start" },
    tool("run_command", "df -h", "running"),
    tool("run_command", "df -h", "ok"),
    tool("read_file", "/etc/fstab", "ok"),
    { type: "delta", text: "看完了" },
    { type: "answer", text: "看完了" },
    { type: "done" },
  ]);
  assert.equal(progress.kind, "done");
  assert.equal(progressTone(progress), "ok");
  assert.equal(progressLabel(progress, 16000), "已完成 · 用时 16 秒 · 共 2 个步骤");
  // A pending proposal means the assistant cannot finish on its own.
  assert.equal(
    progressLabel(progress, 16000, 1),
    "已完成 · 用时 16 秒 · 共 2 个步骤 · 1 个操作等待确认",
  );
  assert.equal(progressTone({ ...progress, kind: "waiting" }), "warn");
  // A run that ends on an approval card is still finished, but flagged.
  const halted = run([
    { type: "start" },
    tool("run_command", "systemctl restart nginx", "awaiting"),
    { type: "proposal" },
    { type: "done" },
  ]);
  assert.equal(halted.kind, "done");
  assert.equal(progressTone(halted), "warn");
  assert.equal(
    progressLabel(halted, 5000),
    "已完成 · 用时 5 秒 · 1 个操作等待确认",
  );
});

test("errors and cancellations end the run with their own wording", () => {
  const failed = run([{ type: "start" }, { type: "error", error: "ai_failed" }]);
  assert.equal(failed.kind, "failed");
  assert.equal(progressLabel(failed, 1000), "执行失败 · 用时 1 秒");
  assert.equal(progressTone(failed), "bad");
  const stopped = stopProgress(run([{ type: "start" }]));
  assert.equal(stopped.kind, "stopped");
  assert.equal(progressLabel(stopped, 2000), "已停止 · 用时 2 秒");
});

test("unknown events and an idle chat are left alone", () => {
  assert.equal(acceptEvent(null, { type: "delta", text: "x" }), null);
  const progress = startProgress();
  assert.equal(acceptEvent(progress, { type: "notice" }), progress);
  assert.equal(acceptEvent(progress, { type: "proposal" }), progress);
});

test("elapsed time reads like a person would say it", () => {
  assert.equal(formatElapsed(0), "0 秒");
  assert.equal(formatElapsed(9000), "9 秒");
  assert.equal(formatElapsed(59000), "59 秒");
  assert.equal(formatElapsed(65000), "1 分 05 秒");
  assert.equal(formatElapsed(3_723_000), "1 小时 02 分");
  assert.equal(formatElapsed(-5), "0 秒");
});
