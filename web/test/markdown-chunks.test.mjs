import test from "node:test";
import assert from "node:assert/strict";
import { stableBoundary } from "../src/ui/markdownChunks.ts";
import { parseMarkdown } from "../src/ui/markdown.ts";

/**
 * What `MarkdownView` does with a growing answer: freeze everything up to the
 * boundary, keep parsing only the part after it. Returns the blocks as they
 * would be mounted, so the test can compare them with a single parse of the
 * whole text — the boundary must never change what the answer looks like.
 */
function view() {
  let boundary = 0;
  let frozen = [];
  let source = "";
  return (text) => {
    if (!text.startsWith(source)) {
      boundary = 0;
      frozen = [];
    }
    const next = stableBoundary(text, boundary);
    if (next > boundary) {
      frozen = [...frozen, ...parseMarkdown(text.slice(boundary, next))];
      boundary = next;
    }
    source = text;
    return [...frozen, ...parseMarkdown(text.slice(boundary))];
  };
}

/** Replays `doc` into the view one `step` characters at a time. */
function incremental(doc, step = 1) {
  const render = view();
  for (let end = 0; end < doc.length; end += step) render(doc.slice(0, end));
  return render(doc);
}

test("a paragraph followed by a blank line can be frozen", () => {
  const text = "第一段\n\n第二段正在写\n";
  assert.equal(text.slice(stableBoundary(text)), "第二段正在写\n");
  // A line that is still being written cannot be judged: the token that turns
  // `-` into a list item belongs to the list above the blank line.
  assert.equal(stableBoundary("第一段\n\n-"), 0);
  assert.equal(stableBoundary("第一段\n\n还没写完"), 0);
  const list = "第一段\n\n- 三\n";
  assert.equal(stableBoundary(list), 0, "a list item cannot start a chunk");
});

test("an unfinished paragraph or code block is never cut", () => {
  assert.equal(stableBoundary("还在写的一句话，没有空行"), 0);
  assert.equal(stableBoundary("```sh\ndf -h /\n\n这里还是代码\n```"), 0);
  // A blank line inside the fence is not a boundary either.
  const open = "第一段\n\n```sh\ndf -h /\n\n";
  assert.equal(open.slice(stableBoundary(open)), "```sh\ndf -h /\n\n");
});

test("lists and quotes continue across a blank line and are not split", () => {
  const list = "- 一\n- 二\n\n- 三\n";
  assert.equal(stableBoundary(list), 0, "the parser keeps it one list");
  const loose = "- 一\n\n  还是第一项\n";
  assert.equal(stableBoundary(loose), 0, "an indented line belongs to the item");
  const quote = "> 一\n\n> 二\n";
  assert.equal(stableBoundary(quote), 0, "the parser keeps it one quote");
});

test("a finished block before a fresh one is a boundary", () => {
  const text = "- 一\n- 二\n\n# 标题\n";
  assert.equal(text.slice(stableBoundary(text)), "# 标题\n");
  // The furthest safe cut wins: freezing more of the answer is the point.
  const longer = "- 一\n- 二\n\n# 标题\n\n正文\n";
  assert.equal(longer.slice(stableBoundary(longer)), "正文\n");
});

test("from skips what is already frozen", () => {
  const text = "一\n\n二\n\n三\n\n四\n";
  const first = stableBoundary(text);
  assert.equal(text.slice(first), "四\n");
  assert.equal(stableBoundary(text, first), 0, "nothing new to freeze");
  const longer = "一\n\n二\n";
  const frozen = stableBoundary(longer);
  assert.equal(longer.slice(frozen), "二\n");
  const grown = `${longer}\n三\n`;
  assert.equal(grown.slice(stableBoundary(grown, frozen)), "三\n");
  assert.equal(stableBoundary(text, text.length), 0);
});

test("a streamed answer renders exactly like a parse of the whole text", () => {
  const docs = [
    "## 磁盘排查结论\n\n根分区 `/` 已用到 **78%**，建议先清理日志。\n\n1. 第一步\n2. 第二步\n\n```sh\ndf -h /\n\nrm -rf /tmp/*\n```\n\n结束\n",
    "- 一\n- 二\n\n  - 嵌套\n\n- 三\n\n> 引用\n\n> 第二段引用\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n---\n\n最后一段\n",
    "第一段\n\n~~~\n代码\n\n还在代码\n~~~\n\n# 标题\n\n正文\n\n````md\n```\n里面的围栏不算数\n```\n````\n\n完\n",
    "普通段落\n没有空行\n继续写\n\n### 小标题\n\n- [x] 已完成\n- [ ] 未完成\n\n  说明\n",
  ];
  for (const doc of docs) {
    assert.deepEqual(incremental(doc), parseMarkdown(doc), doc);
    // Coarser steps also replay a reconnect (a jump in the middle of a token).
    assert.deepEqual(incremental(doc, 7), parseMarkdown(doc), doc);
    // Tokens land where they land: every step offset must agree.
    for (let step = 2; step < 6; step += 1)
      assert.deepEqual(incremental(doc, step), parseMarkdown(doc), `${step} ${doc}`);
  }
});

test("a replaced answer is rendered from scratch", () => {
  const render = view();
  const old = "旧的回答\n\n另一段\n\n";
  render(old);
  // A rewrite (`answer` frame, a replay after a reconnect) is not an append:
  // reusing the frozen chunks of the old text would splice two answers.
  const replaced = "# 新的回答\n\n新的正文";
  assert.equal(replaced.startsWith(old), false);
  assert.deepEqual(render(replaced), parseMarkdown(replaced));
});
