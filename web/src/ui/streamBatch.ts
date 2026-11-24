/**
 * Coalesces streamed answer text into one update per animation frame.
 *
 * A provider can send tens of delta frames per second — far more than the screen
 * can show — and every frame used to re-render the transcript. On a long
 * conversation that is what made the page lock up: the browser spent its whole
 * budget rebuilding a tree nobody could paint. Text is collected here and handed
 * over once per frame instead, so the render rate follows the paint rate.
 *
 * `flush` is what keeps the transcript honest around non-text frames: a tool
 * call, the final answer or the end of the run must see the text that arrived
 * before it, so the caller flushes before handling those.
 *
 * The scheduler is injected so the rules are testable under `node --test`.
 */

export type StreamBatch = {
  /** A chunk of streamed answer text. */
  answer(text: string): void;
  /** A chunk of streamed reasoning. */
  thinking(text: string): void;
  /** Applies everything buffered now, e.g. before a non-text frame. */
  flush(): void;
  /** Drops what is buffered without applying it, e.g. on unmount. */
  cancel(): void;
};

export function createStreamBatch(
  apply: (answer: string, thinking: string) => void,
  schedule: (run: () => void) => unknown = (run) => requestAnimationFrame(run),
  unschedule: (handle: unknown) => void = (handle) =>
    cancelAnimationFrame(handle as number),
): StreamBatch {
  let answer = "";
  let thinking = "";
  let handle: unknown = null;

  const run = () => {
    handle = null;
    const pendingAnswer = answer;
    const pendingThinking = thinking;
    answer = "";
    thinking = "";
    if (pendingAnswer || pendingThinking) apply(pendingAnswer, pendingThinking);
  };

  const push = (kind: "answer" | "thinking", text: string) => {
    if (!text) return;
    if (kind === "answer") answer += text;
    else thinking += text;
    if (handle === null) handle = schedule(run);
  };

  return {
    answer: (text) => push("answer", text),
    thinking: (text) => push("thinking", text),
    flush() {
      if (handle !== null) {
        unschedule(handle);
        handle = null;
      }
      run();
    },
    cancel() {
      if (handle !== null) {
        unschedule(handle);
        handle = null;
      }
      answer = "";
      thinking = "";
    },
  };
}
