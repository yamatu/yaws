/**
 * On-screen keys for the SSH terminal on phones and tablets.
 *
 * Touch keyboards have no Esc/Tab/arrows and no way to press Ctrl with another key, so the
 * terminal ships a small key bar. Everything here is pure so it can be unit tested without a
 * browser: the component only renders the buttons and forwards the resolved bytes.
 */

export type Mods = { ctrl: boolean; alt: boolean };

export type KeyButton = {
  /** Text on the button. */
  label: string;
  /** Bytes sent to the terminal. */
  seq: string;
  /** Accessible name; falls back to the label. */
  aria?: string;
  /** A literal character the operator could have typed, so sticky Ctrl/Alt apply to it. */
  plain?: boolean;
};

export const NO_MODS: Mods = { ctrl: false, alt: false };

export const ESC = "\x1b";

/**
 * Control characters for the letters people actually use.
 * `@A-Z[\]^_` map to 0x00-0x1f, which is exactly what a terminal expects.
 */
export function controlCode(char: string): string | null {
  if (char.length !== 1) return null;
  const code = char.toUpperCase().charCodeAt(0);
  if (code >= 64 && code <= 95) return String.fromCharCode(code - 64);
  return null;
}

/** Apply sticky modifiers to input coming from either the key bar or the soft keyboard. */
export function applyMods(data: string, mods: Mods): string {
  if (!data) return data;
  let out = data;
  if (mods.ctrl) {
    const code = controlCode(out[0]);
    if (code !== null) out = code + out.slice(1);
  }
  if (mods.alt) out = ESC + out;
  return out;
}

export function modsActive(mods: Mods): boolean {
  return mods.ctrl || mods.alt;
}

/** Keys that carry their own escape sequence must never get Ctrl/Alt prefixed again. */
export function sendKey(key: KeyButton, mods: Mods): string {
  return key.plain ? applyMods(key.seq, mods) : key.seq;
}

const plain = (label: string, seq = label): KeyButton => ({
  label,
  seq,
  plain: true,
});

/** Navigation and editing keys, pinned to the left of the bar. */
export const NAV_KEYS: KeyButton[] = [
  { label: "Esc", seq: ESC, aria: "Esc" },
  plain("Tab", "\t"),
  { label: "↑", seq: `${ESC}[A`, aria: "向上" },
  { label: "↓", seq: `${ESC}[B`, aria: "向下" },
  { label: "→", seq: `${ESC}[C`, aria: "向右" },
  { label: "←", seq: `${ESC}[D`, aria: "向左" },
];

/** One-tap control combinations, the ones that are painful to reach on a phone. */
export const CONTROL_KEYS: KeyButton[] = [
  { label: "^C", seq: "\x03", aria: "Ctrl C 中断" },
  { label: "^D", seq: "\x04", aria: "Ctrl D 结束输入" },
  { label: "^Z", seq: "\x1a", aria: "Ctrl Z 挂起" },
  { label: "^L", seq: "\x0c", aria: "Ctrl L 清屏" },
  { label: "^R", seq: "\x12", aria: "Ctrl R 搜索历史" },
  { label: "^A", seq: "\x01", aria: "Ctrl A 行首" },
  { label: "^E", seq: "\x05", aria: "Ctrl E 行尾" },
  { label: "^U", seq: "\x15", aria: "Ctrl U 清除行首" },
  { label: "^W", seq: "\x17", aria: "Ctrl W 删除单词" },
  { label: "^K", seq: "\x0b", aria: "Ctrl K 清除行尾" },
];

/** Shell metacharacters that are slow to reach on a touch layout. */
export const SYMBOL_KEYS: KeyButton[] = [
  "|",
  "-",
  "/",
  "~",
  "_",
  "*",
  "$",
  "&",
  ">",
  "<",
  '"',
  "'",
  "\\",
  "=",
  "!",
  "?",
  ":",
  ";",
  "(",
  ")",
].map((char) => plain(char));

export const BACKSPACE_KEY: KeyButton = {
  label: "⌫",
  seq: "\x7f",
  aria: "退格",
};
export const ENTER_KEY: KeyButton = { label: "⏎", seq: "\r", aria: "回车" };
export const DELETE_KEY: KeyButton = {
  label: "Del",
  seq: `${ESC}[3~`,
  aria: "删除",
};
export const PAGE_KEYS: KeyButton[] = [
  { label: "PgUp", seq: `${ESC}[5~`, aria: "上一页" },
  { label: "PgDn", seq: `${ESC}[6~`, aria: "下一页" },
  { label: "Home", seq: `${ESC}[H`, aria: "行首" },
  { label: "End", seq: `${ESC}[F`, aria: "行尾" },
];

/** Keys shown in the scrollable row behind the pinned navigation keys. */
export const SCROLL_KEYS: KeyButton[] = [
  ...CONTROL_KEYS,
  ...PAGE_KEYS,
  DELETE_KEY,
  ...SYMBOL_KEYS,
];

/** The bar is on by default where a physical keyboard is unlikely. */
export function defaultKeyBarVisible(
  coarsePointer: boolean,
  viewportWidth: number,
  stored: string | null,
): boolean {
  if (stored === "1") return true;
  if (stored === "0") return false;
  return coarsePointer || viewportWidth <= 760;
}
