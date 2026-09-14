/**
 * A small, dependency-free Markdown subset for assistant answers.
 *
 * The parser returns plain data (`Block[]` / `Inline[]`) which `Markdown.tsx`
 * turns into React elements. Nothing is ever injected as HTML, so a `<script>`
 * or an `onerror=` attribute coming from a model — or from a file the assistant
 * read — is always displayed as text instead of being executed.
 *
 * Supported: headings, paragraphs with soft line breaks, fenced code blocks,
 * ordered/unordered (and nested) lists, task lists, blockquotes, tables,
 * horizontal rules, inline code, bold/italic/strikethrough, links, autolinks.
 * Remote images are shown as links: they are never fetched.
 */

export type Align = "left" | "center" | "right";

export type Inline =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "break" }
  | { kind: "strong"; children: Inline[] }
  | { kind: "em"; children: Inline[] }
  | { kind: "del"; children: Inline[] }
  | { kind: "link"; href: string; children: Inline[] };

export type ListItem = {
  children: Inline[];
  /** Set for `- [ ]` / `- [x]` items. */
  checked?: boolean;
  /** Nested lists, code blocks… that belong to the item body. */
  blocks: Block[];
};

export type Block =
  | { kind: "heading"; level: number; children: Inline[] }
  | { kind: "paragraph"; children: Inline[] }
  | { kind: "code"; lang: string; text: string }
  | { kind: "list"; ordered: boolean; start: number; items: ListItem[] }
  | { kind: "quote"; blocks: Block[] }
  | { kind: "divider" }
  | { kind: "table"; align: Align[]; head: Inline[][]; rows: Inline[][][] };

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** Entities are decoded for display only; React escapes them again on render. */
export function decodeEntities(text: string): string {
  return text.replace(/&(?:#(\d{1,6})|#x([0-9a-f]{1,5})|([a-z]{2,8}));/gi, (all, dec, hex, name) => {
    if (dec) return codePoint(Number(dec));
    if (hex) return codePoint(parseInt(hex, 16));
    return ENTITIES[String(name).toLowerCase()] ?? all;
  });
}

function codePoint(value: number): string {
  if (!Number.isFinite(value) || value < 0 || value > 0x10ffff) return "";
  try {
    return String.fromCodePoint(value);
  } catch {
    return "";
  }
}

/** Only http(s) and mailto links survive; everything else stays plain text. */
export function safeHref(raw: string): string {
  const href = raw.trim().replace(/[\u0000-\u001f\u007f]/g, "");
  if (!/^(https?:\/\/|mailto:)/i.test(href)) return "";
  if (/\s/.test(href)) return "";
  return href;
}

function isDivider(line: string): boolean {
  return /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line);
}

