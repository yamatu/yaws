// Certificate scan/renew API contract, including the failure modes that used to
// surface as bare 500 internal_error (ssh2 exec refusals, undecryptable
// credentials) instead of named errors the UI can explain.
import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import http from "node:http";
import { generateKeyPairSync } from "node:crypto";
import ssh2 from "ssh2";
import { openDb } from "../dist/db.js";
import { hashPassword, signToken } from "../dist/auth.js";
import { authMiddleware } from "../dist/http.js";
import { encryptText } from "../dist/crypto.js";
import { certificateRouter, startCertificateScheduler } from "../dist/certificates.js";
import { fingerprint } from "../dist/ssh.js";

const secret = "certificate-test-secret-0123456789";
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

async function startApi({ ssh, port, fp, passwordEnc = encryptText(password, secret) }) {
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
    certificateRouter(db, secret, {}));
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
