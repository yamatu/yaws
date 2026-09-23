import { z } from "zod";
import { decryptText, encryptText } from "./crypto.js";
import type { Db } from "./db.js";

/**
 * Model endpoints are stored as named profiles so one deployment can keep
 * several providers (for example a fast flash model and a stronger one).
 * Every helper here is pure apart from the two settings-table readers, which
 * makes the merge rules testable without Express.
 */
export const AIConfigSchema = z.object({
  baseUrl: z.string().url().max(2048),
  protocol: z.enum(["chat", "responses"]).default("chat"),
  model: z.string().trim().min(1).max(200),
  reasoning: z
    .string()
    .max(32)
    .regex(/^[a-z0-9_-]*$/)
    .default(""),
  apiKey: z.string().max(4096).default(""),
  allowPrivate: z.boolean().default(false),
  /** Empty for custom API keys; official providers use pi's native transport. */
  officialProvider: z.string().max(40).default(""),
});
export type AIConfig = z.infer<typeof AIConfigSchema>;

export const AIProfileSchema = AIConfigSchema.extend({
  id: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_-]{1,64}$/),
  name: z.string().trim().min(1).max(60),
});
export type AIProfile = z.infer<typeof AIProfileSchema>;
export type LoadedProfile = { id: string; name: string; config: AIConfig };

/** `apiKey: null` clears the stored key, an empty or missing key keeps it. */
export const AIProfileInputSchema = AIProfileSchema.extend({
  apiKey: z.string().max(4096).nullish(),
});
export type AIProfileInput = z.infer<typeof AIProfileInputSchema>;

export const MAX_PROFILES = 20;
const CONFIG_KEY = "ai_config_enc";
const PROFILES_KEY = "ai_profiles_enc";
const ACTIVE_KEY = "ai_active_profile";
export const DEFAULT_PROFILE_ID = "default";
export const DEFAULT_PROFILE_NAME = "默认配置";

function setting(db: Db, key: string): string {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? "";
}

function put(db: Db, key: string, value: string) {
  db.prepare(
    "INSERT INTO settings (key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
  ).run(key, value, Date.now());
}

/**
 * Rejects endpoints that carry credentials, query strings or fragments, or
 * that are not plain http(s) — the same rule `modelRequest` enforces later.
 */
export function endpointError(baseUrl: string): "bad_ai_endpoint" | null {
  let endpoint: URL;
  try {
    endpoint = new URL(baseUrl);
  } catch {
    return "bad_ai_endpoint";
  }
  if (
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    !["https:", "http:"].includes(endpoint.protocol)
  )
    return "bad_ai_endpoint";
  return null;
}

/** Stored profiles, falling back to the single config older releases wrote. */
export function readProfiles(db: Db, secret: string): AIProfile[] {
  const stored = setting(db, PROFILES_KEY);
  if (stored) {
    try {
      return z
        .array(AIProfileSchema)
        .max(MAX_PROFILES)
        .parse(JSON.parse(decryptText(stored, secret)));
    } catch {
      // A corrupt value must not brick the workspace: fall through to the
      // legacy single config, which the operator can still edit.
    }
  }
  const legacy = setting(db, CONFIG_KEY);
  if (!legacy) return [];
  try {
    const config = AIConfigSchema.parse(JSON.parse(decryptText(legacy, secret)));
    return [
      { id: DEFAULT_PROFILE_ID, name: DEFAULT_PROFILE_NAME, ...config },
    ];
  } catch {
    return [];
  }
}

export function writeProfiles(
  db: Db,
  secret: string,
  profiles: AIProfile[],
  activeId: string,
) {
  if (!profiles.length) {
    // Keep the legacy key as the source of truth when everything is deleted.
    put(db, PROFILES_KEY, encryptText(JSON.stringify([]), secret));
    return;
  }
  put(db, PROFILES_KEY, encryptText(JSON.stringify(profiles), secret));
  put(
    db,
    ACTIVE_KEY,
    profiles.some((p) => p.id === activeId) ? activeId : profiles[0].id,
  );
}

export function activeProfileId(db: Db): string {
  return setting(db, ACTIVE_KEY);
}

/** Prefer the requested profile, then the active one, then the first. */
export function pickProfile(
  profiles: AIProfile[],
  activeId: string,
  want = "",
): AIProfile | undefined {
  return (
    profiles.find((p) => p.id === want) ??
    profiles.find((p) => p.id === activeId) ??
    profiles[0]
  );
}

/**
 * A profile edit never returns the stored key, so an empty key means "keep
 * what is already saved" and `null` means "remove it".
 */
export function mergeProfileKeys(
  next: AIProfileInput[],
  previous: AIProfile[],
): AIProfile[] {
  return next.map(({ apiKey, ...rest }) => {
    const old = previous.find((p) => p.id === rest.id);
    return {
      ...rest,
      apiKey: apiKey === null ? "" : apiKey || old?.apiKey || "",
    };
  });
}

export function publicProfiles(profiles: AIProfile[], activeId: string) {
  const active = profiles.some((p) => p.id === activeId)
    ? activeId
    : (profiles[0]?.id ?? "");
  return {
    activeId: active,
    profiles: profiles.map((p) => ({
      id: p.id,
      name: p.name,
      baseUrl: p.baseUrl,
      protocol: p.protocol,
      model: p.model,
      reasoning: p.reasoning,
      allowPrivate: p.allowPrivate,
      officialProvider: p.officialProvider,
      hasKey: !!p.apiKey,
    })),
  };
}
