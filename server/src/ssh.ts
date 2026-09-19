import { Client, type ConnectConfig } from "ssh2";
import { createHash } from "node:crypto";
import type { Db } from "./db.js";
import { decryptText } from "./crypto.js";

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
};

export function sshMachine(db: Db, id: number): SshMachine {
  if (!Number.isSafeInteger(id) || id < 1)
    throw new WorkspaceError(400, "bad_machine_id");
  const machine = db
    .prepare(
      `SELECT id, name, ssh_host as host, ssh_port as port, ssh_user as username,
    ssh_auth_type as authType, ssh_password_enc as password, ssh_key_enc as privateKey,
    ssh_host_fingerprint as fingerprint, ssh_fingerprint_address as fingerprintAddress
    FROM machines WHERE id = ? AND deleted_at IS NULL`,
    )
    .get(id) as SshMachine | undefined;
  if (!machine) throw new WorkspaceError(404, "machine_not_found");
  if (!machine.host.trim() || !machine.username.trim())
    throw new WorkspaceError(409, "ssh_not_configured");
  return machine;
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

export function inspectHost(machine: SshMachine): Promise<string> {
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
      hostVerifier: (key: Buffer) => {
        observed = fingerprint(key);
        return false;
      },
    });
  });
}

export function connectMachine(
  db: Db,
  id: number,
  secret: string,
  signal?: AbortSignal,
): Promise<Client> {
  let config: ConnectConfig;
  try {
    config = sshConfig(sshMachine(db, id), secret);
  } catch (e) {
    if (e instanceof WorkspaceError) throw e;
    // The stored password/private key only fails to decrypt when the server
    // secret changed or the ciphertext is damaged; surface that explicitly
    // instead of letting it become a generic internal_error.
    throw new WorkspaceError(409, "ssh_credentials_invalid");
  }
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

export function shellQuote(text: string) {
  return `'${text.replace(/'/g, `'"'"'`)}'`;
}
