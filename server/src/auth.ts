import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { z } from "zod";

export type JwtUser = {
  id: number;
  username: string;
  role: string;
  version?: number;
  /** Issued-at / expiry, as set by `jwt.sign`. */
  iat?: number;
  exp?: number;
};

/** How long a login lasts before it has to be renewed. */
export const TOKEN_TTL_SEC = 7 * 24 * 60 * 60;

/** A session in active use is renewed once it has less than this left. */
export const TOKEN_RENEW_WITHIN_SEC = 3 * 24 * 60 * 60;

export function hashPassword(password: string) {
  return bcrypt.hash(password, 12);
}

export function verifyPassword(password: string, passwordHash: string) {
  return bcrypt.compare(password, passwordHash);
}

export function hashAgentKey(agentKey: string, secret: string) {
  return `sha256:${crypto.createHmac("sha256", secret).update(agentKey).digest("hex")}`;
}

export async function verifyAgentKey(agentKey: string, storedHash: string, secret: string) {
  if (storedHash.startsWith("$2")) {
    return bcrypt.compare(agentKey, storedHash);
  }
  if (!storedHash.startsWith("sha256:")) return false;
  const expectedHex = storedHash.slice("sha256:".length);
  const actualHex = crypto.createHmac("sha256", secret).update(agentKey).digest("hex");
  if (!/^[0-9a-f]{64}$/i.test(expectedHex) || expectedHex.length !== actualHex.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expectedHex, "hex"), Buffer.from(actualHex, "hex"));
}

export function signToken(payload: JwtUser, secret: string) {
  return jwt.sign(payload, secret, { algorithm: "HS256", expiresIn: TOKEN_TTL_SEC });
}

export function verifyToken(token: string, secret: string): JwtUser {
  const decoded = jwt.verify(token, secret, { algorithms: ["HS256"] });
  return JwtUserSchema.parse(decoded);
}

/**
 * Keeps an actively used login alive: the cached token is replaced with a fresh
 * one while there is still time left, so an operator who opens the panel at
 * least once a week is never signed out mid-task. A token without an expiry
 * (or one that is already invalid) is left alone.
 */
export function needsRenewal(
  exp: number | null | undefined,
  now: number = Date.now(),
): boolean {
  if (typeof exp !== "number" || !Number.isFinite(exp)) return false;
  return exp - now / 1000 < TOKEN_RENEW_WITHIN_SEC;
}

const JwtUserSchema = z.object({
  id: z.number().int().positive(),
  username: z.string().min(1),
  role: z.string().min(1),
  version: z.number().int().nonnegative().default(0),
  iat: z.number().optional(),
  exp: z.number().optional(),
});
