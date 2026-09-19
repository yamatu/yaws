import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_EXTRA_HOSTS,
  hostChoices,
  hostNames,
  hostSummary,
  toggleHost,
} from "../src/ui/aiHosts.ts";

const options = [
  { id: 1, name: "web-1" },
  { id: 2, name: "web-2" },
  { id: 3, name: "db-1" },
];

test("host picker helpers", async (t) => {
  await t.test("toggling adds and removes extra hosts only", () => {
    assert.deepEqual(toggleHost([], 2, 1), [2]);
    assert.deepEqual(toggleHost([2], 2, 1), []);
    assert.deepEqual(toggleHost([2, 3], 3, 1), [2]);
    // The primary host is always part of the conversation.
    assert.deepEqual(toggleHost([2], 1, 1), [2]);
  });

  await t.test("the cap returns the selection unchanged", () => {
    const full = Array.from({ length: MAX_EXTRA_HOSTS }, (_, i) => i + 2);
    assert.equal(toggleHost(full, 99, 1), full);
    assert.equal(toggleHost(full, 2, 1).length, MAX_EXTRA_HOSTS - 1);
  });

  await t.test("the summary counts the primary host", () => {
    assert.equal(hostSummary([], 3), "主机 1/3");
    assert.equal(hostSummary([2, 3], 3), "主机 3");
    assert.equal(hostSummary([], 1), "主机 1");
  });

  await t.test("names list the primary first and skip unknown hosts", () => {
    assert.deepEqual(hostNames([2, 3], options, "web-1"), [
      "web-1",
      "web-2",
      "db-1",
    ]);
    assert.deepEqual(hostNames([99], options, "web-1"), ["web-1"]);
    assert.deepEqual(hostNames([3, 2], options, "web-1"), [
      "web-1",
      "db-1",
      "web-2",
    ]);
  });

  await t.test("the picker never offers the primary host again", () => {
    assert.deepEqual(hostChoices(options, 1), [
      { id: 2, name: "web-2" },
      { id: 3, name: "db-1" },
    ]);
    assert.deepEqual(hostChoices(options, 9), options);
    assert.deepEqual(hostChoices([], 1), []);
  });
});
