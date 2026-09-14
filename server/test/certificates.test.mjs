// Certificate scan/renew API contract, including the failure modes that used to
// surface as bare 500 internal_error (ssh2 exec refusals, undecryptable
// credentials) instead of named errors the UI can explain.
import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import ssh2 from "ssh2";
import { openDb } from "../dist/db.js";
import { hashPassword, signToken } from "../dist/auth.js";
import { authMiddleware } from "../dist/http.js";
import { encryptText } from "../dist/crypto.js";
import { acmeScript, certificateRouter, startCertificateScheduler } from "../dist/certificates.js";
import { fingerprint } from "../dist/ssh.js";

const secret = "certificate-test-secret-0123456789";
const cfEnv = { CERT_EMAIL: "yamatu@qq.com", CF_Token: "cf-token-fixture", CF_Account_ID: "cf-account-fixture" };
const password = "Certificate-Test-Password";

const b64 = (s) => Buffer.from(s, "utf8").toString("base64");

// A realistic scan protocol payload with N certificates plus the info fields.
function scanOutput({ count = 2 } = {}) {
  const cert = (path, end, subject, sans, key) =>
    `__YAWS_CERT__\t${b64(path)}\t${b64(end)}\t${b64("CN=R3,O=Let's Encrypt")}\t${b64(subject)}\t${b64(sans)}\t${b64(key)}`;
  // The remote scanner strips the `notAfter=`/`subject=` prefixes with sed, so
  // these fields carry bare values just like real `openssl x509` output.
  const certs = [
    cert("/etc/nginx/ssl/a.example.com.pem", "Jan 01 00:00:00 2030 GMT", "CN=a.example.com", "DNS:a.example.com,DNS:*.a.example.com", "/etc/nginx/ssl/a.example.com.key"),
    cert("/etc/nginx/ssl/b.example.com.pem", "Jan 01 00:00:00 2020 GMT", "CN=b.example.com", "DNS:b.example.com", "/etc/nginx/ssl/b.example.com.key"),
  ].slice(0, count);
  return [
    "__YAWS_INFO__\tuser\t" + b64("fixture"),
    "__YAWS_INFO__\tuid\t" + b64("1000"),
    "__YAWS_INFO__\topenssl\t" + b64("/usr/bin/openssl"),
    "__YAWS_INFO__\tnginx\t" + b64("/usr/sbin/nginx"),
    "__YAWS_INFO__\tnginxConfig\t" + b64("active"),
    "__YAWS_INFO__\tcandidates\t" + b64("3"),
    "__YAWS_INFO__\tcertificates\t" + b64(String(count)),
    ...certs,
    "",
  ].join("\n");
}

// ssh2 server whose exec behaviour is controllable per test.
async function startSsh({ onExec }) {
  const hostKey = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  }).privateKey;
  const ssh = new ssh2.Server({ hostKeys: [hostKey] }, (client) => {
    client.on("error", () => {});
    client.on("authentication", (ctx) =>
      ctx.method === "password" && ctx.username === "fixture" && ctx.password === password ? ctx.accept() : ctx.reject(),
    );
    client.on("ready", () =>
      client.on("session", (accept) => {
        const session = accept();
        session.on("exec", (accept, reject, info) => onExec(accept, reject, info, session));
      }),
    );
  });
  await new Promise((resolve) => ssh.listen(0, "127.0.0.1", resolve));
  const port = ssh.address().port;
  const fp = await new Promise((resolve) => {
    const c = new ssh2.Client();
    c.connect({ host: "127.0.0.1", port, username: "fixture", readyTimeout: 5000, hostVerifier: (key) => { resolve(fingerprint(key)); return false; } });
    c.on("error", () => {});
  });
  return { ssh, port, fp };
}

