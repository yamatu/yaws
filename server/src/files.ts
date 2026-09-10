import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { Client, SFTPWrapper, Stats, FileEntryWithStats } from "ssh2";
import type { Db } from "./db.js";
import { connectMachine, WorkspaceError, shellQuote } from "./ssh.js";

export const TEXT_LIMIT = 512 * 1024;
export const FILE_LIMIT = 8 * 1024 * 1024;
export const revision = (data: Buffer) =>
  createHash("sha256").update(data).digest("hex");
export function remotePath(value: string) {
  if (
    !value.startsWith("/") ||
    value.length > 4096 ||
    /[\x00-\x1f\x7f]/.test(value)
  )
    throw new WorkspaceError(400, "bad_path");
  return path.posix.normalize(value);
}
export function insideRoot(root: string, file: string) {
  return root === "/" || file === root || file.startsWith(`${root}/`);
}
export function callback<T>(
  run: (done: (error: Error | undefined | null, value: T) => void) => void,
): Promise<T> {
  return new Promise((resolve, reject) =>
    run((error, value) => (error ? reject(error) : resolve(value))),
  );
}
function action(
  run: (done: (error?: Error | null) => void) => void,
): Promise<void> {
  return new Promise((resolve, reject) =>
    run((error) => (error ? reject(error) : resolve())),
  );
}
export class RemoteFiles {
  constructor(readonly sftp: SFTPWrapper) {}
  async canonical(value: string) {
    return remotePath(
      await callback<string>((cb) => this.sftp.realpath(remotePath(value), cb)),
    );
  }
  async confined(root: string, value: string, create = false) {
    const base = await this.canonical(root);
    let actual: string;
    try {
      actual = await this.canonical(value);
    } catch (e) {
      if (!create || (e as { code?: number }).code !== 2) throw e;
      const parent = await this.canonical(
        path.posix.dirname(remotePath(value)),
      );
      actual = path.posix.join(parent, path.posix.basename(value));
    }
    if (!insideRoot(base, actual))
      throw new WorkspaceError(403, "outside_workspace");
    return actual;
  }
  async list(value: string) {
    const actual = await this.canonical(value);
    const entries = await callback<FileEntryWithStats[]>((cb) =>
      this.sftp.readdir(actual, cb),
    );
    if (entries.length > 5000)
      throw new WorkspaceError(413, "directory_too_large");
    return {
      path: actual,
      entries: entries
        .filter((e) => e.filename !== "." && e.filename !== "..")
        .map((e) => ({
          name: e.filename,
          path: path.posix.join(actual, e.filename),
          directory: e.attrs.isDirectory(),
          symlink: e.attrs.isSymbolicLink(),
          size: e.attrs.size,
          modifiedAt: e.attrs.mtime * 1000,
          mode: e.attrs.mode & 0o777,
        }))
        .sort(
          (a, b) =>
            Number(b.directory) - Number(a.directory) ||
            a.name.localeCompare(b.name),
        ),
    };
  }
  async resolve(value: string) {
    const actual = await this.canonical(value);
    const stat = await callback<Stats>((cb) => this.sftp.stat(actual, cb));
    return { path: actual, directory: stat.isDirectory() };
  }
  async read(value: string, limit = TEXT_LIMIT) {
    const actual = await this.canonical(value);
    const handle = await callback<Buffer>((cb) =>
      this.sftp.open(actual, "r", cb),
    );
    try {
      const stat = await callback<Stats>((cb) => this.sftp.fstat(handle, cb));
      if (!stat.isFile()) throw new WorkspaceError(400, "not_regular_file");
      if (stat.size > limit) throw new WorkspaceError(413, "file_too_large");
      const chunks: Buffer[] = [];
      let offset = 0;
      while (offset <= limit) {
        const buffer = Buffer.alloc(Math.min(32768, limit + 1 - offset));
        const n = await new Promise<number>((resolve, reject) =>
          this.sftp.read(
            handle,
            buffer,
            0,
            buffer.length,
            offset,
            (err, count) => (err ? reject(err) : resolve(count)),
          ),
        );
        if (!n) break;
        chunks.push(buffer.subarray(0, n));
        offset += n;
      }
      if (offset > limit) throw new WorkspaceError(413, "file_too_large");
      return { path: actual, data: Buffer.concat(chunks), stat };
    } finally {
      await action((cb) => this.sftp.close(handle, cb));
    }
  }
  async text(value: string) {
    const file = await this.read(value);
    let content: string;
    try {
      content = new TextDecoder("utf-8", {
        fatal: true,
        ignoreBOM: true,
      }).decode(file.data);
    } catch {
      throw new WorkspaceError(415, "not_utf8_text");
    }
    if (content.includes("\0")) throw new WorkspaceError(415, "binary_file");
    return {
      path: file.path,
      content,
      revision: revision(file.data),
      size: file.data.length,
      mode: file.stat.mode & 0o777,
    };
  }
  async write(value: string, data: Buffer, expected: string | null) {
    if (data.length > FILE_LIMIT)
      throw new WorkspaceError(413, "file_too_large");
    const target = await this.confined("/", value, true);
    let before: Awaited<ReturnType<RemoteFiles["read"]>> | null = null;
    try {
      before = await this.read(target, FILE_LIMIT);
    } catch (e) {
      if ((e as { code?: number }).code !== 2) throw e;
    }
    if ((before ? revision(before.data) : null) !== expected)
      throw new WorkspaceError(409, "file_changed");
    const temp = path.posix.join(
      path.posix.dirname(target),
      `.yaws-${randomUUID()}.tmp`,
    );
    const backup = before
      ? `${target}.yaws-backup-${Date.now()}-${randomUUID().slice(0, 8)}`
      : null;
    try {
      await action((cb) =>
        this.sftp.writeFile(
          temp,
          data,
          { flag: "wx", mode: before ? before.stat.mode & 0o777 : 0o600 },
          cb,
        ),
      );
      if (before) {
        await action((cb) =>
          this.sftp.chown(temp, before!.stat.uid, before!.stat.gid, cb),
        );
        await action((cb) =>
          this.sftp.chmod(temp, before!.stat.mode & 0o777, cb),
        );
        await action((cb) =>
          this.sftp.writeFile(
            backup!,
            before!.data,
            { flag: "wx", mode: 0o600 },
            cb,
          ),
        );
        const current = await this.read(target, FILE_LIMIT);
        if (revision(current.data) !== expected)
          throw new WorkspaceError(409, "file_changed");
        try {
          await action((cb) => this.sftp.ext_openssh_rename(temp, target, cb));
        } catch (e) {
          if (
            !(e instanceof Error) ||
            (!e.message.includes("does not support") &&
              (e as { code?: number }).code !== 8)
          )
            throw e;
          // SFTP v3 has no atomic overwrite. Keep the original at a rollback path during replacement.
          const rollback = `${temp}.original`;
          await action((cb) => this.sftp.rename(target, rollback, cb));
          try {
            await action((cb) => this.sftp.rename(temp, target, cb));
          } catch (writeError) {
            try {
              await action((cb) => this.sftp.rename(rollback, target, cb));
            } catch {
              throw new WorkspaceError(500, `restore_required:${rollback}`);
            }
            throw writeError;
          }
          await action((cb) => this.sftp.unlink(rollback, cb));
        }
      } else {
        // Standard SFTP rename fails if a destination was created concurrently.
        await action((cb) => this.sftp.rename(temp, target, cb));
      }
      return { path: target, revision: revision(data), backup };
    } finally {
      await action((cb) => this.sftp.unlink(temp, cb)).catch((e: unknown) => {
        if ((e as { code?: number }).code !== 2)
          console.warn("[sftp] temporary file cleanup failed");
      });
    }
  }
  async discover() {
    const candidates = [
      ["Nginx", "/etc/nginx"],
      ["Apache", "/etc/apache2"],
      ["Apache", "/etc/httpd"],
      ["Caddy", "/etc/caddy"],
      ["Docker", "/etc/docker"],
      ["宝塔网站", "/www/wwwroot"],
      ["宝塔配置", "/www/server/panel"],
      ["1Panel", "/opt/1panel"],
      ["网站", "/var/www"],
      ["应用", "/opt"],
      ["服务", "/srv"],
      ["systemd", "/etc/systemd/system"],
    ];
    const found: Array<{ name: string; path: string }> = [];
    for (const [name, dir] of candidates) {
      try {
        const stat = await callback<Stats>((cb) => this.sftp.stat(dir, cb));
        if (stat.isDirectory()) found.push({ name, path: dir });
      } catch (e) {
        if (![2, 3].includes((e as { code?: number }).code ?? 0)) throw e;
      }
    }
    return {
      home: await callback<string>((cb) => this.sftp.realpath(".", cb)),
      products: found,
    };
  }
}

