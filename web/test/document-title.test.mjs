import assert from "node:assert/strict";
import test from "node:test";

import { formatTitle } from "../src/ui/documentTitle.ts";

test("the server name leads the title", () => {
  assert.equal(formatTitle("Fixture 1"), "Fixture 1 · YAWS");
});

test("an empty name falls back to the product name", () => {
  assert.equal(formatTitle(""), "YAWS");
  assert.equal(formatTitle("   "), "YAWS");
  assert.equal(formatTitle(null), "YAWS");
  assert.equal(formatTitle(undefined), "YAWS");
});

test("whitespace inside a name is squeezed", () => {
  assert.equal(formatTitle("  Fixture\n\t2  "), "Fixture 2 · YAWS");
});

test("a very long name is clipped instead of overflowing the tab", () => {
  const title = formatTitle("x".repeat(200));
  assert.equal(title, `${"x".repeat(59)}… · YAWS`);
  assert.ok(title.length < 70);
});