async function startApi({ ssh, port, fp, passwordEnc = encryptText(password, secret), certEnv = {} }) {
  const db = openDb(":memory:");
  db.prepare("INSERT INTO users(id,username,password_hash,role,created_at) VALUES (1,'admin',?,'admin',0)").run(await hashPassword(password));
  db.prepare(
    `INSERT INTO machines(id,name,ssh_host,ssh_port,ssh_user,ssh_auth_type,ssh_password_enc,
     ssh_host_fingerprint,ssh_fingerprint_address,agent_key_hash,created_at,updated_at)
     VALUES (1,'cert-test','127.0.0.1',?,'fixture','password',?,?,?,?,0,0)`,
  ).run(port, passwordEnc, fp, `127.0.0.1:${port}`, "agent-key-hash");
  const token = signToken({ id: 1, username: "admin", role: "admin", version: 0 }, secret);
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use("/api/certificates", authMiddleware(secret, db), (req, res, next) =>
    req.user?.role === "admin" ? next() : res.status(403).json({ error: "forbidden" }),
    certificateRouter(db, secret, certEnv));
  // Mirror the production terminal handler: anything unnamed becomes 500.
  app.use((err, _req, res, _next) => {
    if (err?.status) return res.status(err.status).json({ error: err.message });
    res.status(500).json({ error: "internal_error" });
  });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/certificates`;
  const api = async (path, init) => {
    const res = await fetch(`${base}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, ...(init?.body ? { "content-type": "application/json" } : {}) },
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  return { db, api, close: () => { ssh.close(); server.close(); } };
}

test("scan stores certificates and reports counts; second scan updates in place", async () => {
  const { ssh, port, fp } = await startSsh({ onExec: (accept) => {
    const stream = accept();
    stream.write(scanOutput());
    stream.exit(0);
    stream.end();
  } });
  const { api, db, close } = await startApi({ ssh, port, fp });
  try {
    const first = await api("/machine/1/scan", { method: "POST", body: "{}" });
    assert.equal(first.status, 200);
    assert.equal(first.body.found, 2);
    assert.deepEqual({ added: first.body.added, updated: first.body.updated, pruned: first.body.pruned }, { added: 2, updated: 0, pruned: 0 });
    assert.equal(first.body.info.user, "fixture");
    const stored = db.prepare("SELECT cert_path, status FROM certificate_inventory ORDER BY cert_path").all();
    assert.equal(stored.length, 2);
    assert.equal(stored[0].cert_path, "/etc/nginx/ssl/a.example.com.pem");
    assert.equal(stored[0].status, "ok");
    assert.equal(stored[1].status, "expired"); // b.example.com expired 2020

    const second = await api("/machine/1/scan", { method: "POST", body: "{}" });
    assert.equal(second.status, 200);
    assert.deepEqual({ added: second.body.added, updated: second.body.updated }, { added: 0, updated: 2 });
    assert.equal(db.prepare("SELECT COUNT(*) n FROM certificate_inventory").get().n, 2);

    const summary = await api("/summary");
    assert.equal(summary.body.summary[0].machineId, 1);
    assert.equal(summary.body.summary[0].certificates, 2);
    assert.equal(summary.body.summary[0].expired, 1);
  } finally { close(); }
});

test("scan prunes inventory rows whose files disappeared, but never on an empty scan", async () => {
  // The exec handler reads the current fixture state at exec time, so flipping
  // `count` between requests emulates certificates disappearing on the server.
  const state = { count: 2 };
  const { ssh, port, fp } = await startSsh({ onExec: (accept) => {
    const stream = accept();
    stream.write(scanOutput({ count: state.count }));
    stream.exit(0);
    stream.end();
  } });
  const { api, db, close } = await startApi({ ssh, port, fp });
  try {
    await api("/machine/1/scan", { method: "POST", body: "{}" });
    assert.equal(db.prepare("SELECT COUNT(*) n FROM certificate_inventory").get().n, 2);
    // Remote no longer reports any certificate: rows must survive a 0-result
    // scan (openssl may simply be unavailable), so nothing is pruned.
    state.count = 0;
    const empty = await api("/machine/1/scan", { method: "POST", body: "{}" });
    assert.equal(empty.status, 200);
    assert.ok(empty.body.warning);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM certificate_inventory").get().n, 2);
    // Remote reports one certificate: the other, now-gone path is pruned.
    state.count = 1;
    const one = await api("/machine/1/scan", { method: "POST", body: "{}" });
    assert.equal(one.status, 200);
    assert.equal(one.body.found, 1);
    assert.equal(one.body.pruned, 1);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM certificate_inventory").get().n, 1);
  } finally { close(); }
});

