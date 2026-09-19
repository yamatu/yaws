import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_VIA_DEPTH,
  viaCandidates,
  viaChain,
  viaChildren,
  viaLabel,
  viaNames,
} from "../src/ui/sshVia.ts";

const hosts = [
  { id: 1, name: "网关", viaMachineId: 0 },
  { id: 2, name: "内网 A", viaMachineId: 1 },
  { id: 3, name: "内网 B", viaMachineId: 2 },
  { id: 4, name: "内网 C", viaMachineId: 3 },
  { id: 5, name: "内网 D", viaMachineId: 0 },
];

test("relay helpers", async (t) => {
  await t.test("a chain lists the relays outermost last", () => {
    assert.deepEqual(viaChain(hosts, 1), [1]);
    assert.deepEqual(viaChain(hosts, 2), [2, 1]);
    assert.deepEqual(viaChain(hosts, 3), [3, 2, 1]);
  });

  await t.test("a loop stops instead of spinning", () => {
    const loop = [
      { id: 1, name: "a", viaMachineId: 2 },
      { id: 2, name: "b", viaMachineId: 1 },
    ];
    assert.deepEqual(viaChain(loop, 1), [1, 2]);
    assert.deepEqual(viaChain(loop, 2), [2, 1]);
  });

  await t.test("a relay that is gone is not invented", () => {
    assert.deepEqual(viaChain([{ id: 9, name: "x", viaMachineId: 42 }], 9), [9]);
    assert.deepEqual(viaNames([{ id: 9, name: "x", viaMachineId: 42 }], 9), []);
  });

  await t.test("names and labels read outermost first", () => {
    assert.deepEqual(viaNames(hosts, 1), []);
    assert.deepEqual(viaNames(hosts, 2), ["网关"]);
    assert.deepEqual(viaNames(hosts, 3), ["网关", "内网 A"]);
    assert.equal(viaLabel(hosts, 1), "");
    assert.equal(viaLabel(hosts, 2), "经由 网关");
    assert.equal(viaLabel(hosts, 3), "经由 网关 → 内网 A");
  });

  await t.test("candidates exclude self, loops and chains that are too deep", () => {
    const ids = (id) => viaCandidates(hosts, id).map((h) => h.id);
    // Nothing may relay 1 except a free machine: every other host already
    // reaches it, so naming it would close a loop.
    assert.deepEqual(ids(1), [5]);
    // 2 may keep 1 (its current relay), and 3/4 are inside it.
    assert.deepEqual(ids(2), [1, 5]);
    assert.deepEqual(ids(3), [1, 2, 5]);
    // 3 sits behind two relays, so it cannot carry anything else.
    assert.deepEqual(ids(4), [1, 2, 5]);
    assert.deepEqual(ids(5), [1, 2]);
  });

  await t.test("the depth cap matches the server's two hops", () => {
    assert.equal(MAX_VIA_DEPTH, 2);
    const tooDeep = viaCandidates(hosts, 4).find((h) => h.id === 3);
    assert.equal(tooDeep, undefined);
    for (const host of viaCandidates(hosts, 4))
      assert.ok(viaChain(hosts, host.id).length - 1 < MAX_VIA_DEPTH);
  });

  await t.test("a stored relay stays visible even when it can no longer be picked", () => {
    // 3 is behind two relays, so it is not offered for 4…
    assert.equal(viaCandidates(hosts, 4).some((h) => h.id === 3), false);
    // …but if it is what machine 4 already uses, the picker must still show it.
    assert.deepEqual(viaCandidates(hosts, 4, 3).map((h) => h.id), [1, 2, 3, 5]);
    // `keep` cannot smuggle in the machine itself.
    assert.equal(viaCandidates(hosts, 4, 4).some((h) => h.id === 4), false);
  });

  await t.test("children are the machines opened from a terminal", () => {
    assert.deepEqual(viaChildren(hosts, 1).map((h) => h.id), [2]);
    assert.deepEqual(viaChildren(hosts, 2).map((h) => h.id), [3]);
    assert.deepEqual(viaChildren(hosts, 3).map((h) => h.id), [4]);
    assert.deepEqual(viaChildren(hosts, 4), []);
  });
});
