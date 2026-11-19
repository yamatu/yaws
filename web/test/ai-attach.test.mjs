import test from "node:test";
import assert from "node:assert/strict";
import { groupSteps, stepSummary } from "../src/ui/chatGroups.ts";
import { fitSize, keepOriginal, MAX_EDGE } from "../src/ui/imageAttach.ts";
import { enqueue } from "../src/ui/promptQueue.ts";

const tool = (key, state = "ok") => ({ key, kind: "tool", tool: { state } });

test("three or more steps in a row fold into one group", () => {
  const items = groupSteps([
    { key: "u", kind: "user" },
    tool("a"),
    { key: "t", kind: "thinking" },
    tool("b"),
    tool("c"),
    { key: "s", kind: "steer" },
    tool("d"),
    { key: "ans", kind: "assistant" },
  ]);
  assert.deepEqual(
    items.map((item) => (item.type === "group" ? `group:${item.tools}` : item.entry.key)),
    ["u", "group:3", "s", "d", "ans"],
  );
  assert.equal(items[1].key, "g-a");
  assert.equal(items[1].entries.length, 4);
});

test("two steps stay as they are", () => {
  const items = groupSteps([tool("a"), tool("b"), { key: "x", kind: "assistant" }]);
  assert.deepEqual(items.map((item) => item.type), ["entry", "entry", "entry"]);
});

test("a folded line counts failures and steps still running", () => {
  assert.deepEqual(stepSummary(["ok", "error", "running", "awaiting", "ok"]), {
    total: 5,
    failed: 1,
    running: 1,
    awaiting: 1,
  });
});

test("pictures are scaled to the longest edge, never up", () => {
  assert.deepEqual(fitSize(4000, 3000), { w: MAX_EDGE, h: 1200 });
  assert.deepEqual(fitSize(1000, 3000), { w: 533, h: MAX_EDGE });
  assert.deepEqual(fitSize(800, 600), { w: 800, h: 600 });
});

test("small screenshots are sent untouched; photos and odd formats are re-encoded", () => {
  assert.equal(keepOriginal("image/png", 300_000, 1280, 800), true);
  assert.equal(keepOriginal("image/png", 5_000_000, 1280, 800), false);
  assert.equal(keepOriginal("image/jpeg", 900_000, 4032, 3024), false);
  assert.equal(keepOriginal("image/heic", 300_000, 800, 600), false);
});

test("a queued message may be pictures only", () => {
  const image = { id: "i", mime: "image/png", data: "AAAA" };
  const queue = enqueue([], "  ", "q1", [image]);
  assert.deepEqual(queue, [{ id: "q1", text: "", images: [image] }]);
  assert.equal(enqueue([], "", "q2"), null);
});
