import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { z } from "zod";

export type JwtUser = {
  id: number;
  username: string;
  role: string;
};

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
  return jwt.sign(payload, secret, { algorithm: "HS256", expiresIn: "7d" });
}

export function verifyToken(token: string, secret: string): JwtUser {
  const decoded = jwt.verify(token, secret, { algorithms: ["HS256"] });
  return JwtUserSchema.parse(decoded);
}

const JwtUserSchema = z.object({
  id: z.number().int().positive(),
  username: z.string().min(1),
  role: z.string().min(1),
  iat: z.number().optional(),
  exp: z.number().optional(),
});