test("exec channel refusal is a named 502, not internal_error", async () => {
  const { ssh, port, fp } = await startSsh({ onExec: (_accept, reject) => setTimeout(() => reject(), 20) });
  const { api, close } = await startApi({ ssh, port, fp });
  try {
    const res = await api("/machine/1/scan", { method: "POST", body: "{}" });
    assert.equal(res.status, 502);
    assert.match(res.body.error, /^ssh_exec_failed:/);
  } finally { close(); }
});

test("undecryptable SSH credentials are a named 409, not internal_error", async () => {
  const { ssh, port, fp } = await startSsh({ onExec: (accept) => { const s = accept(); s.exit(0); s.end(); } });
  const { api, close } = await startApi({ ssh, port, fp, passwordEnc: "garbage:tag:len" });
  try {
    const res = await api("/machine/1/scan", { method: "POST", body: "{}" });
    assert.equal(res.status, 409);
    assert.equal(res.body.error, "ssh_credentials_invalid");
  } finally { close(); }
});

test("untrusted fingerprint stays a named 409", async () => {
  const { ssh, port, fp } = await startSsh({ onExec: (accept) => { const s = accept(); s.exit(0); s.end(); } });
  const { api, close } = await startApi({ ssh, port, fp: "" });
  try {
    const res = await api("/machine/1/scan", { method: "POST", body: "{}" });
    assert.equal(res.status, 409);
    assert.equal(res.body.error, "ssh_host_untrusted");
  } finally { close(); }
});

test("a certificate with no SAN entries is still recorded from its subject CN", async () => {
  const output = [
    "__YAWS_INFO__\tuser\t" + b64("fixture"),
    // `openssl -ext subjectAltName` prints nothing here, so the old scanner
    // dropped the file entirely even though Nginx serves it happily.
    `__YAWS_CERT__\t${b64("/etc/nginx/ssl/legacy.pem")}\t${b64("Jan 01 00:00:00 2030 GMT")}\t${b64("CN=R3")}\t${b64("CN=legacy.example.com")}\t${b64("")}\t${b64("/etc/nginx/ssl/legacy.key")}`,
    "",
  ].join("\n");
  const { ssh, port, fp } = await startSsh({ onExec: (accept) => { const s = accept(); s.write(output); s.exit(0); s.end(); } });
  const { api, db, close } = await startApi({ ssh, port, fp });
  try {
    const res = await api("/machine/1/scan", { method: "POST", body: "{}" });
    assert.equal(res.status, 200);
    assert.equal(res.body.found, 1);
    const row = db.prepare("SELECT domains, key_path FROM certificate_inventory").get();
    assert.deepEqual(JSON.parse(row.domains), ["legacy.example.com"]);
    assert.equal(row.key_path, "/etc/nginx/ssl/legacy.key");
    // The SAN-less certificate must also survive a filter query for real domains.
    const list = await api("/machine/1");
    assert.deepEqual(list.body.certificates[0].domains, ["legacy.example.com"]);
  } finally { close(); }
});

test("a renewal interrupted by a restart is reclaimed instead of stuck renewing", async () => {
  const { ssh, port, fp } = await startSsh({ onExec: (accept) => { const s = accept(); s.exit(0); s.end(); } });
  const { db, close } = await startApi({ ssh, port, fp });
  try {
    db.prepare(
      `INSERT INTO certificate_inventory(machine_id,cert_path,key_path,domains,expires_at,issuer,last_scan_at,status)
       VALUES(1,'/etc/nginx/ssl/a.pem','/etc/nginx/ssl/a.key','["a.example.com"]',?, '',0,'renewing')`,
    ).run(Date.now() + 86400000);
    startCertificateScheduler(db, secret, {});
    const row = db.prepare("SELECT status, last_error FROM certificate_inventory").get();
    assert.equal(row.status, "error");
    assert.match(row.last_error, /interrupted/);
  } finally { close(); }
});

test("non-zero remote exit without output reports the stderr tail", async () => {
  const { ssh, port, fp } = await startSsh({ onExec: (accept) => {
    const s = accept();
    s.stderr.write("sudo: a password is required\n");
    s.exit(1);
    s.end();
  } });
  const { api, close } = await startApi({ ssh, port, fp });
  try {
    const res = await api("/machine/1/scan", { method: "POST", body: "{}" });
    assert.equal(res.status, 502);
    assert.match(res.body.error, /^certificate_scan_failed:sudo: a password is required/);
  } finally { close(); }
});