const activeByMachine = new Map<number, number>();
const writeLocks = new Set<string>();
export async function withFiles<T>(
  db: Db,
  machineId: number,
  secret: string,
  fn: (files: RemoteFiles) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (
    (activeByMachine.get(machineId) ?? 0) >= 4 ||
    [...activeByMachine.values()].reduce((a, b) => a + b, 0) >= 16
  )
    throw new WorkspaceError(429, "workspace_busy");
  activeByMachine.set(machineId, (activeByMachine.get(machineId) ?? 0) + 1);
  const ctrl = new AbortController();
  const abort = () => ctrl.abort();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) ctrl.abort();
  let client: Client | undefined;
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      (async () => {
        client = await connectMachine(db, machineId, secret, ctrl.signal);
        const sftp = await callback<SFTPWrapper>((cb) => client!.sftp(cb));
        return fn(new RemoteFiles(sftp));
      })(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          ctrl.abort();
          reject(new WorkspaceError(504, "workspace_timeout"));
        }, 45000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    ctrl.abort();
    client?.destroy();
    signal?.removeEventListener("abort", abort);
    const count = (activeByMachine.get(machineId) ?? 1) - 1;
    if (count) activeByMachine.set(machineId, count);
    else activeByMachine.delete(machineId);
  }
}
export async function lockedWrite<T>(
  machineId: number,
  file: string,
  fn: () => Promise<T>,
) {
  const key = `${machineId}:${remotePath(file)}`;
  if (writeLocks.has(key)) throw new WorkspaceError(409, "file_busy");
  writeLocks.add(key);
  try {
    return await fn();
  } finally {
    writeLocks.delete(key);
  }
}

