/**
 * Whether the transcript should follow the answer as it is written.
 *
 * The chat used to jump to the bottom on every change, so scrolling back to
 * re-read a step was impossible while the assistant was working: the next token
 * yanked the view away. Following is now a decision the operator makes — reading
 * back stops it, going back to the bottom starts it again — which is why the
 * rules are pure functions here instead of being spread through the component.
 *
 * Pure on purpose: no React, no DOM, so the rules are testable under `node
 * --test`.
 */

/** How close to the bottom still counts as "at the bottom". */
export const STICK_SLACK = 24;

/** True when the scrolled box is close enough to the end to keep following. */
export function atBottom(
  node: { scrollTop: number; scrollHeight: number; clientHeight: number },
  slack = STICK_SLACK,
): boolean {
  return node.scrollHeight - node.scrollTop - node.clientHeight <= slack;
}

/** True if a wheel gesture heads towards the end of the content. */
export function wheelMovesDown(deltaY: number): boolean {
  return deltaY > 0;
}

/**
 * A scroll event explains itself: `up` when the operator moved away from the
 * end, `down` when they came back. Anything else (a programmatic scroll, a
 * resize, a re-render) leaves the current decision alone.
 */
export function scrollIntent(
  prevTop: number,
  nextTop: number,
  slack = 1,
): "up" | "down" | "" {
  const delta = nextTop - prevTop;
  if (delta < -slack) return "up";
  if (delta > slack) return "down";
  return "";
}

export type StickDecision = {
  /** Whether later updates should keep the view at the end. */
  stick: boolean;
  /** True when the gesture was the operator asking to jump to the end now. */
  jump: boolean;
};

/**
 * One user gesture against the current state. Following restarts the moment the
 * operator scrolls (or wheels) back to the end, so an accidental scroll up
 * costs one flick downwards to undo.
 */
export function stickAfterScroll(
  current: boolean,
  node: { scrollTop: number; scrollHeight: number; clientHeight: number },
  slack = STICK_SLACK,
): StickDecision {
  const bottom = atBottom(node, slack);
  return { stick: bottom, jump: bottom && !current };
}

/** A reply at the end of the transcript, with no step after it. */
function endsWithAnswer(entries: Array<{ kind: string }>): boolean {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const kind = entries[index].kind;
    if (kind === "user") return false;
    if (kind === "assistant") return true;
  }
  return false;
}

/**
 * Should the view jump to the end to show a step that just started?
 *
 * Steps push the transcript down from above, so the answer the operator is
 * reading slides up and away. Brining it back is only helpful when they were
 * already at the end or when the run has finished an answer and stopped.
 * When they are reading back mid-run, an unexpected tool card appearing must
 * not steal the view.
 */
export function shouldStickOnChange(input: {
  stick: boolean;
  busy: boolean;
  entries: Array<{ kind: string }>;
}): boolean {
  if (input.stick) return true;
  if (input.busy) return false;
  return endsWithAnswer(input.entries);
}

/** Jump a scrolled box to the end, ignoring the request when it is not laid out. */
export function scrollToEnd(node: {
  scrollTop: number;
  scrollHeight: number;
}): void {
  node.scrollTop = node.scrollHeight;
}
