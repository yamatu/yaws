import test from "node:test";
import assert from "node:assert/strict";
import { createStreamBatch } from "../src/ui/streamBatch.ts";

/** A scheduler the test drives by hand: nothing runs until `frame()`. */
function frames() {
  let queued = [];
  let next = 1;
  return {
    schedule(run) {
      const id = next++;
      queued.push({ id, run });
      return id;
    },
    unschedule(id) {
      queued = queued.filter((item) => item.id !== id);
    },
    /** Runs the pending frame, like the browser does before the next paint. */
    frame() {
      const pending = queued;
      queued = [];
      for (const item of pending) item.run();
    },
    get pending() {
      return queued.length;
    },
  };
}

test("a burst of tokens becomes one update per frame", () => {
  const f = frames();
  const applied = [];
  const batch = createStreamBatch(
    (answer, thinking) => applied.push({ answer, thinking }),
    f.schedule,
    f.unschedule,
  );
  for (const chunk of ["你", "好", "，", "世", "界"]) batch.answer(chunk);
  assert.equal(f.pending, 1, "one frame is scheduled, not one per token");
  assert.deepEqual(applied, [], "nothing is applied before the frame");
  f.frame();
  assert.deepEqual(applied, [{ answer: "你好，世界", thinking: "" }]);
  // The next token opens a new frame instead of riding on the old one.
  batch.answer("!");
  f.frame();
  assert.deepEqual(applied.at(-1), { answer: "!", thinking: "" });
});

test("reasoning and answer text travel together", () => {
  const f = frames();
  const applied = [];
  const batch = createStreamBatch(
    (answer, thinking) => applied.push({ answer, thinking }),
    f.schedule,
    f.unschedule,
  );
  batch.thinking("先看看磁盘");
  batch.answer("结论");
  batch.thinking("。");
  f.frame();
  assert.deepEqual(applied, [{ answer: "结论", thinking: "先看看磁盘。" }]);
});

test("flush applies what is buffered and drops the scheduled frame", () => {
  const f = frames();
  const applied = [];
  const batch = createStreamBatch(
    (answer, thinking) => applied.push({ answer, thinking }),
    f.schedule,
    f.unschedule,
  );
  batch.answer("半句话");
  batch.flush();
  assert.deepEqual(applied, [{ answer: "半句话", thinking: "" }]);
  assert.equal(f.pending, 0, "the frame is not run twice");
  f.frame();
  assert.equal(applied.length, 1);
  // Nothing buffered: a flush is not an update.
  batch.flush();
  assert.equal(applied.length, 1);
});

test("cancel throws the buffer away without touching the transcript", () => {
  const f = frames();
  const applied = [];
  const batch = createStreamBatch(
    (answer, thinking) => applied.push({ answer, thinking }),
    f.schedule,
    f.unschedule,
  );
  batch.answer("还没写出的字");
  batch.cancel();
  assert.equal(f.pending, 0);
  f.frame();
  assert.deepEqual(applied, []);
  batch.flush();
  assert.deepEqual(applied, []);
});

test("empty chunks do not schedule a frame", () => {
  const f = frames();
  const applied = [];
  const batch = createStreamBatch(
    (answer, thinking) => applied.push({ answer, thinking }),
    f.schedule,
    f.unschedule,
  );
  batch.answer("");
  batch.thinking("");
  assert.equal(f.pending, 0);
  f.frame();
  assert.deepEqual(applied, []);
});