function isFenceStart(line: string): boolean {
  return /^\s*(?:```|~~~)/.test(line);
}

function isBlockStart(line: string): boolean {
  return (
    isFenceStart(line) ||
    /^\s{0,3}#{1,6}\s/.test(line) ||
    /^\s{0,3}>/.test(line) ||
    isDivider(line) ||
    /^\s{0,3}(?:[-*+]|\d{1,9}[.)])\s+/.test(line)
  );
}

type Marker = { indent: number; ordered: boolean; start: number; rest: string };

function listMarker(line: string): Marker | null {
  const match = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/.exec(line);
  if (!match) return null;
  if (isDivider(line) && !/\d/.test(match[2])) return null;
  const ordered = /^\d/.test(match[2]);
  const indent = match[1].replace(/\t/g, "    ").length;
  return {
    indent,
    ordered,
    start: ordered ? Number.parseInt(match[2], 10) || 1 : 1,
    rest: match[3],
  };
}

function splitRow(line: string): string[] {
  const body = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let current = "";
  for (let i = 0; i < body.length; i++) {
    if (body[i] === "\\" && body[i + 1] === "|") {
      current += "|";
      i++;
      continue;
    }
    if (body[i] === "|") {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += body[i];
  }
  cells.push(current.trim());
  return cells;
}

function alignments(line: string): Align[] | null {
  const cells = splitRow(line);
  if (!cells.length) return null;
  const align: Align[] = [];
  for (const cell of cells) {
    if (!/^:?-{1,}:?$/.test(cell.replace(/\s/g, ""))) return null;
    const left = cell.startsWith(":");
    const right = cell.endsWith(":");
    align.push(left && right ? "center" : right ? "right" : "left");
  }
  return align;
}

/** `***bold italic***`, `**bold**`, `*italic*`, `~~gone~~`, `` `code` ``. */
function matchDelimiter(
  src: string,
  start: number,
  marker: string,
): { value: string; length: number } | null {
  const from = start + marker.length;
  const end = src.indexOf(marker, from);
  if (end <= from) return null;
  const value = src.slice(from, end);
  if (value.includes("\n") || /^\s|\s$/.test(value)) return null;
  return { value, length: end + marker.length - start };
}

function matchLink(src: string): { href: string; text: string; length: number } | null {
  const match = /^\[([^\]]*)\]\(\s*(<[^>]*>|[^)\s]*)(?:\s+"[^"]*")?\s*\)/.exec(src);
  if (!match) return null;
  const raw = match[2].replace(/^<|>$/g, "");
  const href = safeHref(raw.replace(/\\([()])/g, "$1"));
  if (!href) return null;
  return { href, text: match[1], length: match[0].length };
}

function matchAutolink(src: string): { href: string; text: string; length: number } | null {
  const match = /^<([a-z][a-z0-9+.-]*:[^<>\s]+|[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+)>/i.exec(src);
  if (!match) return null;
  const inner = match[1];
  const href = safeHref(inner.includes("@") && !/^[a-z][a-z0-9+.-]*:/i.test(inner) ? `mailto:${inner}` : inner);
  if (!href) return null;
  return { href, text: inner, length: match[0].length };
}

function matchUrl(src: string): { href: string; text: string; length: number } | null {
  // CJK punctuation ends a URL: 「见 https://x，详情…」.
  const match = /^https?:\/\/[^\s<>"'`，。、；：！？（）【】「」《》]+/i.exec(src);
  if (!match) return null;
  const text = match[0].replace(/[.,;:!?。，、；：！？）】」》)\]}]+$/, "");
  if (!text) return null;
  const href = safeHref(text);
  if (!href) return null;
  return { href, text, length: text.length };
}

/** `snake_case_name` keeps its underscores: `_` needs a word boundary. */
function intraword(source: string, start: number, marker: string): boolean {
  if (!marker.startsWith("_")) return false;
  const before = start > 0 ? source[start - 1] : "";
  const after = source[start + marker.length];
  return /[A-Za-z0-9]/.test(before) || /[A-Za-z0-9]/.test(after ?? "");
}

