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
  /**
   * `chat` and `responses` are the two OpenAI wire formats; `anthropic` is the
   * Claude Messages API, which needs its own endpoint and request shape.
   */
  protocol: z.enum(["chat", "responses", "anthropic"]).default("chat"),
  model: z.string().trim().min(1).max(200),
  reasoning: z
    .string()
    .max(32)
    .regex(/^[a-z0-9_-]*$/)
    .default(""),
  /**
   * OpenAI's processing tier, which is what the operator means by "output
   * speed". Empty lets the provider decide; `priority` (Fast mode) is faster
   * for roughly twice the token price, `flex` is about half price but slower,
   * and `ultrafast` is the access-controlled tier for models such as
   * gpt-5.6-sol. Requested as `service_tier`; providers that do not support it
   * are simply left on the default when this stays empty.
   */
  speed: z
    .enum([
      "",
      "auto",
      "default",
      "flex",
      "scale",
      "priority",
      "fast",
      "ultrafast",
    ])
    .default(""),
  apiKey: z.string().max(4096).default(""),
  allowPrivate: z.boolean().default(false),
  /**
   * Serve the Anthropic protocol as the official Claude Code client instead of
   * as yaws: its identity headers, beta list and a real CLI system prompt (see
   * `claudeCodeBody` in `ai-anthropic.ts`). Relays that resell a Claude Code
   * subscription gate on that; a plain Messages API everywhere else.
   */
  claudeCode: z.boolean().default(false),
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
/**
 * Machine id → profile id, as JSON.
 *
 * One chat turn belongs to one host, so the model it uses does too: picking a
 * model on server A must not redirect the answers of server B. `ACTIVE_KEY`
 * stays the fallback for callers that are not about a single machine (the
 * legacy settings endpoints, and rows written before this map existed).
 */
const ACTIVE_BY_MACHINE_KEY = "ai_active_profile_by_machine";
const ActiveByMachineSchema = z.record(
  z.string().regex(/^\d+$/),
  z.string().max(64),
);
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

function activeByMachine(db: Db): Record<string, string> {
  try {
    return ActiveByMachineSchema.parse(
      JSON.parse(setting(db, ACTIVE_BY_MACHINE_KEY)),
    );
  } catch {
    // A corrupt map only costs the per-machine choices, never the profiles.
    return {};
  }
}

/** Writes the map as JSON; `writeProfiles` prunes ids of deleted profiles. */
function writeActiveByMachine(db: Db, map: Record<string, string>) {
  put(db, ACTIVE_BY_MACHINE_KEY, JSON.stringify(map));
}

export function writeProfiles(
  db: Db,
  secret: string,
  profiles: AIProfile[],
  activeId: string,
  machineId = 0,
) {
  if (!profiles.length) {
    // Keep the legacy key as the source of truth when everything is deleted.
    put(db, PROFILES_KEY, encryptText(JSON.stringify([]), secret));
    writeActiveByMachine(db, {});
    return;
  }
  put(db, PROFILES_KEY, encryptText(JSON.stringify(profiles), secret));
  const chosen = profiles.some((p) => p.id === activeId)
    ? activeId
    : profiles[0].id;
  put(db, ACTIVE_KEY, chosen);
  const kept = new Set(profiles.map((p) => p.id));
  const map = Object.fromEntries(
    Object.entries(activeByMachine(db)).filter(([, id]) => kept.has(id)),
  );
  if (machineId > 0) map[String(machineId)] = chosen;
  writeActiveByMachine(db, map);
}

/**
 * The profile a caller falls back to when it names none of its own. Asking for
 * a machine returns that machine's choice; anything else gets the shared one.
 */
export function activeProfileId(db: Db, machineId = 0): string {
  if (machineId > 0) {
    const chosen = activeByMachine(db)[String(machineId)];
    if (chosen) return chosen;
  }
  return setting(db, ACTIVE_KEY);
}

/** Remembers the model one machine picked without touching the others. */
export function setActiveProfileId(db: Db, id: string, machineId = 0) {
  if (machineId <= 0) {
    put(db, ACTIVE_KEY, id);
    return;
  }
  writeActiveByMachine(db, {
    ...activeByMachine(db),
    [String(machineId)]: id,
  });
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
      speed: p.speed,
      allowPrivate: p.allowPrivate,
      claudeCode: p.claudeCode,
      officialProvider: p.officialProvider,
      hasKey: !!p.apiKey,
    })),
  };
}
