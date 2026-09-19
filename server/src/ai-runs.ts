/**
 * Concurrency gate for assistant runs.
 *
 * A run is one question: from the first token until the last tool call of that
 * turn. Every run owns its own SSH connection, its own conversation and its own
 * model request, and the configured model endpoint serves parallel requests, so
 * runs must be able to overlap — holding the operator to one run at a time
 * made a second machine unusable while the first one was still thinking.
 *
 * What stays exclusive is a single conversation: two turns started from the
 * same conversation would both read the same history and then both append to
 * it, so the second one is refused instead of silently interleaving the
 * answers.
 *
 * The limits below exist for a runaway client (a page stuck in a loop that
 * opens streams and never reads them), not for the model provider.
 */

export const MAX_RUNS_PER_USER = 8;
export const MAX_RUNS_TOTAL = 32;

export type RunSlot = {
  /** Conversation (or legacy run target) this slot belongs to. */
  key: string;
  /** Owner of the slot; one user's runs are counted together. */
  userKey: string;
  /** Idempotent: releasing twice must not free somebody else's slot. */
  release: () => void;
};

export type AcquireResult =
  | { ok: true; slot: RunSlot }
  /** `busy`: that conversation is already running. `limit`: too many runs. */
  | { ok: false; reason: "busy" | "limit" };

export class RunRegistry {
  private readonly owners = new Map<string, string>();
  private readonly counts = new Map<string, number>();

  constructor(
    private readonly perUser = MAX_RUNS_PER_USER,
    private readonly total = MAX_RUNS_TOTAL,
  ) {}

  acquire(key: string, userKey: string): AcquireResult {
    if (this.owners.has(key)) return { ok: false, reason: "busy" };
    if (
      (this.counts.get(userKey) ?? 0) >= this.perUser ||
      this.owners.size >= this.total
    )
      return { ok: false, reason: "limit" };
    this.owners.set(key, userKey);
    this.counts.set(userKey, (this.counts.get(userKey) ?? 0) + 1);
    let released = false;
    return {
      ok: true,
      slot: {
        key,
        userKey,
        release: () => {
          if (released) return;
          released = true;
          this.drop(key, userKey);
        },
      },
    };
  }

  /** Runs currently in flight, for diagnostics and tests. */
  get size(): number {
    return this.owners.size;
  }

  activeFor(userKey: string): number {
    return this.counts.get(userKey) ?? 0;
  }

  has(key: string): boolean {
    return this.owners.has(key);
  }

  private drop(key: string, userKey: string) {
    if (this.owners.get(key) !== userKey) return;
    this.owners.delete(key);
    const left = (this.counts.get(userKey) ?? 1) - 1;
    if (left > 0) this.counts.set(userKey, left);
    else this.counts.delete(userKey);
  }
}

/** Shared by the streaming chat route and the older one-shot run route. */
export const aiRuns = new RunRegistry();
