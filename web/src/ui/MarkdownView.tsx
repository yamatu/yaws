import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import {
  parseMarkdown,
  type Align,
  type Block,
  type Inline,
  type ListItem,
} from "./markdown";
import { copyText } from "./clipboard";

/**
 * Renders assistant answers as Markdown. Everything is built from React
 * elements — never `dangerouslySetInnerHTML` — so a malicious answer or file
 * content can echo `<script>` without any chance of it running.
 */

const LABELS: Record<string, string> = {
  sh: "Shell",
  shell: "Shell",
  bash: "Shell",
  zsh: "Shell",
  console: "Shell",
  consolelog: "Shell",
  ps1: "PowerShell",
  powershell: "PowerShell",
  js: "JavaScript",
  javascript: "JavaScript",
  ts: "TypeScript",
  typescript: "TypeScript",
  json: "JSON",
  yaml: "YAML",
  yml: "YAML",
  toml: "TOML",
  ini: "INI",
  conf: "配置",
  nginx: "Nginx",
  dockerfile: "Dockerfile",
  sql: "SQL",
  py: "Python",
  python: "Python",
  go: "Go",
  java: "Java",
  css: "CSS",
  html: "HTML",
  xml: "XML",
  md: "Markdown",
  diff: "diff",
  text: "文本",
  txt: "文本",
};

function languageLabel(lang: string): string {
  if (!lang) return "";
  return LABELS[lang.toLowerCase()] ?? lang;
}

function InlineRun({ nodes }: { nodes: Inline[] }) {
  return (
    <>
      {nodes.map((node, index) => (
        <InlineNode key={index} node={node} />
      ))}
    </>
  );
}

function InlineNode({ node }: { node: Inline }) {
  switch (node.kind) {
    case "text":
      return <>{node.text}</>;
    case "break":
      return <br />;
    case "code":
      return <code className="ai-md-code">{node.text}</code>;
    case "strong":
      return (
        <strong>
          <InlineRun nodes={node.children} />
        </strong>
      );
    case "em":
      return (
        <em>
          <InlineRun nodes={node.children} />
        </em>
      );
    case "del":
      return (
        <del>
          <InlineRun nodes={node.children} />
        </del>
      );
    case "link":
      return (
        <a href={node.href} target="_blank" rel="noreferrer noopener">
          <InlineRun nodes={node.children} />
        </a>
      );
  }
}

function CodeBlock({ lang, text }: { lang: string; text: string }) {
  const [state, setState] = useState<"idle" | "done" | "fail">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  const copy = async () => {
    const ok = await copyText(text);
    setState(ok ? "done" : "fail");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), 1600);
  };
  return (
    <div className="ai-code">
      <div className="ai-code-head">
        <span className="ai-code-lang">{languageLabel(lang)}</span>
        <button
          type="button"
          className="ai-code-copy"
          onClick={copy}
          aria-label="复制代码"
          title="复制代码"
        >
          {state === "done" ? <Check size={13} /> : <Copy size={13} />}
          {state === "done" ? "已复制" : state === "fail" ? "复制失败" : "复制"}
        </button>
      </div>
      <pre>
        <code>{text}</code>
      </pre>
    </div>
  );
}

function TableBlock({ block }: { block: Extract<Block, { kind: "table" }> }) {
  const align = (index: number): Align => block.align[index] ?? "left";
  return (
    <div className="ai-md-scroll">
      <table>
        <thead>
          <tr>
            {block.head.map((cell, index) => (
              <th key={index} style={{ textAlign: align(index) }}>
                <InlineRun nodes={cell} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {block.rows.map((row, index) => (
            <tr key={index}>
              {block.align.map((_, cell) => (
                <td key={cell} style={{ textAlign: align(cell) }}>
                  <InlineRun nodes={row[cell] ?? []} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ListBlock({ block }: { block: Extract<Block, { kind: "list" }> }) {
  const items: ListItem[] = block.items;
  const tasks = items.some((item) => item.checked !== undefined);
  const Tag = block.ordered ? "ol" : "ul";
  return (
    <Tag
      className={tasks ? "ai-md-tasks" : undefined}
      start={block.ordered && block.start !== 1 ? block.start : undefined}
    >
      {items.map((item, index) => (
        <li key={index} className={item.checked === undefined ? undefined : "ai-md-task"}>
          {item.checked === undefined ? null : (
            <span className={`ai-md-check${item.checked ? " on" : ""}`} aria-hidden="true">
              {item.checked ? "☑" : "☐"}
            </span>
          )}
          <InlineRun nodes={item.children} />
          {item.blocks.length ? <BlockRun blocks={item.blocks} /> : null}
        </li>
      ))}
    </Tag>
  );
}

function BlockNode({ block }: { block: Block }) {
  switch (block.kind) {
    case "heading": {
      const Tag = `h${Math.min(block.level, 6)}` as "h1";
      return (
        <Tag className={`ai-md-h ai-md-h${Math.min(block.level, 4)}`}>
          <InlineRun nodes={block.children} />
        </Tag>
      );
    }
    case "paragraph":
      return (
        <p>
          <InlineRun nodes={block.children} />
        </p>
      );
    case "code":
      return <CodeBlock lang={block.lang} text={block.text} />;
    case "list":
      return <ListBlock block={block} />;
    case "quote":
      return (
        <blockquote className="ai-md-quote">
          <BlockRun blocks={block.blocks} />
        </blockquote>
      );
    case "divider":
      return <hr className="ai-md-rule" />;
    case "table":
      return <TableBlock block={block} />;
  }
}

function BlockRun({ blocks }: { blocks: Block[] }) {
  return (
    <>
      {blocks.map((block, index) => (
        <BlockNode key={index} block={block} />
      ))}
    </>
  );
}

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  if (!blocks.length) return null;
  return <BlockRun blocks={blocks} />;
});
