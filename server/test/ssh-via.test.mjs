import test from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";
import { harness } from "./fixture.mjs";
import { assertVia, detachViaChildren, hopErrorCode, sshChain } from "../dist/ssh.js";

async function request(f, url, method = "GET", body, token = f.token) {
  const response = await fetch(f.url + url, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: response.status, body: parsed };
}

/** The workspace refuses to touch a host with an unverified host key. */
async function trust(f, machineId) {
  const inspected = await request(
    f,
    `/api/machines/${machineId}/workspace/host-key/inspect`,
    "POST",
  );
  assert.equal(inspected.status, 200, JSON.stringify(inspected.body));
  const saved = await request(
    f,
    `/api/machines/${machineId}/workspace/host-key`,
    "PUT",
    inspected.body,
  );
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
}

const clearVia = (f) => f.db.prepare("UPDATE machines SET via_machine_id = 0").run();

/** Extra machines have to be inserted directly: the fixture has no create route. */
function addMachine(f, id, ssh = true) {
  f.db
    .prepare(
      `INSERT INTO machines(id,name,ssh_host,ssh_port,ssh_user,ssh_password_enc,
        agent_key_hash,agent_key_enc,via_machine_id,ssh_host_fingerprint,
        ssh_fingerprint_address,created_at,updated_at)
       VALUES (?,?,?,?,?,?,'','',0,'','',0,0)`,
    )
    .run(
      id,
      `Extra ${id}`,
      ssh ? "127.0.0.1" : "",
      ssh ? f.db.prepare("SELECT ssh_port as p FROM machines WHERE id = 1").get().p : 22,
      ssh ? "fixture" : "",
      ssh ? f.db.prepare("SELECT ssh_password_enc as p FROM machines WHERE id = 1").get().p : "",
    );
}

const setVia = (f, id, via) =>
  f.db.prepare("UPDATE machines SET via_machine_id = ? WHERE id = ?").run(via, id);

