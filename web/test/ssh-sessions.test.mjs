import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_SESSIONS,
  addSession,
  closeSession,
  ensureSession,
  nextActiveSession,
  parseSessions,
  sanitizeSessions,
  sessionRoom,
} from "../src/ui/sshSessions.ts";

test("only real machine ids survive a stored session list", () => {
  assert.deepEqual(sanitizeSessions([3, 1, 3, 2]), [3, 1, 2]);
  assert.deepEqual(sanitizeSessions(["7", 8]), [7, 8]);
  assert.deepEqual(sanitizeSessions([0, -4, 1.5, NaN, "x", null]), []);
  assert.deepEqual(sanitizeSessions("not an array"), []);
  assert.deepEqual(sanitizeSessions(null), []);
});

test("a broken or oversized stored list never breaks the workspace", () => {
  assert.deepEqual(parseSessions(null), []);
  assert.deepEqual(parseSessions("{oops"), []);
  assert.deepEqual(parseSessions("[2,2,5]"), [2, 5]);
  const many = Array.from({ length: MAX_SESSIONS + 8 }, (_, i) => i + 1);
  assert.deepEqual(sanitizeSessions(many), many.slice(0, MAX_SESSIONS));
  assert.equal(parseSessions(JSON.stringify(many)).length, MAX_SESSIONS);
});

test("opening a terminal appends it once and honours the tab limit", () => {
  assert.deepEqual(addSession([1], 2), [1, 2]);
  assert.deepEqual(addSession([1], 1), [1]);
  assert.deepEqual(addSession([1], 0), [1]);
  const full = Array.from({ length: MAX_SESSIONS }, (_, i) => i + 1);
  assert.deepEqual(addSession(full, 99), full);
  assert.equal(sessionRoom(full), 0);
  assert.equal(sessionRoom([1, 2]), MAX_SESSIONS - 2);
});

test("a whole fleet opens at once with one click", () => {
  // "Open every server" has to fit a normal fleet: a strip that caps out in the
  // middle of the list silently leaves servers closed.
  const fleet = Array.from({ length: 24 }, (_, i) => i + 1);
  let ids = [];
  for (const id of fleet) ids = addSession(ids, id);
  assert.deepEqual(ids, fleet);
  assert.equal(sessionRoom(ids), MAX_SESSIONS - fleet.length);
});

test("a deep link always opens, even when the strip is full", () => {
  const full = Array.from({ length: MAX_SESSIONS }, (_, i) => i + 1);
  assert.deepEqual(ensureSession(full, 42), [...full, 42]);
  assert.deepEqual(ensureSession([2, 3], 3), [2, 3]);
  assert.deepEqual(ensureSession([1], 0), [1]);
});

test("closing the active terminal hands over to a neighbour", () => {
  assert.deepEqual(closeSession([1, 2, 3], 2), [1, 3]);
  // Closing a background tab keeps the active terminal on screen.
  assert.equal(nextActiveSession([1, 2, 3], 1, 3), 3);
  // Otherwise the tab to the right takes over, then the one to the left.
  assert.equal(nextActiveSession([1, 2, 3], 2, 2), 3);
  assert.equal(nextActiveSession([1, 2, 3], 3, 3), 2);
  assert.equal(nextActiveSession([1, 2, 3], 1, 1), 2);
  // The last terminal leaves nothing behind, so the page navigates away.
  assert.equal(nextActiveSession([4], 4, 4), 0);
  assert.equal(nextActiveSession([], 4, 4), 0);
});
