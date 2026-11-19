/**
 * Long runs of steps fold into one line ("已执行 6 个步骤"), so a finished
 * answer is not pushed off the screen by its own tool calls — on a phone that
 * is most of the transcript. Thinking blocks between steps join the run.
 */
export const GROUP_MIN = 3;

type Groupable = { kind: string; key: string };

export type GroupItem<T> =
  | { type: "entry"; entry: T }
  | { type: "group"; key: string; entries: T[]; tools: number };

const STEP_KINDS = new Set(["tool", "thinking"]);

export function groupSteps<T extends Groupable>(entries: T[], min = GROUP_MIN): GroupItem<T>[] {
  const items: GroupItem<T>[] = [];
  let run: T[] = [];
  const flush = () => {
    const tools = run.filter((entry) => entry.kind === "tool").length;
    if (tools >= min) items.push({ type: "group", key: `g-${run[0].key}`, entries: run, tools });
    else for (const entry of run) items.push({ type: "entry", entry });
    run = [];
  };
  for (const entry of entries) {
    if (STEP_KINDS.has(entry.kind)) {
      run.push(entry);
      continue;
    }
    flush();
    items.push({ type: "entry", entry });
  }
  flush();
  return items;
}

export type StepState = "running" | "ok" | "error" | "awaiting";

/** Counts for the folded line: how many failed, how many still going. */
export function stepSummary(states: StepState[]) {
  const count = (state: StepState) => states.filter((s) => s === state).length;
  return {
    total: states.length,
    failed: count("error"),
    running: count("running"),
    awaiting: count("awaiting"),
  };
}
