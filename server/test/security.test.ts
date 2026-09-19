import test from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.js";
import { normalizeTarget, createPingService } from "../src/ping.js";
import { pingSeries } from "../src/ping-series.js";
import { currentUser } from "../src/http.js";
import { signToken } from "../src/auth.js";
import { publicAddress, secretPath } from "../src/ai.js";
import {
  backupsToPrune,
  insideRoot,
  remotePath,
} from "../src/files.js";
import { decryptText, encryptText } from "../src/crypto.js";
import { loadEnv, parseTrustProxy } from "../src/env.js";
import { renderInstallScript } from "../src/install-script.js";
import { execFileSync } from "node:child_process";
import { computeUptimeBuckets } from "../src/uptime.js";
import { ttlKeyedStore, ttlValue } from "../src/cache.js";
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

test("the installer script shell-quotes operator controlled values", () => {
  const marker = path.join(os.tmpdir(), `yaws-pwned-${process.pid}`);
  const repo = `evil/repo"; touch ${marker}; echo "`;
  const controllerBase = 'https://panel.example.com"; rm -rf /; echo "';
  const githubBase = "https://mirror.example.com/agent/$(id)/";
  const giteeBase = "https://gitee.com/evil/$(id)";
  const target = 'v0.3.0"; id; echo "';
  const script = renderInstallScript({
    machineId: 7,
    wsUrl: "wss://panel.example.com/ws/agent",
    key: "agent-key-value",
    intervalSec: 5,
    order: ["gitee", "controller", "github"],
    githubRepo: repo,
    giteeRepo: repo,
    releaseTag: "v1.2.3",
    githubBase,
    giteeBase,
    controllerBase,
    targetVersion: target,
  });

  const names = [
    "ORDER",
    "GITHUB_REPO",
    "GITEE_REPO",
    "RELEASE_TAG",
    "GITHUB_BASE",
    "GITEE_BASE",
    "CONTROLLER_BASE",
    "TARGET_VERSION",
  ];
  const block = script.slice(script.indexOf("ORDER="), script.indexOf("# END YAWS-GENERATED"));
  const lines = block.trim().split("\n");
  assert.equal(lines.length, names.length);
  lines.forEach((line, index) => assert.ok(line.startsWith(`${names[index]}=`), line));
  // Every generated line is a single quoted assignment: nothing can escape it.
  for (const line of lines) assert.match(line, /^[A-Z_]+='[^']*'$/);

  // Evaluate the block in a real shell: the values must survive verbatim and the
  // injected command substitutions must not run.
  const evaluated = execFileSync(
    "bash",
    [
      "-c",
      `${lines.join("\n")}\nprintf '%s\\n' ${names.map((name) => `"$${name}"`).join(" ")}`,
    ],
    { encoding: "utf8", shell: false },
  );
  assert.deepEqual(evaluated.slice(0, -1).split("\n"), [
    "gitee controller github",
    repo,
    repo,
    "v1.2.3",
    githubBase.replace(/\/+$/, ""),
    giteeBase,
    controllerBase,
    target,
  ]);
  // Nothing in the block ran, and a trailing slash on a mirror URL is dropped.
  assert.ok(!fs.existsSync(marker));
  assert.ok(block.includes("https://mirror.example.com/agent/$(id)'"));
  // The config heredoc must stay quoted so no value is expanded by the shell.
  assert.ok(script.includes('cat > "$CFG" <<\'JSON\''));
});

test("stored credential envelopes must be well formed", () => {
  const secret = "unit-test-secret-value";
  const payload = encryptText("hunter2", secret);
  assert.equal(decryptText(payload, secret), "hunter2");
  assert.throws(() => decryptText("not-a-payload", secret), /bad_ciphertext/);
  assert.throws(() => decryptText("aaaa:bbbb:cccc", secret), /bad_ciphertext/);
  const [iv, tag] = payload.split(":");
  assert.throws(() => decryptText(`${iv}:${tag}`, secret), /bad_ciphertext/);
  assert.throws(
    () =>
      decryptText(
        `${Buffer.alloc(4).toString("base64")}:${tag}:AAAA`,
        secret,
      ),
    /bad_ciphertext/,
  );
  assert.throws(() => decryptText(payload, "another-secret-value"), Error);
});

test("rollback copies are pruned to the newest three per file", () => {
  const names = [
    "config.json",
    "config.json.yaws-backup-1700000000000-aaaaaaaa",
    "config.json.yaws-backup-1700000002000-cccccccc",
    "config.json.yaws-backup-1700000001000-bbbbbbbb",
    "config.json.yaws-backup-1700000003000-dddddddd",
    "other.txt.yaws-backup-1700000004000-eeeeeeee",
  ];
  assert.deepEqual(
    backupsToPrune(names, "/srv/app/config.json"),
    ["/srv/app/config.json.yaws-backup-1700000000000-aaaaaaaa"],
  );
  assert.deepEqual(backupsToPrune(names, "/srv/app/config.json", 0).length, 4);
  assert.deepEqual(backupsToPrune(names, "/srv/app/other.txt"), []);
});

