import test from "node:test";
import assert from "node:assert/strict";
import { parseMarkdown, parseInline, safeHref } from "../src/ui/markdown.ts";

/** Flatten inline nodes to `{kind, text}` pairs for compact assertions. */
const flat = (nodes) =>
  nodes.flatMap((node) => {
    if (node.kind === "text") return [{ kind: "text", text: node.text }];
    if (node.kind === "code") return [{ kind: "code", text: node.text }];
    if (node.kind === "break") return [{ kind: "break", text: "\n" }];
    return [...flat(node.children), { kind: node.kind }];
  });

const text = (nodes) => flat(nodes).map((node) => node.text).join("");

test("headings and paragraphs", () => {
  const blocks = parseMarkdown("# 标题\n\n第一段\n第二行\n\n## 小标题");
  assert.deepEqual(
    blocks.map((block) => block.kind),
    ["heading", "paragraph", "heading"],
  );
  assert.equal(blocks[0].level, 1);
  assert.equal(text(blocks[0].children), "标题");
  assert.equal(blocks[1].children[1].kind, "break", "single newlines break the line");
  assert.equal(text(blocks[1].children), "第一段\n第二行");
  assert.equal(blocks[2].level, 2);
});

test("headings without a space and seven hashes are not headings", () => {
  assert.equal(parseMarkdown("#没有空格")[0].kind, "paragraph");
  assert.equal(parseMarkdown("####### 七级")[0].kind, "paragraph");
});

test("fenced code keeps its language and content verbatim", () => {
  const blocks = parseMarkdown("说明：\n\n```sh\ndf -h /\njournalctl --vacuum-size=200M\n```\n\n结束");
  assert.deepEqual(
    blocks.map((block) => block.kind),
    ["paragraph", "code", "paragraph"],
  );
  assert.equal(blocks[1].lang, "sh");
  assert.equal(blocks[1].text, "df -h /\njournalctl --vacuum-size=200M");
  // Markdown inside a fence is literal.
  assert.equal(parseMarkdown("```\n**not bold**\n```")[0].text, "**not bold**");
  assert.equal(parseMarkdown("~~~json\n{}\n~~~")[0].lang, "json");
});

test("an unterminated fence still renders while streaming", () => {
  const block = parseMarkdown("```sh\nsystemctl restart")[0];
  assert.equal(block.kind, "code");
  assert.equal(block.text, "systemctl restart");
});

test("inline emphasis, code and line breaks", () => {
  const nodes = parseInline("**粗** *斜* ~~删~~ `df -h` 文本");
  assert.deepEqual(
    nodes.map((node) => node.kind),
    ["strong", "text", "em", "text", "del", "text", "code", "text"],
  );
  assert.equal(flat(nodes).find((node) => node.kind === "code").text, "df -h");
  assert.equal(flat(parseInline("***都**要*")).length > 0, true);
  assert.equal(parseInline("**未闭合").length, 1, "unclosed markers stay literal");
  assert.equal(text(parseInline("**未闭合")), "**未闭合");
});

test("emphasised code and emphasis inside words", () => {
  assert.equal(text(parseInline("**`total`**")), "total");
  assert.equal(text(parseInline("变量 max_connections 与 file_name")), "变量 max_connections 与 file_name");
  assert.equal(flat(parseInline("变量 max_connections")).some((n) => n.kind === "em"), false);
});

test("links: markdown, autolink and bare URLs", () => {
  const markdown = parseInline("见 [文档](https://example.com/a) 与 <https://b.example> 还有 https://c.example/x。");
  const links = flat(markdown).filter((node) => node.kind === "link");
  assert.deepEqual(markdown.filter((n) => n.kind === "link").map((n) => n.href), [
    "https://example.com/a",
    "https://b.example",
    "https://c.example/x",
  ]);
  assert.equal(links.length, 3);
  assert.equal(markdown.filter((n) => n.kind === "link")[0].children[0].text, "文档");
  // Trailing punctuation stays outside the bare link.
  assert.equal(parseInline("见 https://c.example/x。").at(-1).text, "。");
  assert.equal(trailing().at(-1).text, "，请看下一节");
  function trailing() {
    return parseInline("见 https://c.example/x，请看下一节");
  }
});

test("unsafe link targets are never turned into links", () => {
  for (const source of [
    "[点我](javascript:alert(1))",
    "[点我](JavaScript&#58;alert(1))",
    "[点我](data:text/html;base64,PHNjcmlwdD4=)",
    "[点我](file:///etc/passwd)",
  ]) {
    const nodes = parseInline(source);
    assert.equal(nodes.some((node) => node.kind === "link"), false, source);
    assert.ok(text(nodes).includes("点我"), source);
  }
  assert.equal(safeHref("java\nscript:alert(1)"), "");
  assert.equal(safeHref("  https://ok.example  "), "https://ok.example");
  assert.equal(safeHref("mailto:a@b.example"), "mailto:a@b.example");
});

