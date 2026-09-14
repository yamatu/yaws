import test from "node:test";
import assert from "node:assert/strict";
import {
  clampSplit,
  splitFromPointer,
  splitStep,
  storedSplit,
  SPLIT_DEFAULT,
  SPLIT_MAX,
  SPLIT_MIN,
} from "../src/ui/splitter.ts";

test("the split ratio is clamped to the usable range", () => {
  assert.equal(clampSplit(50), 50);
  assert.equal(clampSplit(5), SPLIT_MIN);
  assert.equal(clampSplit(99), SPLIT_MAX);
  assert.equal(clampSplit(Number.NaN), SPLIT_DEFAULT);
  assert.equal(clampSplit(33.333333), 33.3);
});

test("a pointer position maps to a ratio", () => {
  const rect = { left: 100, top: 50, width: 1000, height: 400 };
  assert.equal(splitFromPointer(rect, 500, 0, "vertical"), 40);
  assert.equal(splitFromPointer(rect, 1100, 0, "vertical"), 100);
  assert.equal(splitFromPointer(rect, 0, 250, "horizontal"), 50);
  // A collapsed container falls back instead of dividing by zero.
  assert.equal(
    splitFromPointer({ left: 0, top: 0, width: 0, height: 0 }, 5, 5, "vertical"),
    SPLIT_DEFAULT,
  );
});

test("arrow keys step the ratio", () => {
  assert.equal(splitStep("ArrowLeft", false), -2);
  assert.equal(splitStep("ArrowDown", false), 2);
  assert.equal(splitStep("ArrowRight", true), 10);
  assert.equal(splitStep("PageUp", false), 10);
  assert.equal(splitStep("PageDown", false), -10);
  assert.equal(splitStep("Enter", false), null);
});

test("a stored ratio survives junk", () => {
  assert.equal(storedSplit("42"), 42);
  assert.equal(storedSplit("900"), SPLIT_MAX);
  assert.equal(storedSplit(null), SPLIT_DEFAULT);
  assert.equal(storedSplit(""), SPLIT_DEFAULT);
  assert.equal(storedSplit("wide"), SPLIT_DEFAULT);
  assert.equal(storedSplit("abc", 70), 70);
});
