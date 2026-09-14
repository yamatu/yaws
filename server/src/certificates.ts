import { Router } from "express";
import { z } from "zod";
import type { Db } from "./db.js";
import type { AuthedRequest } from "./http.js";
import { connectMachine, shellQuote, sshMachine, WorkspaceError } from "./ssh.js";
import { decryptText, encryptText } from "./crypto.js";

const DEFAULT_EMAIL = "yamatu@qq.com";
const CertConfig = z.object({
  email: z.string().email().max(320).optional(),
  cfToken: z.string().max(512).optional(),
  cfAccountId: z.string().max(128).optional(),
  autoRenew: z.boolean().optional(),
  autoRenewDays: z.number().int().min(1).max(90).optional(),
});
const RenewBody = z.object({ id: z.number().int().positive() });

type ExecResult = { stdout: string; stderr: string; code: number };
function exec(client: any, command: string): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    client.exec(command, (error: Error | undefined, stream: any) => {
      if (error) return reject(error);
      let stdout = "", stderr = "";
      stream.on("data", (b: Buffer) => { stdout += b.toString(); });
      stream.stderr.on("data", (b: Buffer) => { stderr += b.toString(); });
      stream.on("close", (code: number) => resolve({ stdout, stderr, code: Number(code ?? 0) }));
    });
  });
}
function setting(db: Db, key: string) {
  return (db.prepare("SELECT value FROM settings WHERE key=?").get(key) as { value: string } | undefined)?.value ?? "";
}
function save(db: Db, key: string, value: string) {
  db.prepare(`INSERT INTO settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`).run(key, value, Date.now());
}
function del(db: Db, key: string) { db.prepare("DELETE FROM settings WHERE key=?").run(key); }
function cfg(db: Db, secret: string, env: { CERT_EMAIL?: string; CF_Token?: string; CF_Account_ID?: string }) {
  const tokenEnc = setting(db, "cert_cf_token_enc");
  return {
    email: setting(db, "cert_email") || env.CERT_EMAIL || DEFAULT_EMAIL,
    cfToken: tokenEnc ? decryptText(tokenEnc, secret) : env.CF_Token || "",
    cfAccountId: setting(db, "cert_cf_account_id") || env.CF_Account_ID || "",
    autoRenew: setting(db, "cert_auto_renew") !== "0",
    autoRenewDays: Math.max(1, Number(setting(db, "cert_auto_renew_days") || "30")),
  };
}
function machineId(req: any) {
  const id = Number(req.params.machineId);
  if (!Number.isInteger(id) || id < 1) throw new WorkspaceError(400, "bad_machine_id");
  return id;
}
function parseScan(text: string) {
  const rows: any[] = [];
  let cur: string[] | null = null;
  for (const line of text.split("\n")) {
    if (line === "__YAWS_CERT__") { cur = []; continue; }
    if (line === "__YAWS_END__" && cur) {
      const [path, end, issuer, subject, sans, keyPath] = cur;
      const domains = new Set<string>();
      const cn = subject?.match(/(?:^|,)CN=([^,]+)/)?.[1];
      if (cn) domains.add(cn.trim());
      for (const m of (sans || "").matchAll(/DNS:([^, ]+)/g)) domains.add(m[1].trim());
      const date = end?.replace(/^notAfter=/, "").trim();
      const expiresAt = Date.parse(date || "");
      if (path && domains.size) rows.push({ path, keyPath: keyPath || "", domains: [...domains], expiresAt: Number.isFinite(expiresAt) ? expiresAt : null, issuer: (issuer || "").replace(/^issuer=/, "").trim() });
      cur = null; continue;
    }
    if (cur) cur.push(line);
  }
  return rows;
}
const SCAN = `find /etc/nginx /etc/ssl /etc/letsencrypt /www/server/panel/vhost/cert /www/server/panel/vhost/ssl -type f \\( -name '*.pem' -o -name '*.cer' -o -name '*.crt' \\) -print0 2>/dev/null | while IFS= read -r -d '' f; do end=\$(openssl x509 -in "\$f" -noout -enddate 2>/dev/null | cut -d= -f2-); issuer=\$(openssl x509 -in "\$f" -noout -issuer -nameopt RFC2253 2>/dev/null); subject=\$(openssl x509 -in "\$f" -noout -subject -nameopt RFC2253 2>/dev/null); sans=\$(openssl x509 -in "\$f" -noout -ext subjectAltName 2>/dev/null | grep -o 'DNS:[^, ]*' | paste -sd, -); [ -n "\$sans" ] || continue; key=''; for k in "\${f%.*}.key" "\${f%/*}/privkey.pem" "\${f%.*}.pem"; do [ -f "\$k" ] && key="\$k" && break; done; printf '__YAWS_CERT__\\n%s\\n%s\\n%s\\n%s\\n%s\\n%s\\n__YAWS_END__\\n' "\$f" "\$end" "\$issuer" "\$subject" "\$sans" "\$key"; done`;

