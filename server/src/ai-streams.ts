/**
 * Detached assistant runs.
 *
 * A run used to live inside the HTTP response that started it: closing the tab
 * (or refreshing it) closed the socket, and `requestSignal` turned that into an
 * abort — the model request was dropped, the SSH work stopped, and the operator
 * came back to a conversation whose last turn said `cancelled`.
 *
 * A streamed request cannot survive a reload on its own, so the run is moved out
 * of the request and into this registry: the socket becomes a *reader* of the
 * run, not its owner. A reload (or a second tab) then re-attaches with
 * `GET /runs/:runId/stream` and keeps watching, because the answer was never
 * tied to the connection that asked the question.
 *
 * Lives are still finite:
 *  - the caller's `AbortSignal` (the old `requestSignal`) only detaches the
 *    reader; nothing else happens unless it is a *client* abort,
 *  - a run with no attached reader is not killed either: the operator may be
 *    staring at a login screen. It keeps working until it finishes or the idle
 *    guard fires,
 *  - the last event is kept, so a reader that attaches after the end still gets
 *    the answer instead of an empty stream.
 *
 * Exporting the registry instead of hiding it behind the route is deliberate:
 * the route, the re-attach endpoint and the tests all use the same object, and a
 * per-process registry is exactly what "survives a page reload" means here.
 */

/** Kept after the run finished so a late reader still sees the outcome. */
export const RUN_REPLAY_KEEP = 400;

/**
 * How long a finished run stays reachable for a re-attach.
 *
 * Long enough to cover a refresh that lands on the last token (the page asks for
 * the stream again a moment after the run ended), and short enough that finished
 * runs cannot pile up for the lifetime of the process. `forget` is also called
 * when a conversation is deleted, so an explicit delete does not wait for this.
 */
export const RUN_KEEP_MS = 5 * 60_000;

/** How many finished runs to remember when pruning. */
const RUN_KEEP_MAX = 64;

type Listener = (event: Record<string, unknown>) => void;

export type DetachedRun = {
  runId: string;
  conversationId: string;
  userId: number;
  machineId: number;
  /** Set once the run is over, so a re-attach can tell "finished" from "slow". */
  finished: boolean;
  /** When it finished; only set alongside `finished`. */
  finishedAt: number;
  /** The last frames, replayed in order to a reader that attaches late. */
  replay: Array<Record<string, unknown>>;
  listeners: Set<Listener>;
  aborters: Set<() => void>;
};

export class RunStreams {
  private readonly runs = new Map<string, DetachedRun>();

  /** Registers the run before any work starts, so an early re-attach works. */
  create(input: {
    runId: string;
    conversationId: string;
    userId: number;
    machineId: number;
  }): DetachedRun {
    this.prune();
    const run: DetachedRun = {
      ...input,
      finished: false,
      finishedAt: 0,
      replay: [],
      listeners: new Set(),
      aborters: new Set(),
    };
    this.runs.set(run.runId, run);
    return run;
  }

  /**
   * Drops finished runs nobody can be waiting for any more.
   *
   * A finished run is only kept so a refresh that lands right on the last token
   * can still read the answer; after `RUN_KEEP_MS` it is dead weight. Running
   * runs are never touched, however old, because the guard in the chat route owns
   * their lifetime.
   */
  private prune(now = Date.now()) {
    const finished = [...this.runs.values()]
      .filter((run) => run.finished)
      .sort((a, b) => a.finishedAt - b.finishedAt);
    const expired = now - RUN_KEEP_MS;
    let doomed = finished.filter((run) => run.finishedAt <= expired);
    const leftovers = finished.length - doomed.length;
    // Even within the grace window a busy panel must not grow without bound, so
    // the oldest finished runs are dropped once there are too many.
    if (leftovers > RUN_KEEP_MAX)
      doomed = doomed.concat(finished.slice(0, leftovers - RUN_KEEP_MAX));
    for (const run of doomed) this.runs.delete(run.runId);
  }

  get(runId: string): DetachedRun | undefined {
    return this.runs.get(runId);
  }

  /** Runs currently in flight, for diagnostics and tests. */
  get size(): number {
    let running = 0;
    for (const run of this.runs.values()) if (!run.finished) running += 1;
    return running;
  }

  /** Every run this process knows about, running or just finished. */
  all(): DetachedRun[] {
    return [...this.runs.values()];
  }

  /** Publishes one frame to every reader, and remembers it for late readers. */
  emit(run: DetachedRun, event: Record<string, unknown>) {
    run.replay.push(event);
    if (run.replay.length > RUN_REPLAY_KEEP) run.replay.shift();
    for (const listener of [...run.listeners]) {
      try {
        listener(event);
      } catch {
        // A dead reader must never break the run; it detaches itself below.
        run.listeners.delete(listener);
      }
    }
  }

  /**
   * Attaches a reader. `from` skips frames the reader already has, so a client
   * that reconnects after a dropped socket does not duplicate the answer it
   * already rendered. Returns the frames to send first, or `null` when the run
   * is unknown (the caller then answers 404 rather than streaming nothing).
   */
  attach(
    runId: string,
    listener: Listener,
    from = 0,
  ): { replay: Array<Record<string, unknown>> } | null {
    const run = this.runs.get(runId);
    if (!run) return null;
    const replay = run.replay.slice(Math.max(0, from));
    run.listeners.add(listener);
    return { replay };
  }

  detach(run: DetachedRun, listener: Listener) {
    run.listeners.delete(listener);
  }

  /**
   * Marks the run finished and lets every reader go. The record itself stays:
   * `GET /conversations/:cid` needs no help, but a reader attaching a moment
   * after the final frame should still get the answer rather than a 404.
   *
   * `stream_end` is delivered to the readers that are connected right now and is
   * deliberately not remembered: it describes this attachment, not the run, so a
   * late reader gets the answer itself and then a closed stream.
   */
  finish(run: DetachedRun) {
    run.finished = true;
    run.finishedAt = Date.now();
    for (const listener of [...run.listeners]) {
      try {
        listener({ type: "stream_end", runId: run.runId });
      } catch {
        // ignored: the reader is going away anyway
      }
    }
    run.listeners.clear();
  }

  /**
   * Registers a way to stop the run when the *client* stops it. A closed socket
   * never calls these — that is the whole point of this module.
   */
  onAbort(run: DetachedRun, aborter: () => void) {
    if (run.finished) {
      aborter();
      return;
    }
    run.aborters.add(aborter);
  }

  /** The operator pressed 停止, or the run was cancelled by the panel. */
  abort(runId: string): boolean {
    const run = this.runs.get(runId);
    if (!run || run.finished) return false;
    for (const aborter of [...run.aborters]) {
      try {
        aborter();
      } catch {
        // ignored: stopping must not depend on one listener behaving
      }
    }
    return true;
  }

  /** Drops the record; only safe once nobody can re-attach any more. */
  forget(runId: string) {
    this.runs.delete(runId);
  }

  /** Drops every run of a conversation, finished or not. */
  forgetConversation(conversationId: string) {
    for (const run of [...this.runs.values()])
      if (run.conversationId === conversationId) this.runs.delete(run.runId);
  }
}

/** One per process, shared by the chat route and the re-attach route. */
export const runStreams = new RunStreams();
