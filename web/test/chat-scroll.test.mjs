import test from "node:test";
import assert from "node:assert/strict";
import {
  atBottom,
  scrollIntent,
  shouldStickOnChange,
  stickAfterScroll,
  wheelMovesDown,
} from "../src/ui/chatScroll.ts";

const box = (scrollTop, scrollHeight = 1000, clientHeight = 400) => ({
  scrollTop,
  scrollHeight,
  clientHeight,
});

test("the end of the content counts as the bottom, not only the exact byte", () => {
  assert.equal(atBottom(box(600, 1000, 400)), true); // exactly at the end
  assert.equal(atBottom(box(580, 1000, 400)), true); // a few pixels short
  assert.equal(atBottom(box(500, 1000, 400)), false); // clearly reading back
  // Content shorter than the viewport is always "at the bottom".
  assert.equal(atBottom(box(0, 200, 400)), true);
});

test("a scroll event says which way the operator went", () => {
  assert.equal(scrollIntent(600, 500), "up");
  assert.equal(scrollIntent(500, 600), "down");
  // Sub-pixel wobble from a re-render is not a decision.
  assert.equal(scrollIntent(600, 600), "");
  assert.equal(scrollIntent(600, 599.5), "");
  assert.equal(scrollIntent(600, 601), "");
  assert.equal(wheelMovesDown(120), true);
  assert.equal(wheelMovesDown(-120), false);
});

test("reading back stops the follow, going back to the end resumes it", () => {
  // Scrolling up mid-answer: stop following, no jump.
  assert.deepEqual(stickAfterScroll(true, box(400)), {
    stick: false,
    jump: false,
  });
  // Scrolling back down to the end: follow again, and jump now so the last
  // tokens that arrived while reading are not missed.
  assert.deepEqual(stickAfterScroll(false, box(600)), {
    stick: true,
    jump: true,
  });
  // Already following and at the end: nothing to jump to.
  assert.deepEqual(stickAfterScroll(true, box(600)), {
    stick: true,
    jump: false,
  });
  // Still reading and still away from the end: unchanged.
  assert.deepEqual(stickAfterScroll(false, box(350)), {
    stick: false,
    jump: false,
  });
});

test("a running answer only follows while the operator is at the end", () => {
  const entries = [{ kind: "user" }, { kind: "assistant" }];
  assert.equal(shouldStickOnChange({ stick: true, busy: true, entries }), true);
  // Mid-run and reading back: a new tool card must not steal the view.
  assert.equal(
    shouldStickOnChange({ stick: false, busy: true, entries: [
      { kind: "user" },
      { kind: "tool" },
      { kind: "assistant" },
    ] }),
    false,
  );
  // A finished run always reveals its answer: the value of that outweighs a
  // scroll the operator can redo.
  assert.equal(shouldStickOnChange({ stick: false, busy: false, entries }), true);
  // Nothing to reveal when the transcript ends on the question.
  assert.equal(
    shouldStickOnChange({ stick: false, busy: false, entries: [{ kind: "user" }] }),
    false,
  );
  assert.equal(shouldStickOnChange({ stick: false, busy: false, entries: [] }), false);
});
