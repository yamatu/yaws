import test from "node:test";
import assert from "node:assert/strict";
import {
  MIN_DOCK_H,
  MIN_DOCK_W,
  clampBox,
  moveBox,
  parseBox,
  resizeBox,
} from "../src/ui/dockBox.ts";

const VIEWPORT = { width: 1280, height: 800 };

test("the floating panel always stays inside the viewport", () => {
  assert.deepEqual(
    clampBox({ x: -100, y: -100, w: 460, h: 640 }, VIEWPORT),
    { x: 8, y: 8, w: 460, h: 640 },
  );
  assert.deepEqual(
    clampBox({ x: 2000, y: 2000, w: 460, h: 640 }, VIEWPORT),
    { x: 1280 - 460 - 8, y: 800 - 640 - 8, w: 460, h: 640 },
  );
  // A viewport smaller than the minimum still yields a usable box.
  const tiny = clampBox({ x: 0, y: 0, w: 100, h: 100 }, { width: 300, height: 200 });
  assert.equal(tiny.w, MIN_DOCK_W);
  assert.equal(tiny.h, MIN_DOCK_H);
  assert.equal(tiny.x, 8);
  assert.equal(tiny.y, 8);
});

test("dragging moves the panel and clamps the edges", () => {
  const start = { x: 100, y: 100, w: 460, h: 640 };
  assert.deepEqual(moveBox(start, 40, -20, VIEWPORT), {
    x: 140,
    y: 80,
    w: 460,
    h: 640,
  });
  assert.deepEqual(moveBox(start, -500, -500, VIEWPORT), {
    x: 8,
    y: 8,
    w: 460,
    h: 640,
  });
  assert.deepEqual(moveBox(start, 5000, 5000, VIEWPORT), {
    x: 812,
    y: 152,
    w: 460,
    h: 640,
  });
});

test("resizing keeps the top-left corner and honours the minimum", () => {
  const start = { x: 100, y: 100, w: 460, h: 400 };
  assert.deepEqual(resizeBox(start, 60, 40, VIEWPORT), {
    x: 100,
    y: 100,
    w: 520,
    h: 440,
  });
  assert.deepEqual(resizeBox(start, -900, -900, VIEWPORT), {
    x: 100,
    y: 100,
    w: MIN_DOCK_W,
    h: MIN_DOCK_H,
  });
  // Growing past the viewport stops at the right/bottom edge.
  assert.deepEqual(resizeBox(start, 5000, 5000, VIEWPORT), {
    x: 100,
    y: 100,
    w: 1280 - 8 - 100,
    h: 800 - 8 - 100,
  });
});

test("a stored box is validated", () => {
  assert.deepEqual(parseBox('{"x":1,"y":2,"w":3,"h":4}'), {
    x: 1,
    y: 2,
    w: 3,
    h: 4,
  });
  assert.equal(parseBox(null), null);
  assert.equal(parseBox(""), null);
  assert.equal(parseBox("{"), null);
  assert.equal(parseBox('{"x":1,"y":2,"w":3}'), null);
  assert.equal(parseBox('{"x":1,"y":2,"w":3,"h":"4"}'), null);
  assert.equal(parseBox('{"x":1,"y":2,"w":3,"h":null}'), null);
});
