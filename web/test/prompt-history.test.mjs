import test from "node:test";
import assert from "node:assert/strict";
import {
  atEdge,
  down,
  HISTORY_LIMIT,
  NEW_CURSOR,
  remember,
  step,
  up,
} from "../src/ui/promptHistory.ts";

test("a question is remembered once, trimmed, newest last", () => {
  let history = [];
  history = remember(history, "  磁盘满了吗  ");
  history = remember(history, "nginx 为什么 502");
  assert.deepEqual(history, ["磁盘满了吗", "nginx 为什么 502"]);
  // Asking the same thing again should not need two `up` presses to walk past.
  history = remember(history, "nginx 为什么 502");
  assert.deepEqual(history, ["磁盘满了吗", "nginx 为什么 502"]);
  // A blank question is not a question.
  assert.deepEqual(remember(history, "   "), history);
  // Asking it again after something else appends it afresh: the point of the
  // recall is the questions in the order they were asked, not a unique set.
  assert.deepEqual(remember(history, "磁盘满了吗"), [
    "磁盘满了吗",
    "nginx 为什么 502",
    "磁盘满了吗",
  ]);
});

test("the oldest questions fall off once there are too many", () => {
  let history = [];
  for (let i = 1; i <= HISTORY_LIMIT + 5; i += 1)
    history = remember(history, `问题 ${i}`);
  assert.equal(history.length, HISTORY_LIMIT);
  assert.equal(history.at(0), "问题 6");
  assert.equal(history.at(-1), `问题 ${HISTORY_LIMIT + 5}`);
});

test("up walks back through the questions, newest first", () => {
  const history = ["第一个", "第二个", "第三个"];
  const first = up(history, NEW_CURSOR, "");
  assert.equal(first.value, "第三个");
  assert.equal(first.cursor.index, 1);
  const second = up(history, first.cursor, "");
  assert.equal(second.value, "第二个");
  const third = up(history, second.cursor, "");
  assert.equal(third.value, "第一个");
  // There is nothing older than the first question.
  assert.equal(up(history, third.cursor, ""), null);
});

test("down walks forward and restores the draft that was being written", () => {
  const history = ["第一个", "第二个"];
  // The operator had started typing, then pressed `up` twice.
  let cursor = NEW_CURSOR;
  const one = up(history, cursor, "还没写完的");
  cursor = one.cursor;
  const two = up(history, cursor, "还没写完的");
  cursor = two.cursor;
  assert.equal(two.value, "第一个");
  // Coming back down returns the questions, then the half-written question —
  // not an empty box, which is what makes the arrows safe to use mid-thought.
  const back = down(history, cursor, "还没写完的");
  assert.equal(back.value, "第二个");
  const home = down(history, back.cursor, "还没写完的");
  assert.equal(home.value, "还没写完的");
  assert.equal(home.cursor.index, 0);
  assert.equal(home.cursor.draft, "还没写完的");
  // Already at the draft: nothing newer to recall.
  assert.equal(down(history, home.cursor, "还没写完的"), null);
});

test("the draft is captured on the first step away, not overwritten later", () => {
  const history = ["a", "b", "c"];
  const one = up(history, NEW_CURSOR, "草稿");
  const two = up(history, one.cursor, "被改过的");
  const three = up(history, two.cursor, "又被改过的");
  // The three results carry the questions; the draft stayed the original.
  assert.deepEqual(
    [one.value, two.value, three.value],
    ["c", "b", "a"],
  );
  assert.equal(three.cursor.draft, "草稿");
  assert.equal(down(history, three.cursor, "x").cursor.draft, "草稿");
});

test("a step that would leave the history is not a decision", () => {
  const history = ["only"];
  assert.equal(step(history, NEW_CURSOR, 1, ""), null); // nothing newer
  const at = up(history, NEW_CURSOR, "");
  assert.equal(at.cursor.index, 1);
  assert.equal(step(history, at.cursor, -1, ""), null); // nothing older
  // An index can never go negative, whatever it is handed.
  assert.equal(step(history, { index: 0, draft: "" }, 1, ""), null);
});

test("an arrow key is only recall at the edge of a multi-line question", () => {
  //         0   3 4   7 8  11
  const value = "第一行\n第二行\n第三行";
  // `up` still belongs to the caret while there is a line above it.
  assert.equal(atEdge(value, 0, -1), true); // very start
  assert.equal(atEdge(value, 3, -1), true); // end of the first line
  assert.equal(atEdge(value, 4, -1), false); // start of the second line
  assert.equal(atEdge(value, 8, -1), false); // start of the third line
  // `down` likewise: only the last line hands the key over.
  assert.equal(atEdge(value, 0, 1), false);
  assert.equal(atEdge(value, 4, 1), false); // the second line has one below
  assert.equal(atEdge(value, 11, 1), true); // end of the last line
  // A single-line question is always at both edges.
  assert.equal(atEdge("一行", 2, -1), true);
  assert.equal(atEdge("一行", 0, 1), true);
  // A caret the browser reports past the end must not escape the string.
  assert.equal(atEdge("一行", 99, 1), true);
  assert.equal(atEdge("一行\n二行", 99, 1), true);
  assert.equal(atEdge("一行\n二行", -5, -1), true);
});
