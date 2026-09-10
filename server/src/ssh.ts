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
    common.privateKey = decryptText(machine.privateKey, secret);
  } else {
    if (!machine.password)
      throw new WorkspaceError(409, "ssh_password_missing");
    common.password = decryptText(machine.password, secret);
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
  const config = sshConfig(sshMachine(db, id), secret);
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
    client.on("error", (error: Error & { level?: string }) => {
      reject(
        new WorkspaceError(
          502,
          error.message.includes("verification")
            ? "ssh_host_key_changed"
            : `ssh_${error.level ?? "connect_failed"}`,
        ),
      );
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
