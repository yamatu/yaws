/** Phones and touch tablets: Enter writes a newline, the button sends. */
export const MOBILE_INPUT_QUERY = "(pointer: coarse), (max-width: 760px)";
export const ENTER_PREF_KEY = "yaws.ai.enter";

export type EnterPreference = "auto" | "send" | "newline";

export const ENTER_PREFERENCES: Array<{ value: EnterPreference; label: string }> = [
  { value: "auto", label: "自动（手机换行）" },
  { value: "send", label: "回车发送" },
  { value: "newline", label: "回车换行" },
];

export function parseEnterPreference(value: string | null | undefined): EnterPreference {
  return value === "send" || value === "newline" ? value : "auto";
}

export function readEnterPreference(): EnterPreference {
  try {
    return parseEnterPreference(localStorage.getItem(ENTER_PREF_KEY));
  } catch {
    return "auto";
  }
}

export function writeEnterPreference(value: EnterPreference) {
  try {
    localStorage.setItem(ENTER_PREF_KEY, value);
  } catch {
    // private mode: the choice lasts for this page only
  }
}

export type EnterKey = {
  key: string;
  shiftKey: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  /** An IME is still composing, e.g. pinyin candidates are open. */
  composing?: boolean;
  /** A real Shift keydown was seen; touch keyboards report auto-capitalisation as Shift. */
  explicitShift?: boolean;
};

/**
 * What Enter does in the prompt box: send, insert a newline, or nothing (not
 * Enter, or an IME needs the key to confirm a candidate).
 */
export function enterAction(
  event: EnterKey,
  mobile: boolean,
  preference: EnterPreference,
): "send" | "newline" | "ignore" {
  if (event.key !== "Enter" || event.composing) return "ignore";
  if (event.ctrlKey || event.metaKey) return "send";
  const shift = event.shiftKey && (!mobile || event.explicitShift === true);
  const plainSends =
    preference === "send" ? true : preference === "newline" ? false : !mobile;
  return (shift ? !plainSends : plainSends) ? "send" : "newline";
}