test("production refuses short signing secrets", () => {
  const before = { ...process.env };
  try {
    process.env.NODE_ENV = "production";
    process.env.JWT_SECRET = "sixteen-chars-ok";
    // (the schema allows 16 characters outside production so local development stays easy)
    assert.throws(() => loadEnv(), /at least 32 characters/);
    process.env.JWT_SECRET = "a".repeat(64);
    assert.equal(loadEnv().JWT_SECRET, "a".repeat(64));
    process.env.AGENT_KEY_SECRET = "b".repeat(16);
    assert.throws(() => loadEnv(), /AGENT_KEY_SECRET must be at least 32/);
    process.env.AGENT_KEY_SECRET = "b".repeat(64);
    assert.equal(loadEnv().AGENT_KEY_SECRET, "b".repeat(64));
  } finally {
    process.env = before;
  }
});

test("TRUST_PROXY accepts hop counts and disables cleanly", () => {
  assert.equal(parseTrustProxy("1"), 1);
  assert.equal(parseTrustProxy(" 2 "), 2);
  assert.equal(parseTrustProxy("0"), false);
  assert.equal(parseTrustProxy("none"), false);
  assert.equal(parseTrustProxy("off"), false);
  assert.equal(parseTrustProxy(""), false);
  assert.equal(parseTrustProxy("loopback"), "loopback");
  assert.equal(loadEnv().TRUST_PROXY, "1");
});

test("uptime buckets only read one indexed sample per bucket", () => {
  const db = openDb(":memory:");
  try {
    db.prepare(
      "INSERT INTO machines(id,name,agent_key_hash,created_at,updated_at) VALUES (1,'one','hash',0,0)",
    ).run();
    const insert = db.prepare(
      `INSERT INTO metrics(machine_id,at,cpu_usage,mem_used,mem_total,disk_used,disk_total)
       VALUES (1,?,0,0,0,0,0)`,
    );
    const now = Date.UTC(2026, 0, 2, 12, 0, 0);
    // A sample before the window plus an irregular series inside it.
    const samples = [now - 40 * 60_000, now - 35 * 60_000, now - 33 * 60_000, now - 20 * 60_000, now - 4 * 60_000, now - 60_000];
    for (const at of samples) insert.run(at);

    // Independent reference implementation of the documented semantics.
    const reference = (hours: number, bucketMin: number, offlineAfterMin: number) => {
      const bucketMs = bucketMin * 60_000;
      const startAt = now - hours * 3600_000;
      const endAt = now;
      const count = Math.floor((endAt - startAt) / bucketMs);
      const times = samples.filter((at) => at >= startAt && at <= endAt).sort((a, b) => a - b);
      const prev = [...samples].filter((at) => at < startAt).sort((a, b) => b - a)[0];
      const seq = prev !== undefined ? [prev, ...times] : times;
      const offlineMs = offlineAfterMin * 60_000;
      let idx = 0;
      let lastAt: number | null = null;
      const states: string[] = [];
      for (let i = 0; i < count; i++) {
        const bucketEnd = startAt + (i + 1) * bucketMs;
        while (idx < seq.length && seq[idx] <= bucketEnd) lastAt = seq[idx++];
        if (lastAt == null) states.push("down");
        else if (bucketEnd - lastAt <= offlineMs) states.push("up");
        else if (bucketEnd - lastAt <= offlineMs * 3) states.push("warn");
        else states.push("down");
      }
      return states;
    };

    for (const [hours, bucketMin, offlineAfterMin] of [
      [1, 5, 5],
      [2, 10, 1],
      [3, 15, 20],
      [1, 60, 5],
    ] as const) {
      const result = computeUptimeBuckets(db, { machineId: 1, hours, bucketMin, offlineAfterMin }, now);
      assert.deepEqual(
        result.buckets.map((bucket) => bucket.state),
        reference(hours, bucketMin, offlineAfterMin),
      );
      assert.equal(result.counts.total, result.buckets.length);
    }

    // A machine without any samples stays fully down and never divides by zero.
    db.prepare(
      "INSERT INTO machines(id,name,agent_key_hash,created_at,updated_at) VALUES (2,'two','hash',0,0)",
    ).run();
    const empty = computeUptimeBuckets(db, { machineId: 2, hours: 1, bucketMin: 15, offlineAfterMin: 5 }, now);
    assert.equal(empty.counts.down, empty.counts.total);
    assert.equal(empty.upPct, 0);
  } finally {
    db.close();
  }
});

test("public endpoint caches expire and stay bounded", async () => {
  let builds = 0;
  const single = ttlValue(40, () => ++builds);
  assert.equal(single(), 1);
  assert.equal(single(), 1);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(single(), 2);

  const keyed = ttlKeyedStore<string, number>(1000, 2);
  keyed.set("a", 1);
  keyed.set("b", 2);
  assert.equal(keyed.get("a"), 1);
  keyed.set("c", 3);
  // Bounded by maxEntries with first-in-first-out eviction.
  assert.equal(keyed.get("a"), undefined);
  assert.equal(keyed.get("b"), 2);
  assert.equal(keyed.get("c"), 3);
  const expiring = ttlKeyedStore<string, number>(40, 8);
  expiring.set("k", 1);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(expiring.get("k"), undefined);
});
