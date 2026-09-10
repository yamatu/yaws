import type { NextFunction, Request, Response } from "express";
import { verifyToken, type JwtUser } from "./auth.js";
import type { Db } from "./db.js";

declare module "express-serve-static-core" {
  interface Request { user?: JwtUser; }
}

export type AuthedRequest = Request & { user: JwtUser };

export function currentUser(db: Db, token: string, secret: string): JwtUser {
  const user = verifyToken(token, secret);
  const row = db.prepare("SELECT id, username, role, auth_version as version FROM users WHERE id = ?").get(user.id) as JwtUser | undefined;
  if (!row || row.version !== (user.version ?? 0)) throw new Error("invalid_token");
  return row;
}

export function authMiddleware(jwtSecret: string, db: Db) {
  return (req: Request, res: Response, next: NextFunction) => {
    const auth = req.header("authorization") ?? "";
    const m = auth.match(/^Bearer (.+)$/);
    if (!m) return res.status(401).json({ error: "missing_token" });
    try {
      const user = currentUser(db, m[1], jwtSecret);
      (req as AuthedRequest).user = user;
      next();
    } catch {
      return res.status(401).json({ error: "invalid_token" });
    }
  };
}