export async function runCommand(
  db: Db,
  id: number,
  secret: string,
  root: string,
  command: string,
  signal?: AbortSignal,
) {
  const ctrl = new AbortController();
  const abort = () => ctrl.abort();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) ctrl.abort();
  const timer = setTimeout(abort, 30000);
  const client = await connectMachine(db, id, secret, ctrl.signal).catch(
    (e: unknown) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      throw e;
    },
  );
  try {
    return await new Promise<{ output: string; code: number | null }>(
      (resolve, reject) => {
        client.once("close", () =>
          reject(
            new WorkspaceError(
              502,
              ctrl.signal.aborted
                ? "command_timeout_or_cancelled"
                : "ssh_closed",
            ),
          ),
        );
        client.exec(
          `cd -- ${shellQuote(remotePath(root))} && (\n${command}\n)`,
          (err, stream) => {
            if (err) return reject(new WorkspaceError(502, "exec_failed"));
            let length = 0;
            const chunks: Buffer[] = [];
            const onData = (data: Buffer) => {
              length += data.length;
              if (length > 256 * 1024) {
                stream.close();
                reject(new WorkspaceError(413, "command_output_limit"));
              } else chunks.push(data);
            };
            stream.on("data", onData);
            stream.stderr.on("data", onData);
            stream.once("close", (code: number | null) =>
              resolve({ output: Buffer.concat(chunks).toString("utf8"), code }),
            );
            stream.once("error", () =>
              reject(new WorkspaceError(502, "exec_failed")),
            );
          },
        );
      },
    );
  } finally {
    clearTimeout(timer);
    client.destroy();
    signal?.removeEventListener("abort", abort);
  }
}
