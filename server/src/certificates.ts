import { Router, type NextFunction, type Request, type RequestHandler, type Response } from "express";
import { z } from "zod";
import type { Db } from "./db.js";
import type { AuthedRequest } from "./http.js";
import { connectMachine, credentialState, shellQuote, sshMachine, WorkspaceError } from "./ssh.js";
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
const IssueBody = z.object({
  domains: z.array(z.string().max(253)).min(1).max(30),
  certPath: z.string().max(900).optional(),
  keyPath: z.string().max(900).optional(),
  force: z.boolean().optional(),
  reload: z.boolean().optional(),
});

type ExecResult = { stdout: string; stderr: string; code: number };

// Anything that is not a WorkspaceError reaches the global handler as a bare
// "internal_error", which tells the operator nothing. Always carry the cause.
export function errorDetail(e: unknown) {
  const name = e instanceof Error ? e.name : typeof e;
  const message = e instanceof Error ? e.message : String(e);
  return `${name}: ${message}`.replace(/\s+/g, " ").trim().slice(0, 300);
}

function phaseError(phase: string, e: unknown) {
  if (e instanceof WorkspaceError || e instanceof z.ZodError) return e;
  // eslint-disable-next-line no-console
  console.error(`[certificates] ${phase} failed`, e);
  return new WorkspaceError(500, `certificate_${phase}_failed:${errorDetail(e)}`);
}

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
    try {
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
    } catch (e) {
      // ssh2 throws synchronously ("Not connected") when the socket died between
      // `ready` and this call; a raw throw here used to escape as internal_error.
      done(new WorkspaceError(502, `ssh_exec_failed:${errorDetail(e)}`));
    }
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
// domains is a JSON column written by this router, but a truncated write or a
// row from an older build must not throw inside a synchronous handler.
function parseDomains(value: unknown): string[] {
  try {
    const parsed = JSON.parse(String(value || "[]"));
    return Array.isArray(parsed) ? parsed.filter((d): d is string => typeof d === "string") : [];
  } catch { return []; }
}

