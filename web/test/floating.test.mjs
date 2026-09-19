import assert from "node:assert/strict";
import test from "node:test";

import { placeMenu } from "../src/ui/floating.ts";

const viewport = { width: 1000, height: 800 };
// A button near the left edge of the composer.
const anchor = { top: 700, bottom: 730, left: 40 };
const menu = { width: 260, height: 320 };

test("floating menu placement", async (t) => {
  await t.test("a menu that fits above the button is shown above", () => {
    // The dock sits at the bottom of the window, so there is no room below.
    const placed = placeMenu(anchor, menu, viewport);
    assert.equal(placed.openUp, true);
    assert.equal(placed.left, 40);
    assert.equal(placed.top, 700 - 6 - 320);
    assert.equal(placed.width, menu.width);
  });

  await t.test("a menu with room below stays below", () => {
    const placed = placeMenu({ top: 100, bottom: 130, left: 40 }, menu, viewport);
    assert.equal(placed.openUp, false);
    assert.equal(placed.top, 136);
  });

  await t.test("the panel never leaves the viewport", () => {
    // Anchored to the right edge: the panel is pulled back inside.
    const right = placeMenu(
      { top: 700, bottom: 730, left: 960 },
      menu,
      viewport,
    );
    assert.equal(right.left, 1000 - 260 - 8);
    // A panel wider than the window is narrowed to the window.
    const wide = placeMenu(anchor, { width: 1400, height: 200 }, viewport);
    assert.equal(wide.left, 8);
    assert.equal(wide.width, 1000 - 16);
    // A very tall panel still starts inside the window.
    const tall = placeMenu(anchor, { width: 260, height: 900 }, viewport);
    assert.equal(tall.top, 8);
  });

  await t.test("the gap honours the caller and the flip stays on screen", () => {
    const placed = placeMenu(anchor, menu, viewport, 20);
    assert.equal(placed.top, 700 - 20 - 320);
    // Both sides are cramped: below wins when it is at least as roomy.
    const tiny = placeMenu(
      { top: 200, bottom: 210, left: 10 },
      { width: 100, height: 300 },
      { width: 400, height: 400 },
    );
    assert.equal(tiny.openUp, true);
    assert.equal(tiny.top, 8);
  });
});
