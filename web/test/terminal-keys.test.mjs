import test from "node:test";
import assert from "node:assert/strict";
import {
  applyMods,
  BACKSPACE_KEY,
  controlCode,
  CONTROL_KEYS,
  defaultKeyBarVisible,
  ENTER_KEY,
  modsActive,
  NAV_KEYS,
  NO_MODS,
  SCROLL_KEYS,
  sendKey,
  SYMBOL_KEYS,
} from "../src/ui/terminalKeys.ts";

test("controlCode maps the letters a terminal cares about", () => {
  assert.equal(controlCode("c"), "\x03");
  assert.equal(controlCode("C"), "\x03");
  assert.equal(controlCode("d"), "\x04");
  assert.equal(controlCode("["), "\x1b");
  assert.equal(controlCode("_"), "\x1f");
  assert.equal(controlCode("1"), null);
  assert.equal(controlCode(" "), null);
  assert.equal(controlCode("汉字"), null);
  assert.equal(controlCode(""), null);
});

test("applyMods turns the soft keyboard into Ctrl and Alt input", () => {
  assert.equal(applyMods("c", { ctrl: true, alt: false }), "\x03");
  assert.equal(applyMods("x", { ctrl: false, alt: true }), "\x1bx");
  assert.equal(applyMods("c", { ctrl: true, alt: true }), "\x1b\x03");
  assert.equal(applyMods("ls", { ctrl: true, alt: false }), "\x0cs");
  assert.equal(applyMods("1", { ctrl: true, alt: false }), "1");
  assert.equal(applyMods("diff", NO_MODS), "diff");
  assert.equal(applyMods("", { ctrl: true, alt: true }), "");
  assert.equal(modsActive(NO_MODS), false);
  assert.equal(modsActive({ ctrl: true, alt: false }), true);
  assert.equal(modsActive({ ctrl: false, alt: true }), true);
});

test("sendKey only rewrites literal characters", () => {
  const symbol = SYMBOL_KEYS[0];
  assert.equal(sendKey(symbol, { ctrl: true, alt: false }), symbol.seq);
  const escape = NAV_KEYS[0];
  assert.equal(sendKey(escape, { ctrl: true, alt: true }), "\x1b");
  const arrow = NAV_KEYS[2];
  assert.equal(sendKey(arrow, { ctrl: false, alt: true }), "\x1b[A");
});

test("the key bar carries the keys a touch keyboard cannot press", () => {
  const labels = SCROLL_KEYS.map((key) => key.label);
  for (const wanted of ["^C", "^D", "^L", "^R", "PgUp", "Del", "|", "~", "/"])
    assert.ok(labels.includes(wanted), `missing ${wanted}`);
  assert.equal(NAV_KEYS[0].seq, "\x1b");
  assert.equal(NAV_KEYS[1].seq, "\t");
  assert.deepEqual(
    NAV_KEYS.slice(2).map((k) => k.seq),
    ["\x1b[A", "\x1b[B", "\x1b[C", "\x1b[D"],
  );
  assert.equal(BACKSPACE_KEY.seq, "\x7f");
  assert.equal(ENTER_KEY.seq, "\r");
  const all = [...NAV_KEYS, ...SCROLL_KEYS, BACKSPACE_KEY, ENTER_KEY];
  assert.ok(all.every((key) => key.seq.length > 0 && key.label.length > 0));
  assert.ok(
    all.every((key) => key.plain !== true || [...key.seq].length === 1),
    "plain keys must be single characters so Ctrl can rewrite them",
  );
  assert.deepEqual(
    CONTROL_KEYS.map((k) => k.seq),
    ["\x03", "\x04", "\x1a", "\x0c", "\x12", "\x01", "\x05", "\x15", "\x17", "\x0b"],
  );
  const unique = new Set(all.map((key) => key.seq));
  assert.equal(unique.size, all.length, "no two buttons may send the same bytes");
});

test("the bar defaults to on for touch and narrow screens", () => {
  assert.equal(defaultKeyBarVisible(true, 1440, null), true);
  assert.equal(defaultKeyBarVisible(false, 390, null), true);
  assert.equal(defaultKeyBarVisible(false, 1440, null), false);
  assert.equal(defaultKeyBarVisible(false, 1440, "1"), true);
  assert.equal(defaultKeyBarVisible(true, 390, "0"), false);
});