// The CN/SAN extraction is shared by the scanner and by the post-issue probe.
function certDomains(subject: string, sans: string) {
  const domains = new Set<string>();
  const cn = subject.replace(/^subject=/, "").match(/(?:^|,)CN=([^,]+)/)?.[1];
  if (cn) domains.add(cn.trim());
  for (const m of sans.matchAll(/DNS:([^,\s]+)/g)) domains.add(m[1].trim());
  return [...domains];
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
    // A channel that closes mid-record leaves a short line; skipping it keeps
    // one truncated row from failing the entire scan with a TypeError.
    if (fields.length < 5) continue;
    const [path = "", end = "", issuer = "", subject = "", sans = "", keyPath = ""] = fields.map(decodeRemoteField);
    const domains = new Set(certDomains(subject, sans));
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

const DOMAIN_RE = /^(\*\.)?([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

function normalizeDomains(input: string[]): string[] {
  const seen = new Set<string>();
  for (const raw of input) {
    const domain = raw.trim().toLowerCase().replace(/\.$/, "");
    if (!domain) continue;
    if (domain.length > 253 || !DOMAIN_RE.test(domain))
      throw new WorkspaceError(400, `bad_domain:${raw.trim().slice(0, 80)}`);
    seen.add(domain);
  }
  if (!seen.size) throw new WorkspaceError(400, "bad_domain:empty");
  if (seen.size > 30) throw new WorkspaceError(400, "too_many_domains");
  return [...seen];
}

function normalizePath(value: string, kind: "cert" | "key") {
  const path = value.trim();
  if (!path.startsWith("/") || path.length > 900 || /[\n\r\0]/.test(path) || path.endsWith("/"))
    throw new WorkspaceError(400, `bad_${kind}_path`);
  return path;
}

type AcmeTarget = { domains: string[]; certPath: string; keyPath: string; email: string; force: boolean; reload: boolean };

// The renewal script must run as root, or through `sudo -n` when the SSH user is
// not root but has passwordless sudo (the usual way to reach /etc/nginx). The
// Cloudflare credentials are passed explicitly so acme.sh sees them either way.
function withCredentials(script: string, c: { cfToken: string; cfAccountId: string }) {
  const envPrefix = `CF_Token=${shellQuote(c.cfToken)} CF_Account_ID=${shellQuote(c.cfAccountId)}`;
  return `if [ "$(id -u)" = "0" ]; then ${envPrefix} sh -c ${shellQuote(script)}; elif command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then sudo -n env ${envPrefix} sh -c ${shellQuote(script)}; else ${envPrefix} sh -c ${shellQuote(script)}; fi`;
}

function asRoot(command: string) {
  return `if [ "$(id -u)" = "0" ]; then ${command}; elif command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then sudo -n ${command}; else ${command}; fi`;
}

// Read back what is actually on disk: the issued certificate decides the domains
// and expiry, not the request body.
function certProbeCommand(certPath: string) {
  return asRoot(`openssl x509 -in ${shellQuote(certPath)} -noout -enddate -subject -nameopt RFC2253 -ext subjectAltName 2>/dev/null`);
}

function parseCertText(text: string) {
  const end = /^notAfter=(.*)$/m.exec(text)?.[1]?.trim() ?? "";
  const subject = /^subject=(.*)$/m.exec(text)?.[1]?.trim() ?? "";
  const sans = [...text.matchAll(/DNS:[^,\s]+/g)].map((m) => m[0]).join(",");
  const expiresAt = Date.parse(end);
  return { domains: certDomains(subject, sans), expiresAt: Number.isFinite(expiresAt) ? expiresAt : null };
}

// `trap ... ERR` is a bash extension: on Debian/Ubuntu and Alpine `sh` is dash or
// busybox ash, where it fails with "bad trap" before anything else runs. Every
// step therefore checks its own exit status instead of relying on the trap.
// Exported so the tests can parse/execute it with a real POSIX shell.
export function acmeScript(t: AcmeTarget) {
  const args = t.domains.map((d) => `-d ${shellQuote(d)}`).join(" ");
  const install = `--install-cert -d ${shellQuote(t.domains[0])} --key-file "$KEY" --fullchain-file "$CERT" --reloadcmd "true"`;
  const lines = [
    `CERT=${shellQuote(t.certPath)}`,
    `KEY=${shellQuote(t.keyPath)}`,
    'CERT_BAK="$CERT.yaws-before-issue"',
    'KEY_BAK="$KEY.yaws-before-issue"',
    'restore(){ if [ -f "$CERT_BAK" ]; then cp -p "$CERT_BAK" "$CERT"; fi; if [ -f "$KEY_BAK" ]; then cp -p "$KEY_BAK" "$KEY"; fi; return 0; }',
    'fail(){ rc=$1; shift; restore; echo "$*" >&2; exit "$rc"; }',
    // A brand-new path has no directory yet, and only a pre-existing pair needs
    // a backup, so both steps are conditional.
    'mkdir -p "$(dirname "$CERT")" "$(dirname "$KEY")" || fail 1 cert_dir_failed',
    'if [ -f "$CERT" ]; then cp -p "$CERT" "$CERT_BAK" || fail 1 backup_failed; fi',
    'if [ -f "$KEY" ]; then cp -p "$KEY" "$KEY_BAK" || fail 1 backup_failed; fi',
    'ACME=""; for c in "$(command -v acme.sh 2>/dev/null || true)" "${HOME:-/root}/.acme.sh/acme.sh" /root/.acme.sh/acme.sh; do if [ -n "$c" ] && [ -x "$c" ]; then ACME="$c"; break; fi; done',
    '[ -n "$ACME" ] || fail 127 acme.sh_not_found',
    `"$ACME" --issue --dns dns_cf ${args} --accountemail ${shellQuote(t.email)}${t.force ? " --force" : ""} || fail 1 acme_issue_failed`,
    // acme.sh stores ECC and RSA certificates in different directories and
    // --install-cert needs the matching flag, so retry once with --ecc.
    `"$ACME" ${install} || "$ACME" --ecc ${install} || fail 1 acme_install_failed`,
  ];
  if (t.reload) {
    lines.push(
      "nginx -t || fail 1 nginx_config_test_failed",
      "systemctl reload nginx >/dev/null 2>&1 || nginx -s reload >/dev/null 2>&1 || fail 1 nginx_reload_failed",
    );
  }
  lines.push('rm -f "$CERT_BAK" "$KEY_BAK"');
  return lines.join("\n");
}

function storeCertificate(db: Db, machineId: number, row: { path: string; keyPath: string; domains: string[]; expiresAt: number | null; issuer: string }) {
  db.prepare(`INSERT INTO certificate_inventory(machine_id,cert_path,key_path,domains,expires_at,issuer,last_scan_at,status,last_error) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(machine_id,cert_path) DO UPDATE SET key_path=excluded.key_path,domains=excluded.domains,expires_at=excluded.expires_at,issuer=excluded.issuer,last_scan_at=excluded.last_scan_at,status=excluded.status,last_error=''`)
    .run(machineId, row.path, row.keyPath, JSON.stringify(row.domains), row.expiresAt, row.issuer, Date.now(), row.expiresAt && row.expiresAt < Date.now() ? "expired" : "ok", "");
}

// Shared by the renew endpoint, the scheduler and the manual issue form.
async function runAcme(client: any, t: AcmeTarget, c: { cfToken: string; cfAccountId: string }, failureCode: string) {
  const result = await exec(client, withCredentials(acmeScript(t), c), 300_000);
  if (result.code !== 0)
    throw new WorkspaceError(502, `${failureCode}:${(result.stderr || result.stdout).slice(-1000)}`);
  const probe = await exec(client, certProbeCommand(t.certPath), 30_000);
  return parseCertText(probe.stdout);
}

async function renewStoredCertificate(db: Db, secret: string, env: { CERT_EMAIL?: string; CF_Token?: string; CF_Account_ID?: string }, id: number, row: any) {
  const c = cfg(db, secret, env);
  if (!c.cfToken || !c.cfAccountId) throw new WorkspaceError(409, "cloudflare_not_configured");
  const domains: string[] = parseDomains(row.domains);
  if (!domains.length || !row.key_path) throw new WorkspaceError(409, "certificate_key_not_found");
  const client = await connectMachine(db, id, secret);
  try {
    const issued = await runAcme(client, { domains, certPath: row.cert_path, keyPath: row.key_path, email: c.email, force: false, reload: true }, c, "certificate_renew_failed");
    // acme.sh installed a new file, so the stored expiry is stale until the next
    // scan; re-read it now or the scheduler keeps re-renewing the same row.
    db.prepare("UPDATE certificate_inventory SET last_renew_at=?,last_error='',status='ok',expires_at=COALESCE(?,expires_at),domains=? WHERE id=?")
      .run(Date.now(), issued.expiresAt, JSON.stringify(issued.domains.length ? issued.domains : domains), row.id);
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
  router.get("/machines", (_req, res) => {
    // Credential health is computed here so a stale AGENT_KEY_SECRET shows up as
    // a warning tag instead of only failing later inside a scan.
    const rows = db.prepare("SELECT id,name,ssh_host as sshHost,ssh_port as sshPort,ssh_user as sshUser,ssh_auth_type as sshAuthType,ssh_password_enc as sshPasswordEnc,ssh_key_enc as sshKeyEnc,CASE WHEN ssh_host_fingerprint != '' AND ssh_fingerprint_address = lower(trim(ssh_host)) || ':' || ssh_port THEN 1 ELSE 0 END as sshTrusted FROM machines WHERE deleted_at IS NULL AND trim(ssh_host) != '' AND trim(ssh_user) != '' ORDER BY sort_order,id").all() as any[];
    res.json({ machines: rows.map((r) => ({ id: r.id, name: r.name, sshHost: r.sshHost, sshPort: r.sshPort, sshUser: r.sshUser, sshAuthType: r.sshAuthType, sshTrusted: r.sshTrusted, credentials: credentialState({ authType: r.sshAuthType, password: r.sshPasswordEnc, privateKey: r.sshKeyEnc }, secret) })) });
  });
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
    res.json({ certificates: db.prepare("SELECT id,cert_path as certPath,key_path as keyPath,domains,expires_at as expiresAt,issuer,last_scan_at as lastScanAt,last_renew_at as lastRenewAt,status,last_error as lastError FROM certificate_inventory WHERE machine_id=? ORDER BY expires_at ASC").all(id).map((r: any) => ({ ...r, domains: parseDomains(r.domains) })) });
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
        for (const r of rows) storeCertificate(db, id, r);
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
    } catch (e) { try { client?.end(); } catch {} next(phaseError("scan", e)); }
  });
  router.post("/machine/:machineId/renew", async (req, res, next) => {
    const id = machineId(req); const parsed = RenewBody.safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: "bad_request" });
    const row = db.prepare("SELECT * FROM certificate_inventory WHERE id=? AND machine_id=?").get(parsed.data.id, id) as any;
    if (!row) return res.status(404).json({ error: "certificate_not_found" });
    try { await renewStoredCertificate(db, secret, env, id, row); res.json({ ok: true, reloaded: true }); }
    catch (e) { db.prepare("UPDATE certificate_inventory SET status='error',last_error=? WHERE id=?").run(String(e instanceof Error ? e.message : e).slice(-2000), row.id); next(phaseError("renew", e)); }
  });
  // Manual issuance: the operator types the domains, Cloudflare DNS-01 does the
  // validation, and the result is written into the same inventory the scanner
  // fills so it shows up (and auto-renews) like any discovered certificate.
  router.post("/machine/:machineId/issue", async (req, res, next) => {
    const id = machineId(req);
    const parsed = IssueBody.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "bad_request" });
    let client: any;
    try {
      const c = cfg(db, secret, env);
      const domains = normalizeDomains(parsed.data.domains);
      // Reuse the paths of an already-tracked certificate covering one of these
      // domains, so adding a SAN does not silently create a second file pair.
      const known = (db.prepare("SELECT cert_path, key_path, domains FROM certificate_inventory WHERE machine_id=?").all(id) as any[])
        .find((r) => parseDomains(r.domains).some((d) => domains.includes(d)));
      const base = domains[0].replace(/^\*\./, "");
      const certPath = normalizePath(parsed.data.certPath || known?.cert_path || `/etc/nginx/ssl/${base}.pem`, "cert");
      const keyPath = normalizePath(parsed.data.keyPath || known?.key_path || `/etc/nginx/ssl/${base}.key`, "key");
      if (certPath === keyPath) throw new WorkspaceError(400, "cert_and_key_same_path");
      // Validated before the Cloudflare check so bad input is reported as such
      // even when the API token is not configured yet.
      if (!c.cfToken || !c.cfAccountId) throw new WorkspaceError(409, "cloudflare_not_configured");
      const reload = parsed.data.reload !== false;
      client = await connectMachine(db, id, secret);
      const issued = await runAcme(client, { domains, certPath, keyPath, email: c.email, force: parsed.data.force !== false, reload }, c, "certificate_issue_failed");
      const finalDomains = issued.domains.length ? issued.domains : domains;
      storeCertificate(db, id, { path: certPath, keyPath, domains: finalDomains, expiresAt: issued.expiresAt, issuer: "" });
      res.json({ ok: true, certPath, keyPath, domains: finalDomains, expiresAt: issued.expiresAt, reloaded: reload });
    } catch (e) { next(phaseError("issue", e)); } finally { try { client?.end(); } catch {} }
  });
  // Last line of defence for this router: an unexpected exception (SQLite
  // failure, driver error, malformed payload) must name itself instead of
  // degrading into a bare internal_error that hides the cause from the operator.
  router.use(((err: unknown, _req: Request, _res: Response, next: NextFunction) => {
    if (err instanceof WorkspaceError || err instanceof z.ZodError) return next(err);
    // eslint-disable-next-line no-console
    console.error("[certificates] unhandled", err);
    next(new WorkspaceError(500, `certificate_internal_error:${errorDetail(err)}`));
  }) as unknown as RequestHandler);
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
