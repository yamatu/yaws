import test from "node:test";
import assert from "node:assert/strict";
import {
  filterConversations,
  groupConversations,
  relativeTime,
  startOfDay,
  visibleConversations,
} from "../src/ui/conversations.ts";

const NOW = new Date("2026-03-10T15:30:00").getTime();
const ago = (ms) => NOW - ms;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function row(id, updatedAt, extra = {}) {
  return { id, title: `对话 ${id}`, root: "/srv/app", turns: 1, updatedAt, ...extra };
}

test("ages are rendered in human units", () => {
  assert.equal(relativeTime(NOW, NOW - 5_000), "刚刚");
  assert.equal(relativeTime(NOW, ago(12 * MINUTE)), "12 分钟前");
  assert.equal(relativeTime(NOW, ago(3 * HOUR)), "3 小时前");
  // Same day but more than two hours earlier still reads as hours.
  assert.equal(relativeTime(NOW, ago(5 * HOUR)), "5 小时前");
  assert.equal(relativeTime(new Date("2026-03-10T01:00:00").getTime(), now_minus_days(1)), "昨天");
  assert.equal(relativeTime(NOW, now_minus_days(3)), "3 天前");
  assert.equal(relativeTime(NOW, now_minus_days(30)), "2026-02-08");
  assert.equal(relativeTime(NOW, 0), "");
});

function now_minus_days(days) {
  return startOfDay(NOW) - days * 86_400_000 + 9 * HOUR;
}

test("conversations are grouped into day buckets, newest first", () => {
  const groups = groupConversations(
    [
      row("a", ago(10 * MINUTE)),
      row("b", now_minus_days(1)),
      row("c", now_minus_days(3)),
      row("d", now_minus_days(40)),
      row("e", ago(2 * HOUR)),
      row("f", now_minus_days(6)),
    ],
    NOW,
  );
  assert.deepEqual(
    groups.map((group) => group.label),
    ["今天", "昨天", "最近 7 天", "更早"],
  );
  assert.deepEqual(
    groups.map((group) => group.items.map((item) => item.id)),
    [
      ["a", "e"],
      ["b"],
      ["c", "f"],
      ["d"],
    ],
  );
  // Empty buckets are dropped entirely.
  assert.deepEqual(
    groupConversations([row("x", ago(MINUTE))], NOW).map((g) => g.label),
    ["今天"],
  );
  assert.deepEqual(groupConversations([], NOW), []);
});

test("search matches titles, roots, models and previews", () => {
  const list = [
    row("a", NOW, { title: "排查磁盘", preview: "df -h /" }),
    row("b", NOW, { title: "Nginx 502", root: "/etc/nginx", model: "fast" }),
    row("c", NOW, { title: "其他", preview: "内存占用" }),
  ];
  assert.deepEqual(filterConversations(list, "").map((i) => i.id), ["a", "b", "c"]);
  assert.deepEqual(filterConversations(list, "  ").map((i) => i.id), ["a", "b", "c"]);
  assert.deepEqual(filterConversations(list, "磁盘").map((i) => i.id), ["a"]);
  assert.deepEqual(filterConversations(list, "NGINX").map((i) => i.id), ["b"]);
  assert.deepEqual(filterConversations(list, "/etc").map((i) => i.id), ["b"]);
  assert.deepEqual(filterConversations(list, "fast").map((i) => i.id), ["b"]);
  assert.deepEqual(filterConversations(list, "内存").map((i) => i.id), ["c"]);
  assert.deepEqual(filterConversations(list, "没有这个").map((i) => i.id), []);
});

test("keyboard navigation follows the rendered order", () => {
  const list = [
    row("old", now_minus_days(9)),
    row("new", ago(MINUTE)),
    row("mid", now_minus_days(2)),
  ];
  assert.deepEqual(
    visibleConversations(list, "", NOW).map((item) => item.id),
    ["new", "mid", "old"],
  );
  assert.deepEqual(
    visibleConversations(list, "mid", NOW).map((item) => item.id),
    ["mid"],
  );
});
