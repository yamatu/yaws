/**
 * Login cache. The token is kept in `localStorage` when the operator asked to
 * stay signed in (it survives closing the browser) and in `sessionStorage`
 * otherwise, so a shared machine forgets the session when the tab is closed.
 */
const TOKEN_KEY = "yaws_token";
const USER_KEY = "yaws.login.user";
const REMEMBER_KEY = "yaws.login.remember";

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** Storage can throw (private mode, disabled cookies) — never break the app. */
function safely<T>(run: (store: Store) => T, fallback: T): T {
  try {
    return run(localStorage);
  } catch {
    return fallback;
  }
}

function stores(): Store[] {
  const list: Store[] = [];
  for (const name of ["localStorage", "sessionStorage"] as const) {
    try {
      const store = globalThis[name];
      if (store) list.push(store);
    } catch {
      // ignore: the store is unavailable in this context
    }
  }
  return list;
}

function read(key: string): string | null {
  for (const store of stores()) {
    try {
      const value = store.getItem(key);
      if (value) return value;
    } catch {
      // ignore unreadable stores
    }
  }
  return null;
}

function write(key: string, value: string, persist: boolean) {
  const target = persist ? "localStorage" : "sessionStorage";
  for (const name of ["localStorage", "sessionStorage"] as const) {
    try {
      const store = globalThis[name];
      if (!store) continue;
      if (name === target) store.setItem(key, value);
      else store.removeItem(key);
    } catch {
      // ignore: keep the other store in sync if one of them is unavailable
    }
  }
}

function drop(key: string) {
  for (const store of stores()) {
    try {
      store.removeItem(key);
    } catch {
      // ignore
    }
  }
}

export function getToken(): string | null {
  return read(TOKEN_KEY);
}

/** `persist` false keeps the login only until the browser is closed. */
export function setToken(token: string, persist = true) {
  write(TOKEN_KEY, token, persist);
}

export function clearToken() {
  drop(TOKEN_KEY);
}

/** True when the current token lives in `localStorage`. */
export function tokenPersisted(): boolean {
  const token = getToken();
  if (!token) return false;
  return safely((store) => store.getItem(TOKEN_KEY) === token, false);
}

/** Pre-fills the login form so the operator only types a password. */
export function rememberUsername(username: string, persist = true) {
  const clean = username.trim();
  if (!clean) return;
  write(USER_KEY, clean, persist);
}

export function rememberedUsername(): string {
  return read(USER_KEY) ?? "";
}

export function forgetUsername() {
  drop(USER_KEY);
}

/** The "stay signed in" checkbox remembers its last answer. */
export function rememberPersist(): boolean {
  const raw = read(REMEMBER_KEY);
  return raw === null ? true : raw === "1";
}

export function setRememberPersist(persist: boolean) {
  write(REMEMBER_KEY, persist ? "1" : "0", true);
}
