import { apiFetch } from "./api";
import { clearToken, getToken, setToken, tokenPersisted } from "./auth";

export type SessionUser = { id: number; username: string; role: string };

let current: { token: string; user: SessionUser } | null = null;
let pending: Promise<SessionUser> | null = null;

/** The verified user of the cached login, or null before the first check. */
export function currentUser(): SessionUser | null {
  return current?.user ?? null;
}

/**
 * Only local URLs may be used as a post-login redirect, so `?next=` cannot be
 * turned into an open redirect.
 */
export function safeNext(raw: string | null | undefined): string | null {
  if (typeof raw !== "string" || !raw.startsWith("/")) return null;
  if (raw.startsWith("//") || raw.includes("\\")) return null;
  return raw;
}

/**
 * Checks a cached login with the server and remembers the answer for this page
 * load. While the session is in use the server slides its expiry forward and
 * hands out a replacement token, so an active operator is not signed out.
 */
export function loadSession(): Promise<SessionUser> {
  const token = getToken();
  if (!token) return Promise.reject(new Error("missing_token"));
  if (current && current.token === token) return Promise.resolve(current.user);
  if (pending) return pending;
  const persist = tokenPersisted();
  pending = apiFetch<{ user: SessionUser; token?: string }>("/api/me")
    .then((res) => {
      if (res.token && res.token !== token) setToken(res.token, persist);
      current = { token: res.token ?? token, user: res.user };
      return res.user;
    })
    .finally(() => {
      pending = null;
    });
  return pending;
}

export function forgetSession() {
  current = null;
  pending = null;
  clearToken();
}