async function renewStoredCertificate(db: Db, secret: string, env: { CERT_EMAIL?: string; CF_Token?: string; CF_Account_ID?: string }, id: number, row: any) {
  const c = cfg(db, secret, env);
  if (!c.cfToken || !c.cfAccountId) throw new WorkspaceError(409, "cloudflare_not_configured");
  const domains: string[] = JSON.parse(row.domains || "[]");
  if (!domains.length || !row.key_path) throw new WorkspaceError(409, "certificate_key_not_found");
  const client = await connectMachine(db, id, secret);
  try {
    const args = domains.map((d) => `-d ${shellQuote(d)}`).join(" ");
    const certBackup = `${row.cert_path}.yaws-before-renew`; const keyBackup = `${row.key_path}.yaws-before-renew`;
    const command = `set -e; export CF_Token=${shellQuote(c.cfToken)} CF_Account_ID=${shellQuote(c.cfAccountId)}; ACME=\$(command -v acme.sh || true); [ -n "\$ACME" ] || [ -x "\$HOME/.acme.sh/acme.sh" ] && ACME="\${ACME:-\$HOME/.acme.sh/acme.sh}" || { echo acme.sh_not_found >&2; exit 127; }; cp -p ${shellQuote(row.cert_path)} ${shellQuote(certBackup)}; cp -p ${shellQuote(row.key_path)} ${shellQuote(keyBackup)}; restore(){ cp -p ${shellQuote(certBackup)} ${shellQuote(row.cert_path)}; cp -p ${shellQuote(keyBackup)} ${shellQuote(row.key_path)}; }; trap restore ERR; "\$ACME" --issue --dns dns_cf ${args} --accountemail ${shellQuote(c.email)}; "\$ACME" --install-cert -d ${shellQuote(domains[0])} --key-file ${shellQuote(row.key_path)} --fullchain-file ${shellQuote(row.cert_path)} --reloadcmd "true"; nginx -t; (systemctl reload nginx || nginx -s reload); trap - ERR; rm -f ${shellQuote(certBackup)} ${shellQuote(keyBackup)}`;
    const result = await exec(client, command);
    if (result.code !== 0) throw new WorkspaceError(502, `certificate_renew_failed:${(result.stderr || result.stdout).slice(-1000)}`);
    db.prepare("UPDATE certificate_inventory SET last_renew_at=?,last_error='',status='ok' WHERE id=?").run(Date.now(), row.id);
  } finally { client.end(); }
}

