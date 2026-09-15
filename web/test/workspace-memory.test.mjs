import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_CURSOR_FILES,
  cursorKey,
  dirname,
  readCursor,
  readView,
  storedPath,
  storedTab,
  tabKey,
  viewKey,
  writeCursor,
  writeView,
} from "../src/ui/workspaceMemory.ts";

test("storage keys are scoped to one machine", () => {
  assert.equal(tabKey(7), "yaws.ssh.tab.7");
  assert.equal(viewKey(7), "yaws.workspace.view.7");
  assert.equal(cursorKey(7), "yaws.workspace.cursor.7");
  assert.notEqual(tabKey(1), tabKey(2));
});

test("only known tabs are restored", () => {
  assert.equal(storedTab("files"), "files");
  assert.equal(storedTab("ai"), "ai");
  assert.equal(storedTab("terminal"), "terminal");
  assert.equal(storedTab("nope"), "terminal");
  assert.equal(storedTab(null), "terminal");
  assert.equal(storedTab(42), "terminal");
});

test("only sane absolute paths are remembered", () => {
  assert.equal(storedPath("/srv/app/config.json"), "/srv/app/config.json");
  assert.equal(storedPath("/"), "/");
  assert.equal(storedPath("relative.txt"), null);
  assert.equal(storedPath("/srv/../etc/passwd"), null);
  assert.equal(storedPath("/srv/./app"), null);
  assert.equal(storedPath("/srv/app\nfoo"), null);
  assert.equal(storedPath(`/${"a".repeat(5000)}`), null);
  assert.equal(storedPath(7), null);
  assert.equal(storedPath(undefined), null);
});

test("dirname walks up one level", () => {
  assert.equal(dirname("/srv/app/config.json"), "/srv/app");
  assert.equal(dirname("/srv/app/"), "/srv");
  assert.equal(dirname("/srv"), "/");
  assert.equal(dirname("/"), "/");
});

test("the remembered view survives a round trip", () => {
  const raw = writeView("/srv/app", "/srv/app/config.json");
  assert.deepEqual(readView(raw), {
    dir: "/srv/app",
    file: "/srv/app/config.json",
  });
  assert.deepEqual(readView(writeView("/srv/app", null)), {
    dir: "/srv/app",
    file: null,
  });
});

test("a corrupt or hostile view falls back to the root", () => {
  assert.deepEqual(readView("{not json"), { dir: "/", file: null });
  assert.deepEqual(readView("[]"), { dir: "/", file: null });
  assert.deepEqual(readView("null"), { dir: "/", file: null });
  assert.deepEqual(readView(null), { dir: "/", file: null });
  assert.deepEqual(readView(JSON.stringify({ dir: "etc", file: 5 })), {
    dir: "/",
    file: null,
  });
});

test("a view without a file keeps the directory", () => {
  assert.deepEqual(readView(writeView("/etc/nginx", null)), {
    dir: "/etc/nginx",
    file: null,
  });
});

test("the caret is remembered per file and clamped to the document", () => {
  let raw = writeCursor(null, "/srv/app/config.json", {
    anchor: 12,
    head: 12,
    scrollTop: 240,
  }, 100);
  assert.deepEqual(readCursor(raw, "/srv/app/config.json", 100), {
    anchor: 12,
    head: 12,
    scrollTop: 240,
  });
  // A shorter file on the next visit cannot push the caret past the end.
  assert.deepEqual(readCursor(raw, "/srv/app/config.json", 5), {
    anchor: 5,
    head: 5,
    scrollTop: 240,
  });
  // Another file has no remembered caret of its own.
  assert.equal(readCursor(raw, "/etc/nginx/nginx.conf", 100), null);
});

test("a caret at the very start of a file is not remembered", () => {
  const raw = writeCursor(null, "/a.txt", { anchor: 0, head: 0, scrollTop: 0 }, 10);
  assert.equal(readCursor(raw, "/a.txt", 10), null);
});

test("several files keep their own caret and only the newest survive", () => {
  let raw = writeCursor(null, "/a.txt", { anchor: 1, head: 1, scrollTop: 0 }, 50);
  raw = writeCursor(raw, "/b.txt", { anchor: 2, head: 2, scrollTop: 0 }, 50);
  raw = writeCursor(raw, "/c.txt", { anchor: 3, head: 3, scrollTop: 0 }, 50);
  assert.equal(readCursor(raw, "/a.txt", 50).anchor, 1);
  assert.equal(readCursor(raw, "/b.txt", 50).anchor, 2);
  assert.equal(readCursor(raw, "/c.txt", 50).anchor, 3);

  let capped = "null";
  for (let i = 0; i < MAX_CURSOR_FILES + 5; i += 1) {
    capped = writeCursor(capped, `/file-${i}.txt`, {
      anchor: i + 1,
      head: i + 1,
      scrollTop: 0,
    }, 50);
  }
  const kept = JSON.parse(capped);
  assert.equal(Object.keys(kept).length, MAX_CURSOR_FILES);
  assert.equal(readCursor(capped, "/file-0.txt", 50), null);
  assert.equal(
    readCursor(capped, `/file-${MAX_CURSOR_FILES + 4}.txt`, 50).anchor,
    MAX_CURSOR_FILES + 5,
  );
});

test("garbage in the caret store is ignored, not thrown", () => {
  assert.equal(readCursor("not json", "/a.txt", 10), null);
  assert.equal(readCursor("42", "/a.txt", 10), null);
  assert.equal(
    readCursor(JSON.stringify({ "/a.txt": { anchor: "x", head: null } }), "/a.txt", 10),
    null,
  );
  assert.equal(
    readCursor(JSON.stringify({ "relative.txt": { anchor: 3 } }), "relative.txt", 10),
    null,
  );
  const negative = writeCursor(null, "/a.txt", { anchor: -20, head: -1, scrollTop: -5 }, 10);
  assert.equal(readCursor(negative, "/a.txt", 10), null);
});

test("writing the same file again replaces its caret", () => {
  let raw = writeCursor(null, "/a.txt", { anchor: 1, head: 1, scrollTop: 0 }, 10);
  raw = writeCursor(raw, "/a.txt", { anchor: 4, head: 4, scrollTop: 90 }, 10);
  assert.equal(Object.keys(JSON.parse(raw)).length, 1);
  assert.deepEqual(readCursor(raw, "/a.txt", 10), {
    anchor: 4,
    head: 4,
    scrollTop: 90,
  });
});
