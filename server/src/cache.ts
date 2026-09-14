/**
 * Tiny in-process TTL caches for unauthenticated endpoints.
 *
 * `/api/public/*` is reachable without credentials, so any work done there can be
 * amplified by anyone with a loop. These helpers keep the per-second cost of repeated
 * identical probes bounded without changing the payload the dashboard sees (it polls
 * every few seconds anyway). They are intentionally not a general caching layer: the
 * values are small, machine scoped and expire within a second or two.
 */

export function ttlValue<V>(ttlMs: number, build: () => V) {
  const store = ttlStore<V>(ttlMs);
  return (): V => {
    const hit = store.get();
    if (hit !== undefined) return hit;
    const value = build();
    store.set(value);
    return value;
  };
}

/** Single value get/set cache, for handlers whose body is long but cheap to read. */
export function ttlStore<V>(ttlMs: number) {
  let cachedAt = 0;
  let cached: V | undefined;
  return {
    get(): V | undefined {
      if (cached !== undefined && Date.now() - cachedAt < ttlMs) return cached;
      return undefined;
    },
    set(value: V) {
      cached = value;
      cachedAt = Date.now();
    },
  };
}

/** Keyed get/set cache with a hard entry limit so a hostile key space cannot grow it. */
export function ttlKeyedStore<K, V>(ttlMs: number, maxEntries: number) {
  const store = new Map<K, { at: number; value: V }>();
  return {
    get(key: K): V | undefined {
      const hit = store.get(key);
      if (hit && Date.now() - hit.at < ttlMs) return hit.value;
      return undefined;
    },
    set(key: K, value: V) {
      if (store.has(key)) store.delete(key);
      store.set(key, { at: Date.now(), value });
      while (store.size > Math.max(1, maxEntries)) {
        const oldest = store.keys().next().value as K | undefined;
        if (oldest === undefined) break;
        store.delete(oldest);
      }
    },
  };
}

