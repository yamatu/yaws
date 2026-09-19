import type { Db } from "./db.js";
import {
  WorkspaceError,
  address,
  credentialState,
  hostTrusted,
  sshMachine,
  type CredentialState,
  type SshMachine,
} from "./ssh.js";

/**
 * How many hosts one conversation may work on: the machine the chat was opened
 * from (the primary host) plus the extra ones the operator ticks in the UI.
 * Eight is a hand-picked number: it is large enough for a real cluster and
 * small enough that one careless "run this everywhere" stays a reviewable
 * action instead of a fleet-wide accident.
 */
export const MAX_CHAT_HOSTS = 8;
/**
 * SSH sessions one `run_on_hosts` call opens at a time. A fan-out to every host
 * at once would exhaust the server's connection limits (and the remote
 * sshd's MaxStartups) exactly when the operator is investigating a problem.
 */
export const HOST_FANOUT = 4;
/** Output kept per host in a fan-out result, before the answer is assembled. */
export const HOST_OUTPUT_LIMIT = 4_000;

/** One server the assistant is allowed to touch in this conversation. */
export type ChatHost = {
  id: number;
  name: string;
  /** `host:port` — shown to the operator, never trusted as a shell word. */
  address: string;
  online: boolean;
  /** The stored host key still matches this address, so SSH is usable. */
  trusted: boolean;
  credentials: CredentialState;
};

/** The label used in prompts, tool arguments and transcript cards. */
export function hostLabel(host: ChatHost) {
  return `${host.name} (#${host.id})`;
}

/**
 * One host as the assistant sees it. Existence and SSH configuration are
 * checked here so a conversation can never hold a host the workspace tools
 * would refuse to open anyway.
 */
export function chatHost(db: Db, secret: string, id: number): ChatHost {
  const machine: SshMachine = sshMachine(db, id);
  const row = db
    .prepare("SELECT online FROM machines WHERE id = ?")
    .get(id) as { online: number } | undefined;
  return {
    id: machine.id,
    name: machine.name,
    address: address(machine),
    online: Boolean(row?.online),
    trusted: hostTrusted(machine),
    credentials: credentialState(machine, secret),
  };
}

/**
 * The full host list of a conversation: the primary machine first, then the
 * stored extras in the order they were saved. `extraIds` are validated, so a
 * machine that was deleted (or lost its SSH configuration) drops out with a
 * readable error instead of failing halfway through a tool call.
 */
export function listChatHosts(
  db: Db,
  secret: string,
  primaryId: number,
  extraIds: number[],
): ChatHost[] {
  const primary = chatHost(db, secret, primaryId);
  const hosts = [primary];
  for (const id of extraIds) {
    if (id === primary.id || hosts.some((host) => host.id === id)) continue;
    if (hosts.length >= MAX_CHAT_HOSTS) break;
    hosts.push(chatHost(db, secret, id));
  }
  return hosts;
}

/** Stored extra host ids of a conversation, in insertion order. */
export function conversationHostIds(db: Db, conversationId: string): number[] {
  const rows = db
    .prepare(
      "SELECT machine_id FROM ai_conversation_hosts WHERE conversation_id = ? ORDER BY rowid",
    )
    .all(conversationId) as Array<{ machine_id: number }>;
  return rows.map((row) => row.machine_id);
}

/**
 * Replaces the stored host set. `undefined` means "the request did not talk
 * about hosts" and keeps whatever the conversation already had — that is what
 * makes an old client (or a stored conversation opened before the feature) keep
 * working. An empty array deliberately clears the extras.
 */
export function saveConversationHosts(
  db: Db,
  conversationId: string,
  primaryId: number,
  ids: number[] | undefined,
): number[] {
  if (ids === undefined) return conversationHostIds(db, conversationId);
  const unique = [...new Set(ids)]
    .filter((id) => id !== primaryId)
    .slice(0, MAX_CHAT_HOSTS - 1);
  db.prepare("DELETE FROM ai_conversation_hosts WHERE conversation_id = ?").run(
    conversationId,
  );
  const insert = db.prepare(
    "INSERT OR IGNORE INTO ai_conversation_hosts(conversation_id,machine_id,created_at) VALUES (?,?,?)",
  );
  for (const id of unique) insert.run(conversationId, id, Date.now());
  return conversationHostIds(db, conversationId);
}