test("config endpoints tolerate a corrupt stored CF token", async () => {
  const { ssh, port, fp } = await startSsh({ onExec: (accept) => { const s = accept(); s.exit(0); s.end(); } });
  const { api, db, close } = await startApi({ ssh, port, fp });
  try {
    db.prepare("INSERT INTO settings(key,value,updated_at) VALUES('cert_cf_token_enc','bad:ciphertext',0)").run();
    const res = await api("/config");
    assert.equal(res.status, 200);
    assert.equal(res.body.configured, false); // degrades to "not configured"
  } finally { close(); }
});

test("renew without Cloudflare configured is a named 409", async () => {
  const { ssh, port, fp } = await startSsh({ onExec: (accept) => {
    const stream = accept();
    stream.write(scanOutput());
    stream.exit(0);
    stream.end();
  } });
  const { api, db, close } = await startApi({ ssh, port, fp });
  try {
    await api("/machine/1/scan", { method: "POST", body: "{}" });
    const id = db.prepare("SELECT id FROM certificate_inventory LIMIT 1").get().id;
    const res = await api("/machine/1/renew", { method: "POST", body: JSON.stringify({ id }) });
    assert.equal(res.status, 409);
    assert.equal(res.body.error, "cloudflare_not_configured");
  } finally { close(); }
});

test("/machines reports credential health so a stale secret is visible before scanning", async () => {
  const { ssh, port, fp } = await startSsh({ onExec: (accept) => { const s = accept(); s.exit(0); s.end(); } });
  const healthy = await startApi({ ssh, port, fp });
  try {
    const res = await healthy.api("/machines");
    assert.equal(res.status, 200);
    assert.equal(res.body.machines[0].credentials, "ok");
    // The sealed password must never be part of the response.
    assert.equal(JSON.stringify(res.body).includes("sshPasswordEnc"), false);
    assert.equal(JSON.stringify(res.body).includes(healthy.db.prepare("SELECT ssh_password_enc e FROM machines").get().e), false);
  } finally { healthy.close(); }

  const { ssh: ssh2server, port: port2, fp: fp2 } = await startSsh({ onExec: (accept) => { const s = accept(); s.exit(0); s.end(); } });
  // Sealed with a different AGENT_KEY_SECRET, as after a secret rotation.
  const broken = await startApi({ ssh: ssh2server, port: port2, fp: fp2, passwordEnc: encryptText(password, "another-secret-entirely") });
  try {
    const res = await broken.api("/machines");
    assert.equal(res.status, 200);
    assert.equal(res.body.machines[0].credentials, "undecryptable");
  } finally { broken.close(); }
});

test("a truncated scan record is skipped instead of failing the whole scan", async () => {
  const output = [
    // Channel closed mid-record: the marker with only two fields left.
    `__YAWS_CERT__\t${b64("/etc/nginx/ssl/cut.pem")}\t${b64("Jan 01 00:00:00 2030 GMT")}`,
    `__YAWS_CERT__\t${b64("/etc/nginx/ssl/ok.pem")}\t${b64("Jan 01 00:00:00 2030 GMT")}\t${b64("CN=R3")}\t${b64("CN=ok.example.com")}\t${b64("DNS:ok.example.com")}\t${b64("/etc/nginx/ssl/ok.key")}`,
    "__YAWS_CERT__",
    "",
  ].join("\n");
  const { ssh, port, fp } = await startSsh({ onExec: (accept) => { const s = accept(); s.write(output); s.exit(0); s.end(); } });
  const { api, close } = await startApi({ ssh, port, fp });
  try {
    const res = await api("/machine/1/scan", { method: "POST", body: "{}" });
    assert.equal(res.status, 200);
    assert.equal(res.body.found, 1);
    assert.deepEqual(res.body.certificates[0].domains, ["ok.example.com"]);
  } finally { close(); }
});

