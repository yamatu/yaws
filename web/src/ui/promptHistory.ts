/**
 * The up/down recall of questions this conversation was already asked.
 *
 * Kept as plain functions over a plain array — no React, no DOM — for the same
 * reason the scroll rules are: the interesting part is *which* question an arrow
 * key lands on, and that is worth asserting without a browser.
 *
 * The shape is the one every shell uses, because the muscle memory is the same:
 * the newest question is one `up` away, repeated `up` walks backwards, `down`
 * walks forwards, and walking back past the newest question returns the *draft*
 * the operator had typed before they started browsing.
 */

/** How many questions a conversation remembers for recall. */
export const HISTORY_LIMIT = 100;

/**
 * Where the cursor is in the history.
 *
 * `index` counts from the end: `0` is the draft (not browsing), `1` is the
 * newest question, `2` the one before it. Counting from the end means the index
 * keeps pointing at the same question even if something is appended while the
 * operator is browsing — which cannot normally happen, but is cheap to make
 * true and would otherwise be a subtle off-by-one.
 */
export type HistoryCursor = { index: number; draft: string };

export const NEW_CURSOR: HistoryCursor = { index: 0, draft: "" };

/** Clamps the remembered questions to the newest `HISTORY_LIMIT`. */
export function remember(
  history: readonly string[],
  question: string,
  limit = HISTORY_LIMIT,
): string[] {
  const text = question.trim();
  // An empty question is not worth remembering, and asking the same thing twice
  // in a row should not take two `up` presses to walk past.
  if (!text) return [...history];
  if (history.at(-1) === text) return [...history];
  const next = [...history, text];
  return next.length > limit ? next.slice(next.length - limit) : next;
}

/** The question at a cursor position, or the draft when it sits at the end. */
function valueAt(history: readonly string[], cursor: HistoryCursor): string {
  return cursor.index === 0
    ? cursor.draft
    : (history[history.length - cursor.index] ?? cursor.draft);
}

/**
 * Takes one step towards older questions (`-1`) or newer ones (`+1`).
 *
 * Returns `null` when the step would leave the history, so the caller can let
 * the arrow key fall through to the textarea's own cursor movement instead of
 * swallowing it — pressing `up` at the newest question should not trap the
 * caret. The draft is captured on the *first* step away from it, so a later
 * `down` restores what was typed rather than an already-recalled question.
 */
export function step(
  history: readonly string[],
  cursor: HistoryCursor,
  direction: -1 | 1,
  draft: string,
): { cursor: HistoryCursor; value: string } | null {
  // `direction: -1` walks towards older questions, which is a larger index.
  const next = cursor.index - direction;
  if (next < 0 || next > history.length) return null;
  const base: HistoryCursor =
    cursor.index === 0 ? { index: 0, draft } : cursor;
  const moved: HistoryCursor = { ...base, index: next };
  return { cursor: moved, value: valueAt(history, moved) };
}

/** Convenience wrappers so call sites read as the key that was pressed. */
export function up(
  history: readonly string[],
  cursor: HistoryCursor,
  draft: string,
) {
  return step(history, cursor, -1, draft);
}

export function down(
  history: readonly string[],
  cursor: HistoryCursor,
  draft: string,
) {
  return step(history, cursor, 1, draft);
}

/**
 * Whether the caret is on the first or last line of the textarea.
 *
 * An arrow key only means "recall" when there is no line left to move the caret
 * through: in a multi-line question `up` has to keep working as ordinary editing
 * until the caret reaches the top. Without this, writing a paragraph would start
 * replacing lines with old questions.
 */
export function atEdge(
  value: string,
  caret: number,
  direction: -1 | 1,
): boolean {
  const offset = Math.max(0, Math.min(caret, value.length));
  if (direction === -1) {
    // The caret may sit just *after* a newline — that is still the first line,
    // because there is no character above it to move up to. Looking at the text
    // before the caret and stopping at the newline that ends the first line is
    // the same test either way: any `\n` before the caret means it is not on
    // the first line.
    return !value.slice(0, offset).includes("\n");
  }
  // For `down` the newline immediately under the caret does not count: pressing
  // `down` at the end of a line simply moves onto the next one, which is still
  // ordinary editing rather than recall.
  return !value.slice(offset).replace(/^\n/, "").includes("\n");
}
