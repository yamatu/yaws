import type { Machine } from "./api";

/** How many relays one connection may cross. Mirrors MAX_SSH_HOPS on the server. */
export const MAX_VIA_DEPTH = 2;

type ViaHost = Pick<Machine, "id" | "name"> & { viaMachineId?: number };

/**
 * Relay ids used to reach `id`, outermost last: `[..., id]`. Stops when a chain
 * loops instead of spinning, so a half-broken list cannot hang the picker.
 */
export function viaChain(hosts: ViaHost[], id: number): number[] {
  const byId = new Map(hosts.map((h) => [h.id, h]));
  const chain = [id];
  const seen = new Set([id]);
  let current = byId.get(id);
  while (current?.viaMachineId) {
    const via = current.viaMachineId;
    if (seen.has(via) || !byId.has(via)) break;
    seen.add(via);
    chain.push(via);
    current = byId.get(via);
  }
  return chain;
}

/** Names of the relays above `id`, outermost first, without `id` itself. */
export function viaNames(hosts: ViaHost[], id: number): string[] {
  const byId = new Map(hosts.map((h) => [h.id, h]));
  return viaChain(hosts, id)
    .slice(1)
    .map((hop) => byId.get(hop)?.name ?? `#${hop}`)
    .reverse();
}

/** "经由 A → B" for a badge, or "" when the host is connected directly. */
export function viaLabel(hosts: ViaHost[], id: number): string {
  const names = viaNames(hosts, id);
  return names.length ? `经由 ${names.join(" → ")}` : "";
}

/**
 * Hosts that may serve as the relay of `id`. `keep` is the relay already stored
 * on `id`: it stays in the list even if it may no longer be chosen (for example
 * because another machine was later put in front of it), so the picker shows the
 * real setting instead of falling back to "直连".
 */
export function viaCandidates<T extends ViaHost>(
  hosts: T[],
  id: number,
  keep = 0,
): T[] {
  return hosts.filter((host) => {
    if (host.id === id) return false;
    if (host.id === keep) return true;
    // Naming a host that already reaches us would close a loop…
    if (viaChain(hosts, host.id).includes(id)) return false;
    // …and stacking on top of a two-hop chain would be one relay too many.
    return viaChain(hosts, host.id).length - 1 < MAX_VIA_DEPTH;
  });
}

/** Hosts that are reached through `id` and can be opened from its terminal. */
export function viaChildren<T extends ViaHost>(hosts: T[], id: number): T[] {
  return hosts.filter((host) => host.viaMachineId === id);
}
