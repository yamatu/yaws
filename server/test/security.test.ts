import test from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.js";
import { normalizeTarget, createPingService } from "../src/ping.js";
import { pingSeries } from "../src/ping-series.js";
import { currentUser } from "../src/http.js";
import { signToken } from "../src/auth.js";
import { publicAddress, secretPath } from "../src/ai.js";
import { remotePath, insideRoot } from "../src/files.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

test("ping target validation cannot produce command arguments", () => {
  for (const value of [
    "--help",
    "a;id",
    "a b",
    "http://google.com",
    "1.2.3.999",
    "a/../../b",
  ])
    assert.equal(normalizeTarget(value), null, value);
  assert.equal(normalizeTarget("Google.COM."), "google.com");
  assert.equal(normalizeTarget("2001:4860:4860::8888"), "2001:4860:4860::8888");
});

test("time-range aggregation keeps peaks, counts actual loss and excludes unavailable probes", () => {
  const db = openDb(":memory:");
  try {
    db.prepare(
      "INSERT INTO ping_monitors(id,machine_id,target,created_at) VALUES (1,1,'google.com',0),(2,2,'google.com',0)",
    ).run();
    const now = Date.now(),
      start = now - 86400000;
    const insert = db.prepare(
      "INSERT INTO ping_samples(monitor_id,at,latency_ms,error) VALUES (?,?,?,?)",
    );
    db.transaction(() => {
      for (let i = 0; i < 17280; i++)
        insert.run(
          1,
          start + i * 5000,
          i === 100 ? 700 : i === 101 || i === 102 ? null : 20,
          i === 101
            ? "timeout_or_unreachable"
            : i === 102
              ? "agent_offline"
              : null,
        );
      insert.run(1, start - 1, 99999, null);
      insert.run(2, now, 8888, null);
    })();
    const series = pingSeries(db, 1, 1440, 5, now);
    assert.ok(series.points.length <= 241);
    assert.equal(series.summary.maxMs, 700);
    assert.equal(series.summary.count, 17280);
    assert.equal(series.summary.lost, 1);
    assert.equal(series.summary.unavailable, 1);
    assert.equal(series.summary.lossPct, 100 / 17279);
    const short = pingSeries(db, 1, 5, 5, now);
    assert.equal(short.summary.maxMs, 20);
    assert.equal(short.summary.count, 60);
    assert.equal(short.summary.jitterMs, 0);
    const empty = pingSeries(db, 404, 5, 5, now);
    assert.equal(empty.summary.lossPct, null);
    assert.equal(empty.summary.avgMs, null);
  } finally {
    db.close();
  }
});
test("session version and current role are checked", () => {
  const db = openDb(":memory:");
  db.prepare(
    "INSERT INTO users(username,password_hash,role,created_at) VALUES ('a','hash','admin',0)",
  ).run();
  const token = signToken(
    { id: 1, username: "a", role: "admin", version: 0 },
    "test-secret-123456789",
  );
  assert.equal(currentUser(db, token, "test-secret-123456789").role, "admin");
  db.prepare("UPDATE users SET role='viewer'").run();
  assert.equal(currentUser(db, token, "test-secret-123456789").role, "viewer");
  db.prepare("UPDATE users SET auth_version=1").run();
  assert.throws(() => currentUser(db, token, "test-secret-123456789"));
  db.close();
});
test("AI endpoints and workspace paths reject private or escaped targets", () => {
  for (const ip of [
    "127.0.0.1",
    "10.1.1.1",
    "169.254.169.254",
    "::1",
    "::ffff:127.0.0.1",
    "fd00::1",
  ])
    assert.equal(publicAddress(ip), false, ip);
  assert.equal(publicAddress("8.8.8.8"), true);
  assert.equal(insideRoot("/var/www", "/var/www-other/conf"), false);
  assert.equal(
    insideRoot("/var/www", remotePath("/var/www/../../etc/passwd")),
    false,
  );
  assert.throws(() => remotePath("/tmp/a\0"));
  for (const file of [
    "/root/.ssh/id_ed25519",
    "/srv/app/.env",
    "/etc/ssl/private.key",
  ])
    assert.equal(secretPath(file), true);
});
test("monitor scheduler passes exact machine ID and pauses cleanly", async () => {
  const db = openDb(":memory:");
  db.prepare(
    "INSERT INTO machines(id,name,agent_key_hash,created_at,updated_at) VALUES (1,'one','hash',0,0),(2,'two','hash2',0,0)",
  ).run();
  db.prepare(
    "INSERT INTO ping_monitors(machine_id,target,created_at) VALUES (2,'google.com',0)",
  ).run();
  const calls: number[] = [];
  const service = createPingService(
    db,
    () => true,
    async (machineId) => {
      calls.push(machineId);
      return { at: Date.now(), latencyMs: 19, error: null };
    },
  );
  service.tick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, [2]);
  assert.equal(
    (
      db.prepare("SELECT latency_ms as latency FROM ping_samples").get() as {
        latency: number;
      }
    ).latency,
    19,
  );
  service.stop();
  db.close();
});
test("legacy controller monitors migrate without becoming machine measurements", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yaws-migration-"));
  const file = path.join(dir, "old.sqlite");
  const old = new Database(file);
  old.exec(`CREATE TABLE ping_monitors (id INTEGER PRIMARY KEY, target TEXT NOT NULL UNIQUE, interval_sec INTEGER NOT NULL, enabled INTEGER NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE ping_samples (id INTEGER PRIMARY KEY, monitor_id INTEGER NOT NULL REFERENCES ping_monitors(id) ON DELETE CASCADE, at INTEGER NOT NULL, latency_ms REAL, error TEXT);
    INSERT INTO ping_monitors VALUES (1,'google.com',5,1,0); INSERT INTO ping_samples VALUES (1,1,1,12,NULL);`);
  old.close();
  const migrated = openDb(file);
  try {
    const monitor = migrated
      .prepare("SELECT machine_id,enabled FROM ping_monitors")
      .get();
    assert.deepEqual(monitor, { machine_id: null, enabled: 0 });
    assert.equal(
      (
        migrated.prepare("SELECT COUNT(*) n FROM ping_samples").get() as {
          n: number;
        }
      ).n,
      1,
    );
    assert.deepEqual(migrated.pragma("foreign_key_check"), []);
  } finally {
    migrated.close();
    fs.rmSync(dir, { recursive: true });
  }
});
