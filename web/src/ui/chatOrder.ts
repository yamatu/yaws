/** Transcript ordering for the AI chat.
 *
 *  A turn is streamed as it happens: the model often writes a sentence before it
 *  decides to call a tool, so the assistant text can reach the browser *before*
 *  the steps that produced it. Reading order should still be "steps first, answer
 *  last" — everything a turn did is listed above the answer that concludes it.
 *
 *  Grouping is by user message, so a later turn can never be pulled above an
 *  earlier answer. */

export type ChatEntryLike = { kind: string };

/** Reorders one flat transcript: steps per turn, then that turn's answers. */
export function orderTurnEntries<T extends ChatEntryLike>(entries: T[]): T[] {
  const ordered: T[] = [];
  let steps: T[] = [];
  let answers: T[] = [];
  const flush = () => {
    for (const entry of steps) ordered.push(entry);
    for (const entry of answers) ordered.push(entry);
    steps = [];
    answers = [];
  };
  for (const entry of entries) {
    if (entry.kind === "user") {
      flush();
      ordered.push(entry);
    } else if (entry.kind === "assistant") {
      answers.push(entry);
    } else {
      steps.push(entry);
    }
  }
  flush();
  return ordered;
}
