export const QUEUE_LIMIT = 5;

type QueuedImage = { id: string; mime: string; data: string };
export type Queued = { id: string; text: string; images?: QueuedImage[] };

/** Adds a follow-up; `null` when it has no content or the queue is full. */
export function enqueue(
  queue: Queued[],
  text: string,
  id: string,
  images: QueuedImage[] = [],
): Queued[] | null {
  const trimmed = text.trim();
  if ((!trimmed && !images.length) || queue.length >= QUEUE_LIMIT) return null;
  return [...queue, { id, text: trimmed, ...(images.length ? { images } : {}) }];
}

export function removeQueued(queue: Queued[], id: string): Queued[] {
  return queue.filter((item) => item.id !== id);
}

/**
 * Whether the oldest queued question should go out now.
 *
 * - `wait`: a turn is still running, or nothing is queued.
 * - `hold`: the last turn was stopped or failed, or approval cards are open.
 *   Sending on its own would talk past what the operator has to look at first.
 * - `send`: the conversation is idle and clean.
 */
export function flushDecision(state: {
  running: boolean;
  queued: number;
  pending: number;
  halted: boolean;
}): "send" | "wait" | "hold" {
  if (!state.queued || state.running) return "wait";
  if (state.halted || state.pending > 0) return "hold";
  return "send";
}