test("an unexpected exception names itself instead of returning internal_error", async () => {
  const { ssh, port, fp } = await startSsh({ onExec: (accept) => {
    const stream = accept();
    stream.write(scanOutput());
    stream.exit(0);
    stream.end();
  } });
  const { api, db, close } = await startApi({ ssh, port, fp });
  try {
    // Any non-WorkspaceError used to reach the terminal handler as a bare 500
    // internal_error, which hid the cause from the operator entirely.
    db.exec("DROP TABLE certificate_inventory");
    const res = await api("/machine/1/scan", { method: "POST", body: "{}" });
    assert.equal(res.status, 500);
    assert.match(res.body.error, /^certificate_scan_failed:/);
    assert.match(res.body.error, /no such table/i);
    assert.notEqual(res.body.error, "internal_error");
  } finally { close(); }
});

// The renewal/issue script is executed by the remote login shell, which on
// Debian/Ubuntu and Alpine is dash or busybox ash. `trap ... ERR` is a bash
// extension there and aborts the script with "trap: ERR: bad trap" before
// acme.sh ever runs, so every step must check its own status instead.
function assertPortableScript(command) {
  assert.doesNotMatch(command, /trap\s+[^;]*\bERR\b/, "script must not use a bash-only ERR trap");
  assert.doesNotMatch(command, /\bset -e\b/, "script must not rely on set -e");
  assert.match(command, /\|\| fail 1 /, "each step must report its own failure");
}

