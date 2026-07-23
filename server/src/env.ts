import { z } from "zod";

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3001),
  DATABASE_PATH: z.string().default("./data/yaws.sqlite"),
  JWT_SECRET: z.string().min(16).default("dev-secret-change-me-please"),
  AGENT_KEY_SECRET: z.string().min(16).optional(),
  AGENT_KEY_SECRET_PREVIOUS: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().min(16).optional()
  ),
  CORS_ORIGIN: z.string().default("http://localhost:5173"),
  METRICS_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(30),
  METRICS_PRUNE_INTERVAL_MIN: z.coerce.number().int().min(1).max(1440).default(10),
  ADMIN_RESTORE_MAX_MB: z.coerce.number().int().min(1).max(102400).default(2048),
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_CHAT_ID: z.string().optional(),
  AGENT_GITHUB_REPO: z.string().default("yamatu/yaws"),
  AGENT_RELEASE_BASE_URL: z.string().optional(),
});

export type Env = z.infer<typeof EnvSchema>;

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
    if (
      env.AGENT_KEY_SECRET &&
      (insecureSecrets.has(env.AGENT_KEY_SECRET) || env.AGENT_KEY_SECRET.toLowerCase().startsWith("change-me"))
    ) {
      throw new Error("AGENT_KEY_SECRET must be replaced with a random secret in production");
    }
  }
  return env;
}