export function certificateRouter(db: Db, secret: string, env: { CERT_EMAIL?: string; CF_Token?: string; CF_Account_ID?: string }) {
  const router = Router();
  router.get("/config", (_req, res) => {
    const c = cfg(db, secret, env);
    res.json({ email: c.email, cfTokenMasked: c.cfToken ? `${c.cfToken.slice(0, 4)}...${c.cfToken.slice(-4)}` : "", cfAccountId: c.cfAccountId, autoRenew: c.autoRenew, autoRenewDays: c.autoRenewDays, configured: !!(c.cfToken && c.cfAccountId) });
  });
  router.put("/config", (req, res) => {
    const body = CertConfig.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: "bad_request" });
    if (body.data.email !== undefined) save(db, "cert_email", body.data.email.trim() || DEFAULT_EMAIL);
    if (body.data.cfAccountId !== undefined) body.data.cfAccountId.trim() ? save(db, "cert_cf_account_id", body.data.cfAccountId.trim()) : del(db, "cert_cf_account_id");
    if (body.data.cfToken !== undefined) body.data.cfToken.trim() ? save(db, "cert_cf_token_enc", encryptText(body.data.cfToken.trim(), secret)) : del(db, "cert_cf_token_enc");
    if (body.data.autoRenew !== undefined) save(db, "cert_auto_renew", body.data.autoRenew ? "1" : "0");
    if (body.data.autoRenewDays !== undefined) save(db, "cert_auto_renew_days", String(body.data.autoRenewDays));
    res.json({ ok: true });
  });
  router.get("/machines", (_req, res) => res.json({ machines: db.prepare("SELECT id,name,ssh_host as sshHost,ssh_user as sshUser FROM machines WHERE deleted_at IS NULL ORDER BY sort_order,id").all() }));
  router.get("/machine/:machineId", (req, res) => {
    const id = machineId(req);
    res.json({ certificates: db.prepare("SELECT id,cert_path as certPath,key_path as keyPath,domains,expires_at as expiresAt,issuer,last_scan_at as lastScanAt,last_renew_at as lastRenewAt,status,last_error as lastError FROM certificate_inventory WHERE machine_id=? ORDER BY expires_at ASC").all(id).map((r: any) => ({ ...r, domains: JSON.parse(r.domains || "[]") })) });
  });
  router.post("/machine/:machineId/scan", async (req, res, next) => {
    const id = machineId(req); let client: any;
    try {
      client = await connectMachine(db, id, secret);
      const result = await exec(client, SCAN);
      client.end();
      if (result.code !== 0 && !result.stdout) throw new WorkspaceError(502, "certificate_scan_failed");
      const rows = parseScan(result.stdout);
      const tx = db.transaction(() => {
        const up = db.prepare(`INSERT INTO certificate_inventory(machine_id,cert_path,key_path,domains,expires_at,issuer,last_scan_at,status,last_error) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(machine_id,cert_path) DO UPDATE SET key_path=excluded.key_path,domains=excluded.domains,expires_at=excluded.expires_at,issuer=excluded.issuer,last_scan_at=excluded.last_scan_at,status=excluded.status,last_error=''`);
        for (const r of rows) up.run(id, r.path, r.keyPath, JSON.stringify(r.domains), r.expiresAt, r.issuer, Date.now(), r.expiresAt && r.expiresAt < Date.now() ? "expired" : "ok", "");
      });
      tx(); res.json({ ok: true, found: rows.length, certificates: rows });
    } catch (e) { try { client?.end(); } catch {} next(e); }
  });
  router.post("/machine/:machineId/renew", async (req, res, next) => {
    const id = machineId(req); const parsed = RenewBody.safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: "bad_request" });
    const row = db.prepare("SELECT * FROM certificate_inventory WHERE id=? AND machine_id=?").get(parsed.data.id) as any;
    if (!row) return res.status(404).json({ error: "certificate_not_found" });
    try { await renewStoredCertificate(db, secret, env, id, row); res.json({ ok: true, reloaded: true }); }
    catch (e) { db.prepare("UPDATE certificate_inventory SET status='error',last_error=? WHERE id=?").run(String(e instanceof Error ? e.message : e).slice(-2000), row.id); next(e); }
  });
  return router;
}

export function startCertificateScheduler(db: Db, secret: string, env: { CERT_EMAIL?: string; CF_Token?: string; CF_Account_ID?: string }) {
  const tick = async () => {
    if (cfg(db, secret, env).autoRenew === false) return;
    const days = cfg(db, secret, env).autoRenewDays;
    const rows = db.prepare("SELECT id, machine_id as machineId, expires_at as expiresAt FROM certificate_inventory WHERE expires_at IS NOT NULL AND expires_at <= ? AND status != 'renewing'").all(Date.now() + days * 86400000) as Array<{id:number;machineId:number;expiresAt:number}>;
    for (const row of rows) {
      db.prepare("UPDATE certificate_inventory SET status='renewing' WHERE id=?").run(row.id);
      try {
        const full = db.prepare("SELECT * FROM certificate_inventory WHERE id=?").get(row.id);
        await renewStoredCertificate(db, secret, env, row.machineId, full);
        db.prepare("UPDATE certificate_inventory SET status='ok' WHERE id=?").run(row.id);
      } catch { db.prepare("UPDATE certificate_inventory SET status='error',last_error=? WHERE id=?").run("scheduled renewal pending manual confirmation", row.id); }
    }
  };
  setTimeout(() => void tick(), 30_000).unref();
  setInterval(() => void tick(), 6 * 3600_000).unref();
}
