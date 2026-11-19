import test from "node:test";
import assert from "node:assert/strict";
import { enterAction, parseEnterPreference } from "../src/ui/promptEnter.ts";
import { DRAFT_LIMIT, draftKey, readDraft, writeDraft } from "../src/ui/promptDrafts.ts";
import { QUEUE_LIMIT, enqueue, flushDecision, removeQueued } from "../src/ui/promptQueue.ts";
import {
  applyCommand,
  BUILTIN_COMMANDS,
  builtinCommand,
  matchCommands,
  slashQuery,
} from "../src/ui/slashCommands.ts";

const enter = (extra = {}) => ({ key: "Enter", shiftKey: false, ...extra });

test("desktop: Enter sends, Shift+Enter is a newline", () => {
  assert.equal(enterAction(enter(), false, "auto"), "send");
  assert.equal(enterAction(enter({ shiftKey: true }), false, "auto"), "newline");
});

test("phone: Enter is a newline, the button sends", () => {
  assert.equal(enterAction(enter(), true, "auto"), "newline");
  // Touch keyboards report auto-capitalisation as Shift: not a real shortcut.
  assert.equal(enterAction(enter({ shiftKey: true }), true, "auto"), "newline");
  // A hardware keyboard on a tablet: a real Shift keydown was seen.
  assert.equal(
    enterAction(enter({ shiftKey: true, explicitShift: true }), true, "auto"),
    "send",
  );
});

test("preference overrides the device default", () => {
  assert.equal(enterAction(enter(), true, "send"), "send");
  assert.equal(enterAction(enter(), false, "newline"), "newline");
  assert.equal(enterAction(enter({ shiftKey: true }), false, "newline"), "send");
});

test("Ctrl/Cmd+Enter always sends; IME composition and other keys are ignored", () => {
  assert.equal(enterAction(enter({ ctrlKey: true }), true, "newline"), "send");
  assert.equal(enterAction(enter({ metaKey: true }), true, "auto"), "send");
  assert.equal(enterAction(enter({ composing: true }), false, "auto"), "ignore");
  assert.equal(enterAction({ key: "a", shiftKey: false }, false, "auto"), "ignore");
});

test("unknown stored preference falls back to auto", () => {
  assert.equal(parseEnterPreference(null), "auto");
  assert.equal(parseEnterPreference("bogus"), "auto");
  assert.equal(parseEnterPreference("newline"), "newline");
});

function memoryStorage() {
  const map = new Map();
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  };
}

test("drafts are kept per machine and conversation", () => {
  const storage = memoryStorage();
  assert.notEqual(draftKey(1, ""), draftKey(1, "c1"));
  assert.notEqual(draftKey(1, "c1"), draftKey(2, "c1"));
  writeDraft(draftKey(1, "c1"), "nginx 为什么 502", storage);
  assert.equal(readDraft(draftKey(1, "c1"), storage), "nginx 为什么 502");
  assert.equal(readDraft(draftKey(1, ""), storage), "");
});

test("an emptied draft is removed, a huge one is capped", () => {
  const storage = memoryStorage();
  const key = draftKey(1, "");
  writeDraft(key, "x", storage);
  writeDraft(key, "   ", storage);
  assert.equal(storage.map.size, 0);
  writeDraft(key, "y".repeat(DRAFT_LIMIT + 50), storage);
  assert.equal(readDraft(key, storage).length, DRAFT_LIMIT);
});

test("queue: trims, refuses empty text and caps its length", () => {
  let queue = [];
  assert.equal(enqueue(queue, "   ", "a"), null);
  for (let i = 0; i < QUEUE_LIMIT; i++) queue = enqueue(queue, ` q${i} `, `id${i}`);
  assert.equal(queue.length, QUEUE_LIMIT);
  assert.equal(queue[0].text, "q0");
  assert.equal(enqueue(queue, "one more", "x"), null);
  assert.deepEqual(
    removeQueued(queue, "id0").map((item) => item.id),
    queue.slice(1).map((item) => item.id),
  );
});

test("queue flushes only when idle, clean and nothing awaits approval", () => {
  const base = { running: false, queued: 1, pending: 0, halted: false };
  assert.equal(flushDecision(base), "send");
  assert.equal(flushDecision({ ...base, queued: 0 }), "wait");
  assert.equal(flushDecision({ ...base, running: true }), "wait");
  assert.equal(flushDecision({ ...base, halted: true }), "hold");
  assert.equal(flushDecision({ ...base, pending: 2 }), "hold");
});

test("slash query: only while the caret is in the leading command name", () => {
  assert.equal(slashQuery("/", 1), "");
  assert.equal(slashQuery("/dep", 4), "dep");
  assert.equal(slashQuery("/deploy now", 11), null);
  assert.equal(slashQuery("/deploy now", 3), "deploy");
  assert.equal(slashQuery("hello /x", 8), null);
  assert.equal(slashQuery("/中文", 3), null);
});

test("slash matches: prefix first, then substring or description", () => {
  const commands = [
    ...BUILTIN_COMMANDS,
    { name: "renew-cert", description: "续签证书", source: "extension" },
    { name: "newrelic", description: "agent", source: "extension" },
  ];
  assert.deepEqual(
    matchCommands(commands, "new").map((c) => c.name),
    ["new", "newrelic", "renew-cert"],
  );
  assert.deepEqual(matchCommands(commands, "证书").map((c) => c.name), ["renew-cert"]);
  assert.equal(matchCommands(commands, "").length, commands.length);
});

test("choosing a command keeps typed arguments; built-ins match whole messages", () => {
  assert.equal(applyCommand("/de", "deploy"), "/deploy ");
  assert.equal(applyCommand("/de  web-1", "deploy"), "/deploy web-1");
  assert.equal(builtinCommand(" /new "), "new");
  assert.equal(builtinCommand("/stop"), "stop");
  assert.equal(builtinCommand("/new chat"), null);
  assert.equal(builtinCommand("/deploy"), null);
});
