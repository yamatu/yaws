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
// timeoutMs > 0 guards against remote shells that never close the exec channel
// (network black holes, hung sudo prompts); 0 means wait indefinitely, which the
// renewal flow relies on because acme.sh DNS validation can take minutes.
function exec(client: any, command: string, timeoutMs = 0): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const done = (error?: unknown, result?: ExecResult) => {
      if (timer) clearTimeout(timer);
      if (error) reject(error); else resolve(result!);
    };
    const timer = timeoutMs > 0
      ? setTimeout(() => done(new WorkspaceError(504, "ssh_exec_timeout")), timeoutMs)
      : null;
    client.exec(command, (error: Error | undefined, stream: any) => {
      if (error) {
        // Channel-level refusals (restricted shells, MaxSessions, sftp-only
        // servers) surface here as plain ssh2 errors.
        return done(new WorkspaceError(502, `ssh_exec_failed:${String(error.message || "exec rejected").slice(-300)}`));
      }
      let stdout = "", stderr = "";
      stream.on("data", (b: Buffer) => { stdout += b.toString(); });
      stream.stderr.on("data", (b: Buffer) => { stderr += b.toString(); });
      stream.on("error", (e: Error) => done(new WorkspaceError(502, `ssh_exec_failed:${String(e.message || "stream error").slice(-300)}`)));
      stream.on("close", (code: number) => done(undefined, { stdout, stderr, code: Number(code ?? 0) }));
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
    cfToken: tokenEnc ? tryDecrypt(tokenEnc, secret) || env.CF_Token || "" : env.CF_Token || "",
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
// A stored secret that no longer decrypts (rotated server secret, damaged row)
// degrades to "not configured" so the page keeps loading; the user re-enters it.
function tryDecrypt(value: string, secret: string) {
  try { return decryptText(value, secret); } catch { return ""; }
}
function decodeRemoteField(value: string) {
  try { return Buffer.from(value, "base64").toString("utf8"); } catch { return ""; }
}

function parseScan(text: string) {
  const rows: any[] = [];
  const info: Record<string, string> = {};
  for (const line of text.split("\n")) {
    if (line.startsWith("__YAWS_INFO__\t")) {
      const [, key, value] = line.trim().split("\t");
      if (key) info[key] = decodeRemoteField(value ?? "");
      continue;
    }
    if (!line.startsWith("__YAWS_CERT__\t")) continue;
    const [, ...fields] = line.trim().split("\t");
    const [path, end, issuer, subject, sans, keyPath] = fields.map(decodeRemoteField);
    const domains = new Set<string>();
    // The scanner emits "subject=<RFC2253>", so the prefix must go before the
    // CN search; without this a SAN-less certificate was silently dropped.
    const cn = subject.replace(/^subject=/, "").match(/(?:^|,)CN=([^,]+)/)?.[1];
    if (cn) domains.add(cn.trim());
    for (const m of sans.matchAll(/DNS:([^,\s]+)/g)) domains.add(m[1].trim());
    const expiresAt = Date.parse(end.replace(/^notAfter=/, "").trim());
    if (path && domains.size) rows.push({ path, keyPath, domains: [...domains], expiresAt: Number.isFinite(expiresAt) ? expiresAt : null, issuer: issuer.replace(/^issuer=/, "").trim() });
  }
  return { rows, info };
}

// Do not rely only on a few directories: many panels store certificates in a
// custom path and nginx often points directly to that path. The script first
// reads nginx's active configuration, then searches common panel/system paths.
// Every field is base64 encoded so paths and OpenSSL output cannot break the
// protocol between the remote shell and the controller.
const SCAN_SCRIPT = `
set +e
if [ "$(id -u 2>/dev/null)" = "0" ]; then RUN_ROOT=""; elif command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then RUN_ROOT="sudo -n"; else RUN_ROOT=""; fi
run() { if [ -n "$RUN_ROOT" ]; then sudo -n "$@"; else "$@"; fi; }
b64() { if command -v base64 >/dev/null 2>&1; then printf '%s' "$1" | base64 2>/dev/null | tr -d '\\r\\n'; else printf '%s' "$1" | openssl base64 -A 2>/dev/null; fi; }
info() { printf '__YAWS_INFO__\\t%s\\t%s\\n' "$1" "$(b64 "$2")"; }
list=$(mktemp "\${TMPDIR:-/tmp}/yaws-cert.XXXXXX" 2>/dev/null)
[ -n "$list" ] || list="/tmp/yaws-cert.$$"
trap 'rm -f "$list"' EXIT
: > "$list"

info user "$(id -un 2>/dev/null)"
info uid "$(id -u 2>/dev/null)"
info openssl "$(command -v openssl 2>/dev/null || true)"
info nginx "$(command -v nginx 2>/dev/null || true)"
info sudo "$(command -v sudo 2>/dev/null || true)"

# nginx -T is the authoritative source: it catches custom certificate paths.
if command -v nginx >/dev/null 2>&1; then
  nginxDump=$(run nginx -T 2>/dev/null)
  if [ -n "$nginxDump" ]; then
    info nginxConfig "active"
    printf '%s\\n' "$nginxDump" | awk '$1 == "ssl_certificate" || $1 == "ssl_certificate_key" { gsub(";", "", $2); gsub("\\\"", "", $2); print $2 }' >> "$list"
  else
    info nginxConfig "unreadable"
  fi
else
  info nginxConfig "not-found"
fi

# Also inspect config files directly. This works when nginx -T is blocked or
# nginx is not in PATH but its config is still present.
for conf in /etc/nginx/nginx.conf /etc/nginx/conf.d/*.conf /etc/nginx/sites-enabled/* /usr/local/nginx/conf/*.conf /www/server/panel/vhost/nginx/*.conf /www/server/panel/vhost/nginx/*/*.conf /www/server/panel/vhost/apache/*.conf /www/server/panel/vhost/apache/*/*.conf; do
  [ -f "$conf" ] || continue
  grep -hE '^[[:space:]]*ssl_certificate(_key)?[[:space:]]+' "$conf" 2>/dev/null | awk '{ gsub(";", "", $2); gsub("\\\"", "", $2); print $2 }' >> "$list"
done

for dir in /etc/nginx /etc/ssl /etc/pki /etc/letsencrypt /etc/apache2 /etc/httpd /usr/local/nginx /usr/local/openresty /usr/local/lsws /usr/share/nginx /www/server/panel/vhost/cert /www/server/panel/vhost/ssl /www/server/panel/vhost/letsencrypt /www/server/panel/ssl /opt/1panel /opt/cert /root/.acme.sh /home; do
  [ -d "$dir" ] || continue
  run find "$dir" -xdev -type f \\( -iname '*.pem' -o -iname '*.crt' -o -iname '*.cer' \\) -print 2>/dev/null >> "$list"
done

certCount=0
skipped=0
while IFS= read -r f; do
  [ -f "$f" ] || continue
  # Trust-store bundles are not site certificates; skip them by name before the
  # (slower) openssl calls.
  case "$(basename "$f")" in ca-certificates.crt|ca-certificates.pem|ca-bundle.crt|ca-bundle.pem|tls-ca-bundle.pem) skipped=$((skipped + 1)); continue;; esac
  meta=$(run openssl x509 -in "$f" -noout -enddate -issuer -subject -nameopt RFC2253 -ext subjectAltName 2>/dev/null)
  [ -n "$meta" ] || continue
  end=$(printf '%s\\n' "$meta" | sed -n 's/^notAfter=//p' | head -1)
  issuer=$(printf '%s\\n' "$meta" | sed -n 's/^issuer=//p' | head -1)
  subject=$(printf '%s\\n' "$meta" | sed -n 's/^subject=//p' | head -1)
  # A certificate without SAN entries is still valid for Nginx; the controller
  # falls back to the subject CN, so do not drop it here.
  sans=$(printf '%s\\n' "$meta" | grep -o 'DNS:[^, ]*' | paste -sd, -)
  # A CA certificate with no DNS name is a trust anchor, not something Nginx
  # serves. Probed separately so an openssl without -ext support degrades to
  # "no filtering" instead of dropping every certificate.
  if [ -z "$sans" ]; then
    ca=$(run openssl x509 -in "$f" -noout -ext basicConstraints 2>/dev/null | grep -c 'CA:TRUE' || true)
    if [ "$ca" != "0" ] && [ -n "$ca" ]; then skipped=$((skipped + 1)); continue; fi
  fi
  key=""
  for k in "$(dirname "$f")/privkey.pem" "$(dirname "$f")/key.pem" "\${f%.*}.key" "\${f%.*}.pem"; do
    # The ".pem" fallback resolves to the certificate itself for a .pem file;
    # never treat a certificate as its own private key.
    [ "$k" = "$f" ] && continue
    run test -f "$k" >/dev/null 2>&1 && key="$k" && break
  done
  printf '__YAWS_CERT__\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' "$(b64 "$f")" "$(b64 "$end")" "$(b64 "$issuer")" "$(b64 "$subject")" "$(b64 "$sans")" "$(b64 "$key")"
  certCount=$((certCount + 1))
done <<EOF
$(sort -u "$list")
EOF
info candidates "$(wc -l < "$list" 2>/dev/null | tr -d ' ' )"
info certificates "$certCount"
info skipped "$skipped"
`;
const SCAN = `sh -c ${shellQuote(SCAN_SCRIPT)}`;

async function renewStoredCertificate(db: Db, secret: string, env: { CERT_EMAIL?: string; CF_Token?: string; CF_Account_ID?: string }, id: number, row: any) {
  const c = cfg(db, secret, env);
  if (!c.cfToken || !c.cfAccountId) throw new WorkspaceError(409, "cloudflare_not_configured");
  const domains: string[] = JSON.parse(row.domains || "[]");
  if (!domains.length || !row.key_path) throw new WorkspaceError(409, "certificate_key_not_found");
  const client = await connectMachine(db, id, secret);
  try {
    const args = domains.map((d) => `-d ${shellQuote(d)}`).join(" ");
    const certBackup = `${row.cert_path}.yaws-before-renew`; const keyBackup = `${row.key_path}.yaws-before-renew`;
    // The remote script runs as root, or through `sudo -n` when the SSH user is
    // not root but has passwordless sudo (the usual way to reach /etc/nginx).
    // The original pair is kept in an ERR trap so a failing `nginx -t` never
    // leaves Nginx pointing at a broken certificate.
    const script = [
      "set -e",
      `cp -p ${shellQuote(row.cert_path)} ${shellQuote(certBackup)}`,
      `cp -p ${shellQuote(row.key_path)} ${shellQuote(keyBackup)}`,
      `restore(){ cp -p ${shellQuote(certBackup)} ${shellQuote(row.cert_path)}; cp -p ${shellQuote(keyBackup)} ${shellQuote(row.key_path)}; }`,
      "trap restore ERR",
      'ACME=""; for c in "$(command -v acme.sh 2>/dev/null)" "$HOME/.acme.sh/acme.sh" /root/.acme.sh/acme.sh; do if [ -n "$c" ] && [ -x "$c" ]; then ACME="$c"; break; fi; done',
      '[ -n "$ACME" ] || { echo acme.sh_not_found >&2; exit 127; }',
      `"$ACME" --issue --dns dns_cf ${args} --accountemail ${shellQuote(c.email)}`,
      `"$ACME" --install-cert -d ${shellQuote(domains[0])} --key-file ${shellQuote(row.key_path)} --fullchain-file ${shellQuote(row.cert_path)} --reloadcmd "true"`,
      "nginx -t",
      "systemctl reload nginx 2>/dev/null || nginx -s reload",
      "trap - ERR",
      `rm -f ${shellQuote(certBackup)} ${shellQuote(keyBackup)}`,
    ].join("\n");
    const envPrefix = `CF_Token=${shellQuote(c.cfToken)} CF_Account_ID=${shellQuote(c.cfAccountId)}`;
    const command = `if [ "$(id -u)" = "0" ]; then ${envPrefix} sh -c ${shellQuote(script)}; elif command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then sudo -n env ${envPrefix} sh -c ${shellQuote(script)}; else ${envPrefix} sh -c ${shellQuote(script)}; fi`;
    const result = await exec(client, command);
    if (result.code !== 0) throw new WorkspaceError(502, `certificate_renew_failed:${(result.stderr || result.stdout).slice(-1000)}`);
    // acme.sh installed a new file, so the stored expiry is stale until the next
    // scan; re-read it now or the scheduler keeps re-renewing the same row.
    const fresh = await exec(client, `openssl x509 -in ${shellQuote(row.cert_path)} -noout -enddate 2>/dev/null | sed -n 's/^notAfter=//p'`);
    const expiresAt = Date.parse(fresh.stdout.trim());
    db.prepare("UPDATE certificate_inventory SET last_renew_at=?,last_error='',status='ok',expires_at=COALESCE(?,expires_at) WHERE id=?").run(Date.now(), Number.isFinite(expiresAt) ? expiresAt : null, row.id);
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
  router.get("/machines", (_req, res) => res.json({ machines: db.prepare("SELECT id,name,ssh_host as sshHost,ssh_port as sshPort,ssh_user as sshUser,ssh_auth_type as sshAuthType,CASE WHEN ssh_host_fingerprint != '' AND ssh_fingerprint_address = lower(trim(ssh_host)) || ':' || ssh_port THEN 1 ELSE 0 END as sshTrusted FROM machines WHERE deleted_at IS NULL AND trim(ssh_host) != '' AND trim(ssh_user) != '' ORDER BY sort_order,id").all() }));
  router.get("/summary", (_req, res) => {
    const now = Date.now();
    const rows = db.prepare(`SELECT machine_id as machineId, COUNT(*) as certificates,
      SUM(CASE WHEN expires_at IS NOT NULL AND expires_at < ? THEN 1 ELSE 0 END) as expired,
      SUM(CASE WHEN expires_at IS NOT NULL AND expires_at >= ? AND expires_at < ? THEN 1 ELSE 0 END) as expiring,
      MIN(expires_at) as nextExpiry
      FROM certificate_inventory GROUP BY machine_id`).all(now, now, now + 15 * 86400000);
    res.json({ summary: rows });
  });
  router.get("/machine/:machineId", (req, res) => {
    const id = machineId(req);
    res.json({ certificates: db.prepare("SELECT id,cert_path as certPath,key_path as keyPath,domains,expires_at as expiresAt,issuer,last_scan_at as lastScanAt,last_renew_at as lastRenewAt,status,last_error as lastError FROM certificate_inventory WHERE machine_id=? ORDER BY expires_at ASC").all(id).map((r: any) => ({ ...r, domains: JSON.parse(r.domains || "[]") })) });
  });
  router.post("/machine/:machineId/scan", async (req, res, next) => {
    const id = machineId(req); let client: any;
    try {
      client = await connectMachine(db, id, secret);
      const result = await exec(client, `if command -v timeout >/dev/null 2>&1; then timeout 120s sh -c ${shellQuote(SCAN_SCRIPT)}; else sh -c ${shellQuote(SCAN_SCRIPT)}; fi`, 150_000);
      client.end();
      // timeout(1) reports a killed remote script with exit code 124; partial
      // output from an interrupted scan must not be stored or pruned against.
      if (result.code === 124) throw new WorkspaceError(504, "certificate_scan_timeout");
      if (result.code !== 0 && !result.stdout) throw new WorkspaceError(502, `certificate_scan_failed:${(result.stderr || "remote scan failed").slice(-1000)}`);
      const parsed = parseScan(result.stdout);
      const rows = parsed.rows;
      const seen = new Set((db.prepare("SELECT cert_path FROM certificate_inventory WHERE machine_id=?").all(id) as Array<{ cert_path: string }>).map((r) => r.cert_path));
      let added = 0, updated = 0;
      for (const r of rows) (seen.has(r.path) ? updated++ : added++);
      let pruned = 0;
      const tx = db.transaction(() => {
        const up = db.prepare(`INSERT INTO certificate_inventory(machine_id,cert_path,key_path,domains,expires_at,issuer,last_scan_at,status,last_error) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(machine_id,cert_path) DO UPDATE SET key_path=excluded.key_path,domains=excluded.domains,expires_at=excluded.expires_at,issuer=excluded.issuer,last_scan_at=excluded.last_scan_at,status=excluded.status,last_error=''`);
        for (const r of rows) up.run(id, r.path, r.keyPath, JSON.stringify(r.domains), r.expiresAt, r.issuer, Date.now(), r.expiresAt && r.expiresAt < Date.now() ? "expired" : "ok", "");
        // Only a completed scan that still found certificates may remove
        // entries; a transient failure must not wipe the inventory.
        if (result.code === 0 && rows.length) {
          const placeholders = rows.map(() => "?").join(",");
          pruned = db.prepare(`DELETE FROM certificate_inventory WHERE machine_id=? AND cert_path NOT IN (${placeholders})`).run(id, ...rows.map((r) => r.path)).changes;
        }
      });
      tx();
      res.json({
        ok: true, found: rows.length, added, updated, pruned,
        certificates: rows, info: parsed.info,
        warning: rows.length === 0 ? "未发现可解析证书。请确认 SSH 用户可读取证书目录，且服务器安装 openssl；如果 Nginx 使用自定义路径，请检查 nginx -T 权限。" : undefined,
      });
    } catch (e) { try { client?.end(); } catch {} next(e); }
  });
  router.post("/machine/:machineId/renew", async (req, res, next) => {
    const id = machineId(req); const parsed = RenewBody.safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: "bad_request" });
    const row = db.prepare("SELECT * FROM certificate_inventory WHERE id=? AND machine_id=?").get(parsed.data.id, id) as any;
    if (!row) return res.status(404).json({ error: "certificate_not_found" });
    try { await renewStoredCertificate(db, secret, env, id, row); res.json({ ok: true, reloaded: true }); }
    catch (e) { db.prepare("UPDATE certificate_inventory SET status='error',last_error=? WHERE id=?").run(String(e instanceof Error ? e.message : e).slice(-2000), row.id); next(e); }
  });
  return router;
}

export function startCertificateScheduler(db: Db, secret: string, env: { CERT_EMAIL?: string; CF_Token?: string; CF_Account_ID?: string }) {
  // Renewals only ever run inside this process, so a row still marked
  // 'renewing' at boot belongs to a previous run that was killed mid-flight.
  // Without reclaiming it the scheduler would skip that certificate forever.
  try { db.prepare("UPDATE certificate_inventory SET status='error', last_error='renewal interrupted by restart' WHERE status='renewing'").run(); } catch {}
  const tick = async () => {
    try {
      const c = cfg(db, secret, env);
      if (c.autoRenew === false) return;
      const days = c.autoRenewDays;
      const rows = db.prepare("SELECT id, machine_id as machineId, expires_at as expiresAt FROM certificate_inventory WHERE expires_at IS NOT NULL AND expires_at <= ? AND status != 'renewing'").all(Date.now() + days * 86400000) as Array<{id:number;machineId:number;expiresAt:number}>;
      for (const row of rows) {
        db.prepare("UPDATE certificate_inventory SET status='renewing' WHERE id=?").run(row.id);
        try {
          const full = db.prepare("SELECT * FROM certificate_inventory WHERE id=?").get(row.id);
          await renewStoredCertificate(db, secret, env, row.machineId, full);
          db.prepare("UPDATE certificate_inventory SET status='ok' WHERE id=?").run(row.id);
        } catch (e) {
          db.prepare("UPDATE certificate_inventory SET status='error',last_error=? WHERE id=?").run(String(e instanceof Error ? e.message : e).slice(-2000), row.id);
        }
      }
    } catch {
      // Configuration or storage problems must never crash the process from a
      // background timer; the next tick retries.
    }
  };
  setTimeout(() => void tick(), 30_000).unref();
  setInterval(() => void tick(), 6 * 3600_000).unref();
}
