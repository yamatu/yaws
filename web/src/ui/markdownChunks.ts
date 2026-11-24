/**
 * Where a still-growing Markdown answer can be frozen.
 *
 * An answer used to be parsed and rendered from its first heading on every
 * streamed token, so a long reply cost the whole reply per token and the page
 * stalled. Only the part that can still change needs that work: everything up to
 * a blank line that provably ends a top-level block is finished Markdown and can
 * be parsed (and mounted) once. This module finds that line.
 *
 * The rules mirror `parseBlocks` in `markdown.ts`: a boundary is only offered
 * where cutting the text there leaves exactly the same blocks behind, which is
 * what `markdown-chunks.test.mjs` asserts with `parseMarkdown` itself.
 *
 *  - never inside a fenced code block: the fence can still be closed,
 *  - the line after the blank one must start a fresh block — not a list item,
 *    a quote or an indented block, all of which continue across a blank line.
 *
 * Pure on purpose: no React, no DOM, so it is testable under `node --test`.
 */

const FENCE = /^\s*(`{3,}|~{3,})/;
const LIST_ITEM = /^\s{0,3}(?:[-*+]|\d{1,9}[.)])\s+/;
const DIVIDER = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;

/** Closes the fence opened by `open`, if this line is its closing fence. */
function closesFence(line: string, open: { char: string; length: number }): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  let count = 0;
  while (trimmed[count] === open.char) count += 1;
  return count >= open.length && count === trimmed.length;
}

/**
 * True when a line that follows a blank line cannot be a continuation of the
 * block above it, so the text before it is complete.
 */
function startsFresh(line: string): boolean {
  if (!line.trim()) return false;
  // Indented: may belong to the body of a list item above the blank line.
  if (/^\s/.test(line)) return false;
  // A rule cannot continue anything, even though `---` looks like a list item.
  if (DIVIDER.test(line)) return true;
  // Lists and quotes keep going across a blank line; the parser joins them.
  if (LIST_ITEM.test(line)) return false;
  if (/^>/.test(line)) return false;
  return true;
}

/**
 * Offset where the finished part of `text` ends and the live tail begins.
 *
 * `from` is the offset already frozen, so a caller that appends one token at a
 * time only rescans the part that grew. Returns `0` when nothing can be frozen
 * yet (a single long paragraph, an open code block…).
 */
export function stableBoundary(text: string, from = 0): number {
  if (text.length <= from) return 0;
  let boundary = 0;
  let fence: { char: string; length: number } | null = null;
  // Whether the previous line was blank: only then can a block have ended.
  let blank = false;
  let pos = from;
  while (pos <= text.length) {
    const newline = text.indexOf("\n", pos);
    const end = newline < 0 ? text.length : newline;
    const line = text.slice(pos, end);
    if (fence) {
      if (closesFence(line, fence)) fence = null;
      blank = false;
    } else {
      const open = FENCE.exec(line);
      // Only a line that is already terminated can be judged: `-` looks like a
      // fresh paragraph until the token that makes it `- 三` arrives, and a list
      // item belongs to the list above the blank line.
      if (blank && newline >= 0 && pos > from && startsFresh(line)) boundary = pos;
      if (open) {
        fence = { char: open[1][0], length: open[1].length };
        blank = false;
      } else if (!line.trim()) {
        blank = true;
      } else {
        blank = false;
      }
    }
    if (newline < 0) break;
    pos = newline + 1;
  }
  return boundary;
}
