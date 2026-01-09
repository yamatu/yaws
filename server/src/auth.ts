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

export function signToken(payload: JwtUser, secret: string) {
  return jwt.sign(payload, secret, { expiresIn: "7d" });
}

export function verifyToken(token: string, secret: string): JwtUser {
  const decoded = jwt.verify(token, secret);
  return JwtUserSchema.parse(decoded);
}

const JwtUserSchema = z.object({
  id: z.number().int().positive(),
  username: z.string().min(1),
  role: z.string().min(1),
  iat: z.number().optional(),
  exp: z.number().optional(),
});