test("ssh relay", async (t) => {
  const f = await harness();
  t.after(() => f.close());
  const port = f.db.prepare("SELECT ssh_port as p FROM machines WHERE id = 1").get().p;

  await t.test("a chain is walked jump host first", () => {
    assert.deepEqual(sshChain(f.db, 1), [1]);
    f.db.prepare("UPDATE machines SET via_machine_id = 2 WHERE id = 1").run();
    assert.deepEqual(sshChain(f.db, 1), [2, 1]);
    // Two hops are allowed…
    f.db.prepare("UPDATE machines SET via_machine_id = 3 WHERE id = 2").run();
    assert.deepEqual(sshChain(f.db, 1), [3, 2, 1]);
    // …a third one is not.
    addMachine(f, 4);
    f.db.prepare("UPDATE machines SET via_machine_id = 4 WHERE id = 3").run();
    assert.throws(() => sshChain(f.db, 1), /via_depth/);
    clearVia(f);
    // A machine that reaches itself would be dialled forever.
    f.db.prepare("UPDATE machines SET via_machine_id = 2 WHERE id = 1").run();
    f.db.prepare("UPDATE machines SET via_machine_id = 1 WHERE id = 2").run();
    assert.throws(() => sshChain(f.db, 1), /via_loop/);
    clearVia(f);
    assert.deepEqual(sshChain(f.db, 1), [1]);
  });

  await t.test("a relay is validated before it is stored", () => {
    assert.doesNotThrow(() => assertVia(f.db, 1, 0));
    assert.doesNotThrow(() => assertVia(f.db, 1, 2));
    assert.throws(() => assertVia(f.db, 1, 1), /via_self/);
    assert.throws(() => assertVia(f.db, 1, 99), /machine_not_found/);
    // A machine without SSH credentials cannot carry a tunnel.
    addMachine(f, 5, false);
    assert.throws(() => assertVia(f.db, 1, 5), /via_not_configured/);
    f.db.prepare("UPDATE machines SET via_machine_id = 1 WHERE id = 2").run();
    assert.throws(() => assertVia(f.db, 1, 2), /via_loop/);
    clearVia(f);
  });

  await t.test("the API stores, reports and clears a relay", () => {
    // The fixture mounts the workspace and installer routers but no machine
    // CRUD, so the write side is exercised through `assertVia`, the very
    // function the create and update routes call.
    assert.doesNotThrow(() => {
      assertVia(f.db, 2, 1);
      setVia(f, 2, 1);
    });
    assert.equal(
      f.db.prepare("SELECT via_machine_id as via FROM machines WHERE id = 2").get()
        .via,
      1,
    );
    // Clearing goes back to a direct connection (`0` is a value, not "leave").
    setVia(f, 2, 0);
    assert.equal(
      f.db.prepare("SELECT via_machine_id as via FROM machines WHERE id = 2").get()
        .via,
      0,
    );
    setVia(f, 2, 1);
  });

  await t.test("deleting a relay clears the machines behind it", () => {
    assert.equal(
      f.db.prepare("SELECT via_machine_id as via FROM machines WHERE id = 3").get()
        .via,
      0,
    );
    addMachine(f, 6);
    setVia(f, 3, 6);
    setVia(f, 6, 1);
    detachViaChildren(f.db, 6);
    assert.equal(
      f.db.prepare("SELECT via_machine_id as via FROM machines WHERE id = 3").get()
        .via,
      0,
    );
  });

  await t.test("the host key and the filesystem are reached over the tunnel", async () => {
    const before = f.tunnels.length;
    // The jump host itself is not trusted yet: the target may not be inspected
    // through a host whose own identity is unconfirmed.
    f.db.prepare("UPDATE machines SET ssh_host_fingerprint = '' WHERE id = 1").run();
    const untrusted = await request(
      f,
      "/api/machines/2/workspace/host-key/inspect",
      "POST",
    );
    assert.equal(untrusted.status, 409);
    assert.equal(untrusted.body.error, "via_untrusted");
    assert.equal(f.tunnels.length, before, "no tunnel is opened");

    await trust(f, 1);
    const inspected = await request(
      f,
      "/api/machines/2/workspace/host-key/inspect",
      "POST",
    );
    assert.equal(inspected.status, 200, JSON.stringify(inspected.body));
    assert.deepEqual(f.tunnels.slice(before), [`127.0.0.1:${port}`]);
    assert.equal(
      (await request(f, "/api/machines/2/workspace/host-key", "PUT", inspected.body))
        .status,
      200,
    );

    // Reading a directory goes through withFiles -> connectMachine -> tunnel.
    const products = await request(f, "/api/machines/2/workspace/products");
    assert.equal(products.status, 200, JSON.stringify(products.body));
    assert.ok(products.body.products.some((p) => p.name === "Nginx"));
    assert.equal(f.tunnels.length, before + 2);

    // Machine 1 is still direct.
    const direct = await request(f, "/api/machines/1/workspace/products");
    assert.equal(direct.status, 200);
    assert.equal(f.tunnels.length, before + 2);
  });

  await t.test("two relays are chained, not shortcut", async () => {
    setVia(f, 3, 2); // 3 -> 2 -> 1, the deepest chain the cap allows
    const before = f.tunnels.length;
    // The host key is read through both hops.
    const inspected = await request(
      f,
      "/api/machines/3/workspace/host-key/inspect",
      "POST",
    );
    assert.equal(inspected.status, 200, JSON.stringify(inspected.body));
    assert.equal(f.tunnels.length, before + 2);
    assert.equal(
      (await request(f, "/api/machines/3/workspace/host-key", "PUT", inspected.body))
        .status,
      200,
    );
    const products = await request(f, "/api/machines/3/workspace/products");
    assert.equal(products.status, 200, JSON.stringify(products.body));
    assert.equal(f.tunnels.length, before + 4);
    setVia(f, 3, 0);
  });

  await t.test("the terminal runs inside the tunnel", async () => {
    const before = f.tunnels.length;
    const ws = new WebSocket(
      f.url.replace("http", "ws") + "/ws/ssh",
      ["yaws", `bearer.${f.token}`],
      { headers: { origin: f.url } },
    );
    await new Promise((resolve, reject) => {
      ws.on("error", reject);
      ws.on("open", () =>
        ws.send(JSON.stringify({ type: "connect", machineId: 2, cols: 90, rows: 24 })),
      );
      ws.on("message", (raw) => {
        const message = JSON.parse(raw);
        if (message.type === "output") resolve();
        if (message.type === "error") reject(new Error(message.error));
      });
    });
    ws.close();
    assert.ok(f.tunnels.length > before, "the shell came through the relay");
  });

  await t.test("a relay that forbids forwarding says so", async () => {
    f.setDenyTunnels(true);
    try {
      const denied = await request(
        f,
        "/api/machines/2/workspace/host-key/inspect",
        "POST",
      );
      assert.equal(denied.status, 502);
      assert.ok(
        ["via_failed", "via_forward_denied"].includes(denied.body.error),
        `unexpected ${denied.body.error}`,
      );
    } finally {
      f.setDenyTunnels(false);
    }
    // The real OpenSSH answer to `AllowTcpForwarding no` is reason 1.
    assert.equal(
      hopErrorCode("(SSH) Channel open failure: open failed", 1),
      "via_forward_denied",
    );
    assert.equal(hopErrorCode("(SSH) Channel open failure: open failed", 2), "via_failed");
  });
});
