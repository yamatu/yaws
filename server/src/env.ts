import { z } from "zod";

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3001),
  DATABASE_PATH: z.string().default("./data/yaws.sqlite"),
  JWT_SECRET: z.string().min(16).default("dev-secret-change-me-please"),
  BOOTSTRAP_TOKEN: z.string().optional(),
  AGENT_KEY_SECRET: z.string().min(16).optional(),
  AGENT_KEY_SECRET_PREVIOUS: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().min(16).optional()
  ),
  // Empty means "no cross-origin API access" (the dashboard is served same-origin in
  // production). Development falls back to the Vite dev server origin.
  CORS_ORIGIN: z.string().default(""),
  // Number of reverse proxies in front of the app ("1" for the documented nginx setup,
  // "0" when the port is exposed directly). Controls how X-Forwarded-For is trusted.
  TRUST_PROXY: z.string().default("1"),
  METRICS_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(30),
  METRICS_PRUNE_INTERVAL_MIN: z.coerce.number().int().min(1).max(1440).default(10),
  ADMIN_RESTORE_MAX_MB: z.coerce.number().int().min(1).max(102400).default(2048),
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_CHAT_ID: z.string().optional(),
  AGENT_GITHUB_REPO: z.string().default("yamatu/yaws"),
  AGENT_RELEASE_BASE_URL: z.string().optional(),
});

export type Env = z.infer<typeof EnvSchema>;

/**
 * Translate the TRUST_PROXY setting into the value express accepts. Accepts a hop count
 * ("1"), a named range ("loopback", "linklocal", "uniquelocal") or "0"/"none" to disable.
 */
export function parseTrustProxy(value: string): boolean | number | string {
  const text = value.trim().toLowerCase();
  if (text === "" || text === "0" || text === "false" || text === "off" || text === "none")
    return false;
  if (/^\d+$/.test(text)) return Number(text);
  return text;
}

export function loadEnv(): Env {
  const env = EnvSchema.parse(process.env);
  if (env.NODE_ENV === "production") {
    const insecureSecrets = new Set([
      "dev-secret-change-me-please",
      "change-me-please-min-16-chars",
      "qwertyuioppoiuytr",
    ]);
    if (insecureSecrets.has(env.JWT_SECRET) || env.JWT_SECRET.toLowerCase().startsWith("change-me")) {
      throw new Error("JWT_SECRET must be replaced with a random secret in production");
    }
    if (Buffer.byteLength(env.JWT_SECRET, "utf8") < 32) {
      throw new Error(
        "JWT_SECRET must be at least 32 characters in production (generate with: openssl rand -hex 32)"
      );
    }
    if (
      env.AGENT_KEY_SECRET &&
      (insecureSecrets.has(env.AGENT_KEY_SECRET) || env.AGENT_KEY_SECRET.toLowerCase().startsWith("change-me"))
    ) {
      throw new Error("AGENT_KEY_SECRET must be replaced with a random secret in production");
    }
    if (env.AGENT_KEY_SECRET && Buffer.byteLength(env.AGENT_KEY_SECRET, "utf8") < 32) {
      throw new Error(
        "AGENT_KEY_SECRET must be at least 32 characters in production (generate with: openssl rand -hex 32)"
      );
    }
  }
  return env;
}
