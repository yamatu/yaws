import { Client, type ClientChannel, type ConnectConfig } from "ssh2";
import { createHash } from "node:crypto";
import type { Db } from "./db.js";
import { decryptText } from "./crypto.js";

/** How many jump hosts one SSH connection may span (the target machine is not
 *  counted). A bastion plus one extra hop covers real setups; a longer chain is
 *  almost always a misconfiguration, and every extra hop is another session
 *  that has to stay healthy for the terminal to work. */
export const MAX_SSH_HOPS = 2;

export class WorkspaceError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export type SshMachine = {
  id: number;
  name: string;
  host: string;
  port: number;
  username: string;
  authType: string;
  password: string;
  privateKey: string;
  fingerprint: string;
  fingerprintAddress: string;
  /** Machine id this one is reached through, 0 for a direct connection. */
  via: number;
};

/** Same as `sshMachine`, but a missing hop is reported as the relay problem it
 *  is: "machine 7 has no SSH" is actionable, "ssh_not_configured" on an
 *  unrelated screen is not. */
export function sshMachine(db: Db, id: number, jump = false): SshMachine {
  if (!Number.isSafeInteger(id) || id < 1)
    throw new WorkspaceError(400, "bad_machine_id");
  const machine = db
    .prepare(
      `SELECT id, name, ssh_host as host, ssh_port as port, ssh_user as username,
    ssh_auth_type as authType, ssh_password_enc as password, ssh_key_enc as privateKey,
    ssh_host_fingerprint as fingerprint, ssh_fingerprint_address as fingerprintAddress,
    via_machine_id as via
    FROM machines WHERE id = ? AND deleted_at IS NULL`,
    )
    .get(id) as SshMachine | undefined;
  if (!machine) throw new WorkspaceError(404, "machine_not_found");
  if (!machine.host.trim() || !machine.username.trim())
    throw new WorkspaceError(409, jump ? "via_not_configured" : "ssh_not_configured");
  return machine;
}

/**
 * Machine ids to open a connection through, outermost first: the last entry is
 * the machine the operator asked for, every earlier one is a jump host. A
 * machine that names itself, directly or through a chain, is refused instead of
 * being dialled forever.
 */
export function sshChain(db: Db, id: number): number[] {
  const chain = [id];
  const seen = new Set<number>([id]);
  let current = sshMachine(db, id);
  while (current.via) {
    const via = current.via;
    if (seen.has(via)) throw new WorkspaceError(409, "via_loop");
    if (chain.length > MAX_SSH_HOPS) throw new WorkspaceError(409, "via_depth");
    seen.add(via);
    current = sshMachine(db, via, true);
    chain.push(current.id);
  }
  return chain.reverse();
}

/**
 * Rejects a relay setting before it is stored: the jump host has to exist with
 * usable SSH credentials, and the new link must not close a loop. Called from
 * the machine create/update routes, so `id` is the machine being edited (0 when
 * it does not exist yet).
 */
export function assertVia(db: Db, id: number, via: number) {
  if (!via) return;
  if (via === id) throw new WorkspaceError(400, "via_self");
  const host = sshMachine(db, via, true);
  if (host.via === id) throw new WorkspaceError(400, "via_loop");
  // Walk up from the prospective jump host: if we walk back into `id` the new
  // link would create a cycle, because that chain is exactly what a later
  // connection would follow.
  const seen = new Set<number>([via]);
  let current = host;
  let depth = 1;
  while (current.via) {
    const next = current.via;
    if (next === id || seen.has(next))
      throw new WorkspaceError(400, "via_loop");
    seen.add(next);
    depth += 1;
    if (depth > MAX_SSH_HOPS) throw new WorkspaceError(400, "via_depth");
    current = sshMachine(db, next, true);
  }
}

/**
 * Machines that reach the network through `id` fall back to a direct
 * connection when it is deleted: keeping the link would leave them pointing at
 * a relay that no longer exists, so they could never be reached again.
 */
export function detachViaChildren(db: Db, id: number, now = Date.now()) {
  db.prepare(
    "UPDATE machines SET via_machine_id = 0, updated_at = ? WHERE via_machine_id = ?",
  ).run(now, id);
}

export function address(machine: SshMachine) {
  return `${machine.host.trim().toLowerCase()}:${machine.port}`;
}
export function fingerprint(key: Buffer) {
  return `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`;
}

/** True when the stored fingerprint still matches the host/port the machine
 *  points at, i.e. `connectMachine` would get past its trust check. */