export function parseInline(source: string): Inline[] {
  const out: Inline[] = [];
  let text = "";
  const flush = () => {
    if (text) out.push({ kind: "text", text: decodeEntities(text) });
    text = "";
  };
  const push = (node: Inline) => {
    flush();
    out.push(node);
  };
  let i = 0;
  while (i < source.length) {
    const rest = source.slice(i);
    const char = source[i];
    if (char === "\\" && i + 1 < source.length && /[\\`*_~[\]()#!>|+\-.!]/.test(source[i + 1])) {
      text += source[i + 1];
      i += 2;
      continue;
    }
    if (char === "\n") {
      push({ kind: "break" });
      i++;
      continue;
    }
    if (char === "`") {
      const ticks = /^`+/.exec(rest)![0];
      const end = rest.indexOf(ticks, ticks.length);
      if (end > ticks.length) {
        const value = rest.slice(ticks.length, end);
        if (!value.includes("\n")) {
          push({ kind: "code", text: value.trim() });
          i += end + ticks.length;
          continue;
        }
      }
    }
    if (char === "[" || (char === "!" && source[i + 1] === "[")) {
      const image = char === "!";
      const link = matchLink(image ? rest.slice(1) : rest);
      if (link) {
        push({ kind: "link", href: link.href, children: parseInline(link.text) });
        i += link.length + (image ? 1 : 0);
        continue;
      }
    }
    if (char === "<") {
      const auto = matchAutolink(rest);
      if (auto) {
        push({ kind: "link", href: auto.href, children: [{ kind: "text", text: auto.text }] });
        i += auto.length;
        continue;
      }
    }
    if (/^https?:\/\//i.test(rest) && (i === 0 || /[\s(（[【「『"'>]/.test(source[i - 1]))) {
      const url = matchUrl(rest);
      if (url) {
        push({ kind: "link", href: url.href, children: [{ kind: "text", text: url.text }] });
        i += url.length;
        continue;
      }
    }
    if (rest.startsWith("***")) {
      const inner = matchDelimiter(source, i, "***");
      if (inner) {
        push({
          kind: "strong",
          children: [{ kind: "em", children: parseInline(inner.value) }],
        });
        i += inner.length;
        continue;
      }
    }
    if (rest.startsWith("**") || rest.startsWith("__")) {
      const marker = rest.slice(0, 2);
      const inner = matchDelimiter(source, i, marker);
      if (inner && !intraword(source, i, marker)) {
        push({ kind: "strong", children: parseInline(inner.value) });
        i += inner.length;
        continue;
      }
    }
    if (rest.startsWith("~~")) {
      const inner = matchDelimiter(source, i, "~~");
      if (inner) {
        push({ kind: "del", children: parseInline(inner.value) });
        i += inner.length;
        continue;
      }
    }
    if (char === "*" || char === "_") {
      const inner = matchDelimiter(source, i, char);
      if (inner && !intraword(source, i, char)) {
        push({ kind: "em", children: parseInline(inner.value) });
        i += inner.length;
        continue;
      }
    }
    text += char;
    i++;
  }
  flush();
  return out;
}

function fences(lines: string[], index: number, end: number): { block: Block; next: number } {
  const match = /^\s*(`{3,}|~{3,})\s*(\S*)/.exec(lines[index])!;
  const char = match[1][0];
  const length = match[1].length;
  const lang = match[2].replace(/[^A-Za-z0-9+#._-]/g, "").slice(0, 24);
  const close = new RegExp("^\\s*" + (char === "~" ? "~" : "`") + "{" + length + ",}\\s*$");
  const body: string[] = [];
  let i = index + 1;
  // An unterminated fence is normal while the answer is still streaming.
  while (i < end) {
    if (close.test(lines[i])) {
      i++;
      break;
    }
    body.push(lines[i]);
    i++;
  }
  return { block: { kind: "code", lang, text: body.join("\n") }, next: i };
}

function quote(lines: string[], index: number, end: number): { block: Block; next: number } {
  const body: string[] = [];
  let i = index;
  while (i < end) {
    const line = lines[i];
    const match = /^\s{0,3}>\s?(.*)$/.exec(line);
    if (match) {
      body.push(match[1]);
      i++;
      continue;
    }
    if (!line.trim()) {
      // A blank line ends the quote unless the next one continues it.
      if (i + 1 < end && /^\s{0,3}>/.test(lines[i + 1])) {
        body.push("");
        i++;
        continue;
      }
      break;
    }
    if (isBlockStart(line)) break;
    body.push(line);
    i++;
  }
  return { block: { kind: "quote", blocks: parseBlocks(body, 0, body.length) }, next: i };
}

function table(lines: string[], index: number, end: number): { block: Block; next: number } | null {
  if (!lines[index].includes("|")) return null;
  const align = alignments(lines[index + 1] ?? "");
  if (!align || !align.length) return null;
  const head = splitRow(lines[index]);
  if (head.length !== align.length) return null;
  const rows: Inline[][][] = [];
  let i = index + 2;
  while (i < end && lines[i].trim() && lines[i].includes("|")) {
    const cells = splitRow(lines[i]);
    rows.push(align.map((_, cell) => parseInline((cells[cell] ?? "").trim())));
    i++;
  }
  return {
    block: {
      kind: "table",
      align,
      head: head.map((cell) => parseInline(cell)),
      rows,
    },
    next: i,
  };
}

function list(lines: string[], index: number, end: number): { block: Block; next: number } {
  const first = listMarker(lines[index])!;
  const items: ListItem[] = [];
  let i = index;
  while (i < end) {
    const marker = listMarker(lines[i]);
    if (!marker || marker.indent !== first.indent || marker.ordered !== first.ordered) break;
    const body = [marker.rest];
    i++;
    let blank = false;
    while (i < end) {
      const line = lines[i];
      if (!line.trim()) {
        body.push("");
        blank = true;
        i++;
        continue;
      }
      const nested = listMarker(line);
      const indent = line.match(/^\s*/)![0].replace(/\t/g, "    ").length;
      if (nested && nested.indent <= first.indent) break;
      if (indent > marker.indent) {
        body.push(line.slice(Math.min(indent, marker.indent + 2)));
        blank = false;
        i++;
        continue;
      }
      // Lazy continuation: a plain line right after the item text stays inside it.
      if (!blank && !isBlockStart(line)) {
        body.push(line);
        i++;
        continue;
      }
      break;
    }
    while (body.length && !body[body.length - 1].trim()) body.pop();
    let text = body.join("\n");
    let checked: boolean | undefined;
    const task = /^\[( |x|X)\]\s?/.exec(text);
    if (task) {
      checked = task[1].toLowerCase() === "x";
      text = text.slice(task[0].length);
    }
    const head: string[] = [];
    const rest: string[] = [];
    for (const line of text.split("\n")) {
      if (rest.length || (!head.length ? false : isBlockStart(line))) rest.push(line);
      else head.push(line);
    }
    items.push({
      children: parseInline(head.join("\n").trim()),
      checked,
      blocks: rest.length ? parseBlocks(rest, 0, rest.length) : [],
    });
  }
  return {
    block: { kind: "list", ordered: first.ordered, start: first.start, items },
    next: i,
  };
}

export function parseBlocks(lines: string[], start: number, end: number): Block[] {
  const blocks: Block[] = [];
  let i = start;
  while (i < end) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    if (isFenceStart(line)) {
      const result = fences(lines, i, end);
      blocks.push(result.block);
      i = result.next;
      continue;
    }
    const heading = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      blocks.push({
        kind: "heading",
        level: heading[1].length,
        children: parseInline(heading[2]),
      });
      i++;
      continue;
    }
    if (isDivider(line)) {
      blocks.push({ kind: "divider" });
      i++;
      continue;
    }
    if (/^\s{0,3}>/.test(line)) {
      const result = quote(lines, i, end);
      blocks.push(result.block);
      i = result.next;
      continue;
    }
    const cells = table(lines, i, end);
    if (cells) {
      blocks.push(cells.block);
      i = cells.next;
      continue;
    }
    if (listMarker(line)) {
      const result = list(lines, i, end);
      blocks.push(result.block);
      i = result.next;
      continue;
    }
    const paragraph: string[] = [];
    while (i < end) {
      const current = lines[i];
      if (!current.trim()) break;
      if (paragraph.length && isBlockStart(current)) break;
      paragraph.push(current.trim());
      i++;
    }
    blocks.push({ kind: "paragraph", children: parseInline(paragraph.join("\n")) });
  }
  return blocks;
}

export function parseMarkdown(source: string): Block[] {
  const text = String(source ?? "").replace(/\r\n?/g, "\n").replace(/\t/g, "    ");
  if (!text.trim()) return [];
  const lines = text.split("\n");
  return parseBlocks(lines, 0, lines.length);
}
