import { z } from "zod";

const EnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3001),
  DATABASE_PATH: z.string().default("./data/yaws.sqlite"),
  JWT_SECRET: z.string().min(16).default("dev-secret-change-me-please"),
  AGENT_KEY_SECRET: z.string().min(16).optional(),
  CORS_ORIGIN: z.string().default("http://localhost:5173"),
  METRICS_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(30),
  METRICS_PRUNE_INTERVAL_MIN: z.coerce.number().int().min(1).max(1440).default(10),
  ADMIN_RESTORE_MAX_MB: z.coerce.number().int().min(1).max(102400).default(2048),
  AGENT_GITHUB_REPO: z.string().default("yamatu/yaws"),
  AGENT_RELEASE_BASE_URL: z.string().optional(),
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(): Env {
  return EnvSchema.parse(process.env);
}
