import assert from "node:assert/strict";
import test from "node:test";

import { orderTurnEntries } from "../src/ui/chatOrder.ts";

const user = (id) => ({ key: id, kind: "user" });
const answer = (id) => ({ key: id, kind: "assistant", text: id });
const tool = (id) => ({ key: id, kind: "tool", tool: { id } });
const proposal = (id) => ({ key: id, kind: "proposal", proposal: { id } });
const thinking = (id) => ({ key: id, kind: "thinking", text: id });

const keys = (entries) => entries.map((entry) => entry.key);

test("answers are read after the steps that produced them", () => {
  // The model streamed its first sentence before it called the tool, so the
  // assistant entry arrives first — it still has to render below the step.
  assert.deepEqual(
    keys(orderTurnEntries([user("u1"), answer("a1"), tool("t1")])),
    ["u1", "t1", "a1"],
  );
});

test("every user turn keeps its own steps and answer", () => {
  const ordered = orderTurnEntries([
    user("u1"),
    answer("a1"),
    tool("t1"),
    user("u2"),
    answer("a2"),
    tool("t2"),
    proposal("p2"),
  ]);
  assert.deepEqual(keys(ordered), ["u1", "t1", "a1", "u2", "t2", "p2", "a2"]);
});

test("several answers of one turn keep their relative order", () => {
  const ordered = orderTurnEntries([
    user("u1"),
    answer("a1"),
    tool("t1"),
    answer("a2"),
    tool("t2"),
  ]);
  assert.deepEqual(keys(ordered), ["u1", "t1", "t2", "a1", "a2"]);
});

test("a transcript without user messages still lists steps first", () => {
  assert.deepEqual(
    keys(orderTurnEntries([answer("a1"), tool("t1"), tool("t2")])),
    ["t1", "t2", "a1"],
  );
});

test("reasoning reads with the steps, above the answer", () => {
  // The model thinks, then acts, then thinks again: all of it belongs to the
  // turn's steps, and the answer closes the turn.
  const ordered = orderTurnEntries([
    user("u1"),
    thinking("k1"),
    tool("t1"),
    thinking("k2"),
    answer("a1"),
  ]);
  assert.deepEqual(keys(ordered), ["u1", "k1", "t1", "k2", "a1"]);
});

test("entries are never dropped and the input is not mutated", () => {
  const entries = [user("u1"), answer("a1"), tool("t1")];
  const before = [...entries];
  const ordered = orderTurnEntries(entries);
  assert.equal(ordered.length, entries.length);
  assert.deepEqual(entries, before);
  assert.notEqual(ordered, entries);
  assert.deepEqual(
    keys(orderTurnEntries([user("u1"), tool("t1")])),
    ["u1", "t1"],
  );
  assert.deepEqual(orderTurnEntries([]), []);
});