export function hostTrusted(machine: SshMachine) {
  return (
    Boolean(machine.fingerprint) &&
    machine.fingerprintAddress === address(machine)
  );
}

// Stored credentials are AES-GCM sealed with AGENT_KEY_SECRET (falling back to
// JWT_SECRET). Changing either secret without AGENT_KEY_SECRET_PREVIOUS makes
// every saved password undecryptable, and because trusting a host fingerprint
// never needs the password this only shows up as a failure to scan or connect.
// Expose the state so the UI can warn before the user tries.
export type CredentialState = "ok" | "missing" | "undecryptable";

export function credentialState(
  machine: Pick<SshMachine, "authType" | "password" | "privateKey">,
  secret: string,
): CredentialState {
  const payload = machine.authType === "key" ? machine.privateKey : machine.password;
  if (!payload) return "missing";
  try {
    return decryptText(payload, secret) ? "ok" : "missing";
  } catch {
    return "undecryptable";
  }
}

function decryptCredential(payload: string, secret: string, code: string) {
  let value: string;
  try {
    value = decryptText(payload, secret);
  } catch {
    throw new WorkspaceError(409, code);
  }
  if (!value) throw new WorkspaceError(409, code);
  return value;
}

export function sshConfig(machine: SshMachine, secret: string): ConnectConfig {
  if (!machine.fingerprint || machine.fingerprintAddress !== address(machine))
    throw new WorkspaceError(409, "ssh_host_untrusted");
  const common: ConnectConfig = {
    host: machine.host.trim(),
    port: machine.port,
    username: machine.username.trim(),
    readyTimeout: 15000,
    keepaliveInterval: 10000,
    keepaliveCountMax: 3,
    hostVerifier: (key: Buffer) => fingerprint(key) === machine.fingerprint,
  };
  if (machine.authType === "key") {
    if (!machine.privateKey) throw new WorkspaceError(409, "ssh_key_missing");
    common.privateKey = decryptCredential(machine.privateKey, secret, "ssh_key_invalid");
  } else {
    if (!machine.password)
      throw new WorkspaceError(409, "ssh_password_missing");
    common.password = decryptCredential(machine.password, secret, "ssh_credentials_invalid");
  }
  return common;
}

/**
 * Reads the host key of `machine`, optionally over a socket that already
 * carries the tunnel to it. Authentication is deliberately skipped: a
 * fingerprint has to be inspectable before it is trusted.
 */
export function inspectHost(
  machine: SshMachine,
  sock?: ClientChannel,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const client = new Client();
    let observed: string | null = null;
    const timer = setTimeout(() => {
      client.destroy();
      reject(new WorkspaceError(504, "ssh_timeout"));
    }, 16000);
    const done = (error?: Error) => {
      clearTimeout(timer);
      client.destroy();
      if (observed) resolve(observed);
      else
        reject(
          new WorkspaceError(
            502,
            error ? "ssh_connect_failed" : "ssh_host_unavailable",
          ),
        );
    };
    client.once("error", done);
    client.once("close", () => done());
    client.connect({
      host: machine.host.trim(),
      port: machine.port,
      username: machine.username.trim(),
      readyTimeout: 15000,
      ...(sock ? { sock } : {}),
      hostVerifier: (key: Buffer) => {
        observed = fingerprint(key);
        return false;
      },
    });
  });
}

/**
 * Maps a failed `forwardOut` onto a code the operator can act on. The jump
 * host's `AllowTcpForwarding no` answers with SSH_OPEN_ADMINISTRATIVELY_
 * PROHIBITED (1), which is a configuration switch on that host; anything else
 * is reported as a plain relay failure.
 */
export function hopErrorCode(
  message: unknown,
  reason: unknown,
): "via_forward_denied" | "via_failed" {
  const text = String(message ?? "");
  if (Number(reason) === 1 || /prohibit|denied|not permitted/i.test(text))
    return "via_forward_denied";
  return "via_failed";
}

/** Opens a tunnel from `client` (a jump host) to `next`. */
function forwardTo(
  client: Client,
  next: SshMachine,
  signal?: AbortSignal,
): Promise<ClientChannel> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      cleanup();
      reject(new WorkspaceError(499, "cancelled"));
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new WorkspaceError(504, "ssh_timeout"));
    }, 15000);
    if (signal?.aborted) return abort();
    signal?.addEventListener("abort", abort, { once: true });
    client.forwardOut(
      "127.0.0.1",
      0,
      next.host.trim(),
      next.port,
      (error, stream) => {
        cleanup();
        if (!error) return resolve(stream);
        reject(
          new WorkspaceError(
            502,
            hopErrorCode((error as any)?.message, (error as any)?.reason),
          ),
        );
      },
    );
  });
}