function looksLikeId(text: string) {
  return /^#?\d+$/.test(text);
}

/**
 * Turns the `host` a model passed into a real host. Anything that is not part
 * of this conversation's set is refused: a hallucinated machine id must never
 * become an SSH connection to a server the operator did not select.
 */
export function resolveHost(hosts: ChatHost[], ref: unknown): ChatHost {
  if (!hosts.length) throw new WorkspaceError(409, "host_not_configured");
  if (ref === undefined || ref === null || ref === "") return hosts[0];
  if (typeof ref === "number" || (typeof ref === "string" && looksLikeId(ref.trim()))) {
    const id = typeof ref === "number" ? ref : Number(ref.trim().replace(/^#/, ""));
    const found = hosts.find((host) => host.id === id);
    if (!found) throw new WorkspaceError(400, "host_not_found");
    return found;
  }
  if (typeof ref !== "string") throw new WorkspaceError(400, "host_not_found");
  const text = ref.trim().toLowerCase();
  const matches = hosts.filter((host) => host.name.trim().toLowerCase() === text);
  if (matches.length === 1) return matches[0];
  // Two servers may share a display name; guessing would run the command on
  // the wrong one, so the model is told to use the id instead.
  if (matches.length > 1) throw new WorkspaceError(409, "host_ambiguous");
  throw new WorkspaceError(400, "host_not_found");
}

/** Every host a fan-out tool was pointed at. No reference means all of them. */
export function resolveHosts(hosts: ChatHost[], ref: unknown): ChatHost[] {
  if (!hosts.length) throw new WorkspaceError(409, "host_not_configured");
  if (ref === undefined || ref === null || ref === "")
    return hosts.slice(0, MAX_CHAT_HOSTS);
  if (typeof ref === "string") {
    const text = ref.trim().toLowerCase();
    if (!text || text === "*" || text === "all" || text === "全部")
      return hosts.slice(0, MAX_CHAT_HOSTS);
  }
  const list = Array.isArray(ref) ? ref : [ref];
  if (!list.length) return hosts.slice(0, MAX_CHAT_HOSTS);
  if (list.length > MAX_CHAT_HOSTS) throw new WorkspaceError(400, "too_many_hosts");
  const seen = new Set<number>();
  const out: ChatHost[] = [];
  for (const item of list) {
    const host = resolveHost(hosts, item);
    if (seen.has(host.id)) continue;
    seen.add(host.id);
    out.push(host);
  }
  return out;
}

/**
 * Runs `task` for every item with at most `limit` in flight, keeping the result
 * order. The fan-out of a multi-host command is the reason this exists: opening
 * every SSH session at once is what makes a 30-server check fail on the *remote*
 * side, where the operator cannot see why. `task` is expected to report its own
 * failures as values — a rejection stops the batch and loses the other results.
 */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  task: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    async () => {
      for (;;) {
        const index = next++;
        if (index >= items.length) return;
        results[index] = await task(items[index], index);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

/**
 * One line per host for the system prompt. The model needs to know what is
 * reachable before it spends a turn discovering that a host is offline or that
 * its host key was never confirmed.
 */
export function hostPromptLines(hosts: ChatHost[], primaryId: number) {
  return hosts.map((host) => {
    const marks = [
      host.id === primaryId ? "primary" : "extra",
      host.online ? "agent online" : "agent offline",
      host.trusted ? "ssh trusted" : "ssh host key not confirmed",
      host.credentials === "ok"
        ? "credentials ok"
        : host.credentials === "missing"
          ? "no stored credentials"
          : "credentials undecryptable",
    ];
    return `- ${hostLabel(host)} at ${host.address} (${marks.join(", ")})`;
  });
}
