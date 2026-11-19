type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const PREFIX = "yaws.ai.draft.";
/** Same cap as the server puts on one question. */
export const DRAFT_LIMIT = 12000;

/** One unsent question per conversation; `""` is the not-yet-started chat. */
export function draftKey(machineId: number, conversationId: string) {
  return `${PREFIX}${machineId}.${conversationId || "new"}`;
}

function browserStorage(): DraftStorage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

export function readDraft(key: string, storage = browserStorage()): string {
  try {
    return storage?.getItem(key) ?? "";
  } catch {
    return "";
  }
}

export function writeDraft(key: string, text: string, storage = browserStorage()) {
  try {
    if (text.trim()) storage?.setItem(key, text.slice(0, DRAFT_LIMIT));
    else storage?.removeItem(key);
  } catch {
    // quota or private mode: the draft only lives in the box
  }
}