/** Authenticated connection to one machine, optionally over an existing socket. */
function openClient(
  machine: SshMachine,
  secret: string,
  signal?: AbortSignal,
  sock?: ClientChannel,
  jump = false,
): Promise<Client> {
  let config: ConnectConfig;
  try {
    config = sshConfig(machine, secret);
  } catch (e) {
    if (e instanceof WorkspaceError) {
      if (jump && e.message === "ssh_host_untrusted")
        throw new WorkspaceError(409, "via_untrusted");
      throw e;
    }
    // The stored password/private key only fails to decrypt when the server
    // secret changed or the ciphertext is damaged; surface that explicitly
    // instead of letting it become a generic internal_error.
    throw new WorkspaceError(409, "ssh_credentials_invalid");
  }
  if (sock) config.sock = sock;
  return new Promise((resolve, reject) => {
    const client = new Client();
    const abort = () => {
      client.destroy();
      reject(new WorkspaceError(499, "cancelled"));
    };
    if (signal?.aborted) return abort();
    signal?.addEventListener("abort", abort, { once: true });
    client.once("close", () => {
      signal?.removeEventListener("abort", abort);
      reject(new WorkspaceError(502, "ssh_closed"));
    });
    client.on("error", (error: any) => {
      // ssh2 reports the reason in `level`; map the ones the operator can act on
      // to a stable code instead of leaking "ssh_client-authentication".
      const message = String(error?.message ?? error ?? "ssh error");
      const level = String(error?.level ?? "");
      const code = message.includes("verification")
        ? "ssh_host_key_changed"
        : level === "client-authentication"
          ? "ssh_auth_failed"
          : level === "client-timeout"
            ? "ssh_timeout"
            : "ssh_connect_failed";
      reject(new WorkspaceError(502, code));
    });
    client.once("ready", () => resolve(client));
    try {
      client.connect(config);
    } catch {
      client.destroy();
      reject(new WorkspaceError(502, "ssh_connect_failed"));
    }
  });
}

/**
 * Opens every relay of `id` (outermost first) and returns the socket that walks
 * the target machine, plus the clients carrying it. The callers own the clients
 * and must destroy them; they are what keeps the tunnel alive.
 */
async function relaySock(
  db: Db,
  id: number,
  secret: string,
  signal?: AbortSignal,
): Promise<{ chain: SshMachine[]; clients: Client[]; sock?: ClientChannel }> {
  const chain = sshChain(db, id).map((hopId) => sshMachine(db, hopId));
  const clients: Client[] = [];
  let sock: ClientChannel | undefined;
  try {
    for (let index = 0; index < chain.length - 1; index += 1) {
      // The hops are trusted as well: a tunnel out of a host whose own identity
      // was never confirmed says nothing about where it leads.
      const client = await openClient(chain[index], secret, signal, sock, true);
      clients.push(client);
      sock = await forwardTo(client, chain[index + 1], signal);
    }
  } catch (error) {
    for (const client of clients) client.destroy();
    throw error;
  }
  return { chain, clients, sock };
}

/**
 * Connects to `id`, hopping through every relay the machine is configured with.
 * The returned client is the one talking to the target; the intermediate
 * sessions are kept alive while it is open because they carry its socket, and
 * they are closed with it.
 */
export async function connectMachine(
  db: Db,
  id: number,
  secret: string,
  signal?: AbortSignal,
): Promise<Client> {
  const { chain, clients, sock } = await relaySock(db, id, secret, signal);
  let target: Client;
  try {
    target = await openClient(
      chain[chain.length - 1],
      secret,
      signal,
      sock,
      false,
    );
  } catch (error) {
    for (const client of clients) client.destroy();
    throw error;
  }
  target.once("close", () => {
    for (const client of clients) client.destroy();
  });
  return target;
}

/** Host key of `id`, read through its relays so an internal machine can be
 *  trusted before anything else can reach it. */
export async function inspectMachine(
  db: Db,
  id: number,
  secret: string,
  signal?: AbortSignal,
): Promise<string> {
  const { chain, clients, sock } = await relaySock(db, id, secret, signal);
  try {
    return await inspectHost(chain[chain.length - 1], sock);
  } finally {
    for (const client of clients) client.destroy();
  }
}

export function shellQuote(text: string) {
  return `'${text.replace(/'/g, `'"'"'`)}'`;
}
