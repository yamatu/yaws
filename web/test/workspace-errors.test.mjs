import assert from "node:assert/strict";
import test from "node:test";

import { workspaceError } from "../src/ui/workspaceErrors.ts";

test("ai run failures are explained", () => {
  // Every run failure the server can report has to read like a sentence, not
  // like a code: the operator only ever sees this mapping.
  assert.equal(
    workspaceError(new Error("ai_conversation_busy")),
    "这个对话正在运行，请等它结束或先停止",
  );
  assert.equal(
    workspaceError(new Error("ai_busy")),
    "同时运行的 AI 任务太多，请等其中一个结束后再试",
  );
  assert.match(workspaceError(new Error("ai_timeout")), /时间过长/);
});