test("the renewal script is portable under a POSIX shell and has no bad trap", async (t) => {
  const commands = [];
  const { ssh, port, fp } = await startSsh({
    onExec: (accept, _reject, info) => {
      commands.push(info.command);
      const stream = accept();
      stream.write(scanOutput());
      stream.exit(0);
      stream.end();
    },
  });
  const { api, db, close } = await startApi({ ssh, port, fp, certEnv: cfEnv });
  try {
    await api("/machine/1/scan", { method: "POST", body: "{}" });
    const id = db.prepare("SELECT id FROM certificate_inventory LIMIT 1").get().id;
    const res = await api("/machine/1/renew", { method: "POST", body: JSON.stringify({ id }) });
    assert.equal(res.status, 200);
    const issue = commands.find((c) => c.includes("--issue"));
    assert.ok(issue, "the renewal must actually invoke acme.sh");
    // This is the exact failure the operator hit: "证书续期失败（trap: ERR: bad trap）".
    assert.doesNotMatch(issue, /bad trap/);
    assertPortableScript(issue);
    assert.match(issue, /restore\(\)\{/);
    assert.match(issue, /fail\(\)\{ rc=\$1; shift; restore/);
  } finally { close(); }

  // Run the very script we ship through a real dash/ash. `trap x ERR` there dies
  // with "bad trap" before acme.sh runs; that is what broke every renewal.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yaws-acme-")).split("\\").join("/");
  try {
    const cert = `${dir}/a.pem`;
    const key = `${dir}/a.key`;
    fs.writeFileSync(cert, "ORIGINAL-CERT");
    fs.writeFileSync(key, "ORIGINAL-KEY");
    const bin = `${dir}/bin`;
    fs.mkdirSync(bin);
    const marker = `${dir}/ran`;
    // acme.sh stub: clobbers the installed pair, then fails the way a DNS-01
    // validation error does. The original files must come back afterwards.
    fs.writeFileSync(`${bin}/acme.sh`, `#!/bin/sh
: > '${marker}'
printf CLOBBERED > '${cert}'
printf CLOBBERED > '${key}'
exit 1
`);
    fs.chmodSync(`${bin}/acme.sh`, 0o755);
    const script = acmeScript({ domains: ["a.example.com"], certPath: cert, keyPath: key, email: "yamatu@qq.com", force: true, reload: true });

    const parsed = spawnSync("dash", ["-n"], { input: script, encoding: "utf8" });
    if (parsed.error?.code === "ENOENT") return t.skip("dash not installed");
    assert.equal(parsed.status, 0, `script must parse under dash: ${parsed.stderr}`);

    // The old implementation, for contrast: this is the reported error verbatim.
    const broken = spawnSync("dash", [], { input: ["restore(){ :; }", "trap restore ERR", "echo reached", ""].join(String.fromCharCode(10)), encoding: "utf8" });
    assert.match(broken.stderr, /bad trap/);

    const run = spawnSync("dash", [], {
      input: script,
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CF_Token: "token", CF_Account_ID: "account" },
    });
    assert.ok(fs.existsSync(marker), `the acme.sh stub never ran: ${run.stderr}`);
    assert.notEqual(run.status, 0, "a failed issuance must fail");
    assert.doesNotMatch(run.stderr, /bad trap/);
    assert.match(run.stderr, /acme_issue_failed/);
    assert.equal(fs.readFileSync(cert, "utf8"), "ORIGINAL-CERT", "the previous certificate must be restored");
    assert.equal(fs.readFileSync(key, "utf8"), "ORIGINAL-KEY", "the previous key must be restored");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("manual issuance installs to the given paths and records the certificate", async () => {
  const commands = [];
  const { ssh, port, fp } = await startSsh({
    onExec: (accept, _reject, info) => {
      commands.push(info.command);
      const stream = accept();
      if (info.command.includes("openssl x509")) {
        // Post-issue probe: report what acme.sh actually wrote.
        stream.write([
          "notAfter=Jan 01 00:00:00 2030 GMT",
          "issuer=CN=R3,O=Let's Encrypt",
          "subject=CN=shop.example.com",
          "X509v3 Subject Alternative Name:",
          "    DNS:shop.example.com, DNS:www.shop.example.com",
          "",
        ].join("\n"));
      }
      stream.exit(0);
      stream.end();
    },
  });
  const { api, db, close } = await startApi({ ssh, port, fp, certEnv: cfEnv });
  try {
    const res = await api("/machine/1/issue", {
      method: "POST",
      body: JSON.stringify({ domains: ["shop.example.com", "www.shop.example.com"], certPath: "/etc/nginx/ssl/shop.pem", keyPath: "/etc/nginx/ssl/shop.key" }),
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.certPath, "/etc/nginx/ssl/shop.pem");
    assert.equal(res.body.reloaded, true);
    assert.deepEqual(res.body.domains, ["shop.example.com", "www.shop.example.com"]);

    const issue = commands.find((c) => c.includes("--issue"));
    assertPortableScript(issue);
    // The script is nested inside `sh -c '...'`, so match the payload not the quoting.
    assert.match(issue, /--issue --dns dns_cf/);
    assert.match(issue, /shop\.example\.com/);
    assert.match(issue, /www\.shop\.example\.com/);
    assert.match(issue, /--accountemail/);
    assert.match(issue, /yamatu@qq\.com/);
    assert.match(issue, /--force/);
    assert.match(issue, /--fullchain-file "\$CERT"/);
    assert.match(issue, /nginx -t \|\| fail 1 nginx_config_test_failed/);
    assert.match(issue, /CF_Token=/);

    // The issued certificate lands in the inventory so it also auto-renews.
    const row = db.prepare("SELECT cert_path, key_path, domains, expires_at, status FROM certificate_inventory WHERE machine_id=1").get();
    assert.equal(row.cert_path, "/etc/nginx/ssl/shop.pem");
    assert.equal(row.key_path, "/etc/nginx/ssl/shop.key");
    assert.deepEqual(JSON.parse(row.domains), ["shop.example.com", "www.shop.example.com"]);
    assert.equal(row.expires_at, Date.parse("Jan 01 00:00:00 2030 GMT"));
    assert.equal(row.status, "ok");

    const list = await api("/machine/1");
    assert.equal(list.body.certificates.length, 1);
    assert.deepEqual(list.body.certificates[0].domains, ["shop.example.com", "www.shop.example.com"]);
  } finally { close(); }
});

test("manual issuance defaults the path to /etc/nginx/ssl and skips nginx when reload is off", async () => {
  const commands = [];
  const { ssh, port, fp } = await startSsh({
    onExec: (accept, _reject, info) => {
      commands.push(info.command);
      const stream = accept();
      if (info.command.includes("openssl x509")) stream.write("subject=CN=*.wild.example.com\nnotAfter=Jan 01 00:00:00 2030 GMT\n");
      stream.exit(0);
      stream.end();
    },
  });
  const { api, close } = await startApi({ ssh, port, fp, certEnv: cfEnv });
  try {
    const res = await api("/machine/1/issue", { method: "POST", body: JSON.stringify({ domains: ["*.wild.example.com"], reload: false }) });
    assert.equal(res.status, 200);
    assert.equal(res.body.certPath, "/etc/nginx/ssl/wild.example.com.pem");
    assert.equal(res.body.keyPath, "/etc/nginx/ssl/wild.example.com.key");
    assert.equal(res.body.reloaded, false);
    const issue = commands.find((c) => c.includes("--issue"));
    assert.doesNotMatch(issue, /nginx -t/);
    assert.doesNotMatch(issue, /systemctl reload nginx/);
  } finally { close(); }
});

test("manual issuance rejects bad domains, identical paths and missing Cloudflare config", async () => {
  const { ssh, port, fp } = await startSsh({ onExec: (accept) => { const s = accept(); s.exit(0); s.end(); } });
  const { api, close } = await startApi({ ssh, port, fp });
  try {
    // A shell metacharacter in a domain must never reach the remote command.
    const bad = await api("/machine/1/issue", { method: "POST", body: JSON.stringify({ domains: ["good.example.com; rm -rf /"] }) });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /^bad_domain:/);

    const empty = await api("/machine/1/issue", { method: "POST", body: JSON.stringify({ domains: [] }) });
    assert.equal(empty.status, 400);

    const same = await api("/machine/1/issue", { method: "POST", body: JSON.stringify({ domains: ["a.example.com"], certPath: "/etc/nginx/ssl/x.pem", keyPath: "/etc/nginx/ssl/x.pem" }) });
    assert.equal(same.status, 400);
    assert.equal(same.body.error, "cert_and_key_same_path");

    const relative = await api("/machine/1/issue", { method: "POST", body: JSON.stringify({ domains: ["a.example.com"], certPath: "relative.pem" }) });
    assert.equal(relative.status, 400);
    assert.equal(relative.body.error, "bad_cert_path");

    const noCf = await api("/machine/1/issue", { method: "POST", body: JSON.stringify({ domains: ["a.example.com"] }) });
    assert.equal(noCf.status, 409);
    assert.equal(noCf.body.error, "cloudflare_not_configured");
  } finally { close(); }
});

// The complaint that started this: "证书续期失败（main: _acme-challenge.www...）"
// — a DNS-01 failure whose real cause (the Cloudflare API response) never
// reached the operator, because only the last 1000 chars of remote output were
// kept and acme.sh hides the API response behind --debug.
test("a failing DNS challenge reports the acme.sh/Cloudflare cause, not a truncated tail", async () => {
  const token = "CfApiToken0123456789abcdefghijklmnopqrstuv";
  const acmeOutput = [
    `[Mon Sep 14 04:28:41 AM BST 2026] Using CA: https://acme-v02.api.letsencrypt.org/directory`,
    `[Mon Sep 14 04:28:41 AM BST 2026] Single domain='www.kindanddivine.com'`,
    `[Mon Sep 14 04:28:42 AM BST 2026] response='{"success":false,"errors":[{"code":9109,"message":"Invalid access token"}]}'`,
    `[Mon Sep 14 04:28:42 AM BST 2026] Error add txt for domain:_acme-challenge.www.kindanddivine.com`,
    `[Mon Sep 14 04:28:42 AM BST 2026] Please add '--debug' or '--log' to see more information.`,
    `[Mon Sep 14 04:28:42 AM BST 2026] See: https://github.com/acmesh-official/acme.sh/wiki/How-to-debug-acme.sh`,
    ...Array.from({ length: 60 }, (_, i) => `[Mon Sep 14 04:28:43 AM BST 2026] padding line ${i} bearer ${token}`),
    "acme_issue_failed",
  ].join("\n");
  const commands = [];
  const { ssh, port, fp } = await startSsh({
    onExec: (accept, _reject, info) => {
      commands.push(info.command);
      const stream = accept();
      stream.write(acmeOutput);
      stream.stderr.write(acmeOutput);
      stream.exit(1);
      stream.end();
    },
  });
  const { api, close } = await startApi({ ssh, port, fp, certEnv: { ...cfEnv, CF_Token: token } });
  try {
    const res = await api("/machine/1/issue", { method: "POST", body: JSON.stringify({ domains: ["www.kindanddivine.com"] }) });
    assert.equal(res.status, 502);
    const command = commands.find((c) => c.includes("--issue"));
    // The Cloudflare API error must survive...
    assert.match(res.body.error, /9109|Invalid access token/);
    assert.match(res.body.error, /Error add txt for domain:_acme-challenge\.www\.kindanddivine\.com/);
    // ...the useless hint must not...
    assert.doesNotMatch(res.body.error, /How-to-debug/);
    // ...and the token must never appear in the message or the database.
    assert.doesNotMatch(res.body.error, /CfApiToken0123456789/);
    // --debug 2 is what makes dns_cf print "response=...", and the CA is explicit.
    assert.match(command, /--debug 2 --issue --dns dns_cf/);
    assert.match(command, /--server/);
    assert.match(command, /letsencrypt/);
  } finally { close(); }
});

test("the server's own acme.sh credentials can be used instead of the stored token", async () => {
  const commands = [];
  const { ssh, port, fp } = await startSsh({
    onExec: (accept, _reject, info) => {
      commands.push(info.command);
      const stream = accept();
      if (info.command.includes("openssl x509")) stream.write("subject=CN=mail.vcocncspare.com\nnotAfter=Jan 01 00:00:00 2030 GMT\n");
      stream.exit(0);
      stream.end();
    },
  });
  // No CF_Token anywhere: this is the "I renew by hand with ./acme.sh" setup.
  const { api, close, db } = await startApi({ ssh, port, fp, certEnv: {} });
  try {
    const off = await api("/machine/1/issue", { method: "POST", body: JSON.stringify({ domains: ["mail.vcocncspare.com"] }) });
    assert.equal(off.status, 409);
    assert.equal(off.body.error, "cloudflare_not_configured");

    const saved = await api("/config", { method: "PUT", body: JSON.stringify({ useServerCreds: true }) });
    assert.equal(saved.status, 200);
    const conf = await api("/config");
    assert.equal(conf.body.useServerCreds, true);
    assert.equal(conf.body.configured, true);

    const res = await api("/machine/1/issue", { method: "POST", body: JSON.stringify({ domains: ["mail.vcocncspare.com"] }) });
    assert.equal(res.status, 200);
    const command = commands.find((c) => c.includes("--issue"));
    assert.match(command, /--issue --dns dns_cf/);
    // acme.sh must fall back to ~/.acme.sh/account.conf, so no CF_* may be passed.
    assert.doesNotMatch(command, /CF_Token=|CF_Account_ID=|CF_Key=|CF_Email=/);
    // ...and no empty assignment either, which would blank out its saved config.
    assert.match(command, /then sh -c /);
    // The token/Global-Key fields stay empty while this mode is on.
    const conf2 = await api("/config");
    assert.equal(conf2.body.cfTokenMasked, "");
    assert.doesNotMatch(JSON.stringify(conf2.body), /cf-token-fixture/);
    assert.ok(db.prepare("SELECT 1 FROM certificate_inventory WHERE machine_id=1").get());
  } finally { close(); }
});

test("a stored Global API Key and a custom CA server are used as configured", async () => {
  const commands = [];
  const { ssh, port, fp } = await startSsh({
    onExec: (accept, _reject, info) => {
      commands.push(info.command);
      const stream = accept();
      if (info.command.includes("openssl x509")) stream.write("subject=CN=a.example.com\nnotAfter=Jan 01 00:00:00 2030 GMT\n");
      stream.exit(0);
      stream.end();
    },
  });
  const { api, close } = await startApi({ ssh, port, fp, certEnv: {} });
  try {
    const cfgRes = await api("/config", { method: "PUT", body: JSON.stringify({ cfKey: "0123456789abcdef0123456789abcdef01234", cfEmail: "ops@example.com", caServer: "zerossl" }) });
    assert.equal(cfgRes.status, 200);
    const conf = await api("/config");
    assert.equal(conf.body.configured, true);
    assert.equal(conf.body.caServer, "zerossl");
    assert.match(conf.body.cfKeyMasked, /^0123\.\.\./);
    // The key itself must never come back out.
    assert.doesNotMatch(JSON.stringify(conf.body), /0123456789abcdef0123456789abcdef01234/);

    const res = await api("/machine/1/issue", { method: "POST", body: JSON.stringify({ domains: ["a.example.com"] }) });
    assert.equal(res.status, 200);
    const command = commands.find((c) => c.includes("--issue"));
    assert.match(command, /CF_Key=/);
    assert.match(command, /CF_Email=/);
    assert.match(command, /--server/);
    assert.match(command, /zerossl/);
    assert.doesNotMatch(command, /CF_Token=/);
  } finally { close(); }
});
