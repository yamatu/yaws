import express, {
  Router,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { z } from "zod";
import type { Db } from "./db.js";
import type { AuthedRequest } from "./http.js";
import { address, inspectHost, sshMachine, WorkspaceError } from "./ssh.js";
import {
  withFiles,
  lockedWrite,
  TEXT_LIMIT,
  FILE_LIMIT,
  remotePath,
} from "./files.js";

export function route(fn: (req: Request, res: Response) => Promise<unknown>) {
  return (req: Request, res: Response, next: NextFunction) => {
    void fn(req, res).catch(next);
  };
}
export function audit(
  db: Db,
  machineId: number,
  userId: number,
  action: string,
  path: string,
  detail = "",
) {
  db.prepare(
    "INSERT INTO workspace_audit(machine_id, operator_id, action, path, detail, at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(machineId, userId, action, path, detail, Date.now());
}
export function requestSignal(res: Response) {
  const controller = new AbortController();
  res.once("close", () => {
    if (!res.writableEnded) controller.abort();
  });
  return controller.signal;
}
const Shortcut = z.object({
  name: z.string().trim().min(1).max(80),
  command: z.string().min(1).max(16000),
});
const Write = z.object({
  path: z.string(),
  content: z.string(),
  revision: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
});

export function workspaceRouter(db: Db, secret: string) {
  const router = Router({ mergeParams: true });
  const id = (req: Request) => Number(req.params.id);
  const uid = (req: Request) => (req as AuthedRequest).user.id;
  router.use((req, _res, next) => {
    try {
      sshMachine(db, id(req));
      next();
    } catch (e) {
      next(e);
    }
  });
  router.get("/host-key", (req, res) => {
    const machine = sshMachine(db, id(req));
    res.json({
      address: address(machine),
      fingerprint:
        machine.fingerprintAddress === address(machine)
          ? machine.fingerprint
          : "",
    });
  });
  const inspections = new Set<number>();
  router.post(
    "/host-key/inspect",
    route(async (req, res) => {
      if (inspections.has(id(req)) || inspections.size >= 4)
        throw new WorkspaceError(429, "workspace_busy");
      inspections.add(id(req));
      try {
        const machine = sshMachine(db, id(req));
        res.json({
          address: address(machine),
          fingerprint: await inspectHost(machine),
        });
      } finally {
        inspections.delete(id(req));
      }
    }),
  );
  router.put(
    "/host-key",
    route(async (req, res) => {
      const body = z
        .object({
          fingerprint: z.string().regex(/^SHA256:[A-Za-z0-9+/]{43}$/),
          address: z.string().max(300),
        })
        .parse(req.body);
      const machine = sshMachine(db, id(req));
      if (body.address !== address(machine))
        throw new WorkspaceError(409, "ssh_address_changed");
      db.prepare(
        "UPDATE machines SET ssh_host_fingerprint = ?, ssh_fingerprint_address = ? WHERE id = ?",
      ).run(body.fingerprint, body.address, id(req));
      audit(
        db,
        id(req),
        uid(req),
        "trust_host",
        body.address,
        body.fingerprint,
      );
      res.json({ ok: true });
    }),
  );
  router.get("/shortcuts", (req, res) =>
    res.json({
      shortcuts: db
        .prepare(
          "SELECT id, name, command FROM ssh_shortcuts WHERE machine_id = ? ORDER BY id",
        )
        .all(id(req)),
    }),
  );
  router.post("/shortcuts", (req, res) => {
    const body = Shortcut.parse(req.body);
    if (
      (
        db
          .prepare(
            "SELECT COUNT(*) as n FROM ssh_shortcuts WHERE machine_id = ?",
          )
          .get(id(req)) as { n: number }
      ).n >= 100
    )
      throw new WorkspaceError(409, "shortcut_limit");
    const info = db
      .prepare(
        "INSERT INTO ssh_shortcuts(machine_id, name, command, updated_at) VALUES (?, ?, ?, ?)",
      )
      .run(id(req), body.name, body.command, Date.now());
    res.status(201).json({ id: Number(info.lastInsertRowid) });
  });
  router.put("/shortcuts/:shortcutId", (req, res) => {
    const body = Shortcut.parse(req.body);
    const changed = db
      .prepare(
        "UPDATE ssh_shortcuts SET name = ?, command = ?, updated_at = ? WHERE id = ? AND machine_id = ?",
      )
      .run(
        body.name,
        body.command,
        Date.now(),
        Number(req.params.shortcutId),
        id(req),
      );
    if (!changed.changes) throw new WorkspaceError(404, "not_found");
    res.json({ ok: true });
  });
  router.delete("/shortcuts/:shortcutId", (req, res) => {
    db.prepare("DELETE FROM ssh_shortcuts WHERE id = ? AND machine_id = ?").run(
      Number(req.params.shortcutId),
      id(req),
    );
    res.json({ ok: true });
  });
  router.get(
    "/products",
    route(async (req, res) =>
      res.json(
        await withFiles(
          db,
          id(req),
          secret,
          (files) => files.discover(),
          requestSignal(res),
        ),
      ),
    ),
  );
  router.get(
    "/files",
    route(async (req, res) => {
      const path = z.string().parse(req.query.path ?? "/");
      res.json(
        await withFiles(
          db,
          id(req),
          secret,
          (files) => files.list(path),
          requestSignal(res),
        ),
      );
    }),
  );
  router.get(
    "/file",
    route(async (req, res) => {
      const path = z.string().parse(req.query.path);
      res.json(
        await withFiles(
          db,
          id(req),
          secret,
          (files) => files.text(path),
          requestSignal(res),
        ),
      );
    }),
  );
  router.get(
    "/resolve",
    route(async (req, res) => {
      const target = z.string().parse(req.query.path);
      res.json(
        await withFiles(
          db,
          id(req),
          secret,
          (files) => files.resolve(target),
          requestSignal(res),
        ),
      );
    }),
  );
  router.put(
    "/file",
    route(async (req, res) => {
      const body = Write.parse(req.body);
      if (Buffer.byteLength(body.content) > TEXT_LIMIT)
        throw new WorkspaceError(413, "file_too_large");
      const result = await withFiles(
        db,
        id(req),
        secret,
        async (files) => {
          const actual = await files.confined("/", body.path, true);
          return lockedWrite(id(req), actual, () =>
            files.write(actual, Buffer.from(body.content), body.revision),
          );
        },
        requestSignal(res),
      );
      audit(
        db,
        id(req),
        uid(req),
        "file_save",
        result.path,
        result.backup ?? "created",
      );
      res.json(result);
    }),
  );
  router.post(
    "/upload",
    express.raw({ type: "application/octet-stream", limit: FILE_LIMIT }),
    route(async (req, res) => {
      const target = remotePath(z.string().parse(req.query.path));
      if (!Buffer.isBuffer(req.body))
        throw new WorkspaceError(400, "binary_body_required");
      const data: Buffer = req.body;
      const result = await withFiles(
        db,
        id(req),
        secret,
        async (files) => {
          const actual = await files.confined("/", target, true);
          return lockedWrite(id(req), actual, () =>
            files.write(actual, data, null),
          );
        },
        requestSignal(res),
      );
      audit(db, id(req), uid(req), "file_upload", target);
      res.json(result);
    }),
  );
  router.get(
    "/download",
    route(async (req, res) => {
      const target = remotePath(z.string().parse(req.query.path));
      const file = await withFiles(
        db,
        id(req),
        secret,
        (files) => files.read(target, FILE_LIMIT),
        requestSignal(res),
      );
      res.setHeader("content-type", "application/octet-stream");
      res.setHeader(
        "content-disposition",
        `attachment; filename*=UTF-8''${encodeURIComponent(target.split("/").pop() ?? "download")}`,
      );
      res.send(file.data);
    }),
  );
  router.get("/audit", (req, res) =>
    res.json({
      events: db
        .prepare(
          "SELECT action, path, detail, at FROM workspace_audit WHERE machine_id = ? ORDER BY id DESC LIMIT 100",
        )
        .all(id(req)),
    }),
  );
  return router;
}