test("raw HTML from a model or a file is never markup", () => {
  const blocks = parseMarkdown('<script>alert("x")</script>\n\n<img src=x onerror="steal()">');
  assert.deepEqual(blocks.map((block) => block.kind), ["paragraph", "paragraph"]);
  assert.equal(text(blocks[0].children), '<script>alert("x")</script>');
  assert.equal(text(blocks[1].children), '<img src=x onerror="steal()">');
  // An image becomes a link, never a remote fetch.
  const image = parseInline("![截图](https://example.com/a.png)");
  assert.equal(image.length, 1);
  assert.equal(image[0].kind, "link");
  assert.equal(image[0].href, "https://example.com/a.png");
});

test("ordered, unordered and task lists", () => {
  const blocks = parseMarkdown("- 一\n- 二\n\n3. 三\n4. 四");
  assert.equal(blocks[0].kind, "list");
  assert.equal(blocks[0].ordered, false);
  assert.equal(blocks[0].items.length, 2);
  assert.equal(blocks[1].ordered, true);
  assert.equal(blocks[1].start, 3);
  assert.equal(text(blocks[1].items[0].children), "三");

  const tasks = parseMarkdown("- [x] 已完成\n- [ ] 待办");
  assert.deepEqual(
    tasks[0].items.map((item) => item.checked),
    [true, false],
  );
  assert.equal(text(tasks[0].items[1].children), "待办");
});

test("nested lists stay inside their parent item", () => {
  const block = parseMarkdown("- 外层\n  - 内层一\n  - 内层二\n- 第二个")[0];
  assert.equal(block.items.length, 2);
  assert.equal(text(block.items[0].children), "外层");
  assert.equal(block.items[0].blocks[0].kind, "list");
  assert.equal(block.items[0].blocks[0].items.length, 2);
  assert.equal(text(block.items[1].children), "第二个");
});

test("multi-line list items keep their continuation", () => {
  const block = parseMarkdown("- 第一行\n  继续说明\n- 第二项")[0];
  assert.equal(block.items.length, 2);
  assert.equal(text(block.items[0].children), "第一行\n继续说明");
});

test("a list item can hold a code block", () => {
  const block = parseMarkdown("- 步骤一\n\n  ```sh\n  df -h /\n  ```\n\n- 步骤二")[0];
  assert.equal(block.items.length, 2);
  assert.equal(block.items[0].blocks[0].kind, "code");
  assert.equal(block.items[0].blocks[0].text, "df -h /");
});

test("tables with alignment", () => {
  const block = parseMarkdown("| 分区 | 用量 | 状态 |\n| :--- | ---: | :---: |\n| / | 78% | 警告 |\n| /data | 94% | 危险 |")[0];
  assert.equal(block.kind, "table");
  assert.deepEqual(block.align, ["left", "right", "center"]);
  assert.equal(text(block.head[0]), "分区");
  assert.equal(block.rows.length, 2);
  assert.equal(text(block.rows[1][1]), "94%");
  // A row without a delimiter line is a paragraph, not a table.
  assert.equal(parseMarkdown("| 只是 | 一行 |")[0].kind, "paragraph");
});

test("quotes, dividers and wrapped paragraphs", () => {
  const blocks = parseMarkdown("> 注意：删除前备份\n> 第二行\n\n---\n\n正常段落");
  assert.equal(blocks[0].kind, "quote");
  assert.equal(blocks[0].blocks[0].kind, "paragraph");
  assert.equal(text(blocks[0].blocks[0].children), "注意：删除前备份\n第二行");
  assert.equal(blocks[1].kind, "divider");
  assert.equal(blocks[2].kind, "paragraph");
});

test("a list continues lazily, a blank line ends it", () => {
  // CommonMark: a plain line right after an item belongs to that item…
  const lazy = parseMarkdown("- 一\n- 二\n继续这一项");
  assert.deepEqual(lazy.map((block) => block.kind), ["list"]);
  assert.equal(text(lazy[0].items[1].children), "二\n继续这一项");
  // …while a blank line starts a new paragraph.
  const blocks = parseMarkdown("- 一\n- 二\n\n结束语");
  assert.deepEqual(blocks.map((block) => block.kind), ["list", "paragraph"]);
  assert.equal(blocks[1].kind === "paragraph" && text(blocks[1].children), "结束语");
});

test("entities are decoded for display", () => {
  assert.equal(text(parseInline("a &amp; b &lt;tag&gt; &#39;q&#39;")), "a & b <tag> 'q'");
});

test("empty and whitespace-only answers produce no blocks", () => {
  assert.deepEqual(parseMarkdown(""), []);
  assert.deepEqual(parseMarkdown("   \n\n  "), []);
  assert.deepEqual(parseMarkdown(undefined), []);
});
