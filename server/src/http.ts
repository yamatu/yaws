import type { NextFunction, Request, Response } from "express";
import { verifyToken, type JwtUser } from "./auth.js";

export type AuthedRequest = Request & { user: JwtUser };

export function authMiddleware(jwtSecret: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    const auth = req.header("authorization") ?? "";
    const m = auth.match(/^Bearer (.+)$/);
    if (!m) return res.status(401).json({ error: "missing_token" });
    try {
      const user = verifyToken(m[1], jwtSecret);
      (req as AuthedRequest).user = user;
      next();
    } catch {
      return res.status(401).json({ error: "invalid_token" });
    }
  };
}

