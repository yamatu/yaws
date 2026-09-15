import { useEffect, useMemo, useRef, useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { EditorView } from "@codemirror/view";
import type { LanguageSupport } from "@codemirror/language";
import { detectLanguage, MAX_HIGHLIGHT_BYTES } from "./editorLanguage";
import type { CursorState } from "./workspaceMemory";

/** How long the editor waits before reporting where the caret ended up. */
const REPORT_DELAY_MS = 300;

export function WorkspaceEditor({
  path,
  value,
  onChange,
  readOnly = false,
  onLanguage,
  initialCursor = null,
  onCursor,
}: {
  path: string;
  value: string;
  onChange?: (text: string) => void;
  readOnly?: boolean;
  /** Called with the detected language name (or null for plain text). */
  onLanguage?: (name: string | null) => void;
  /** Caret and scroll offset to restore when the file is opened again. */
  initialCursor?: CursorState | null;
  onCursor?: (state: CursorState) => void;
}) {
  const [language, setLanguage] = useState<LanguageSupport | null>(null);
  // The report callback is captured per editor instance, so switching files cannot
  // file the caret of the old file under the new one.
  const report = useRef<(() => void) | null>(null);
  const timer = useRef<number | null>(null);
  // A scroller without a layout box (hidden tab panel or removed node) reports an
  // offset of 0, which would wipe the remembered position, so the last offset seen
  // while the editor was laid out is kept and reused.
  const lastScroll = useRef(initialCursor?.scrollTop ?? 0);
  // Only the head of the file matters for detection (shebang lines), so typing inside a
  // large file does not re-run language matching on every keystroke.
  const probe = value.slice(0, 256);
  const oversized = value.length > MAX_HIGHLIGHT_BYTES;
  const description = useMemo(
    () => (oversized ? null : detectLanguage(path, probe)),
    [oversized, path, probe],
  );

  const flush = () => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    report.current?.();
  };

  const schedule = () => {
    if (!report.current) return;
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      timer.current = null;
      report.current?.();
    }, REPORT_DELAY_MS);
  };

  // Never lose the last position when the tab is closed while a timer is pending.
  useEffect(() => flush, []);

  useEffect(() => {
    let alive = true;
    setLanguage(null);
    onLanguage?.(description?.name ?? null);
    if (!description) return;
    void description
      .load()
      .then((support) => {
        if (alive) setLanguage(support);
      })
      .catch(() => {
        // A missing mode must not break editing: fall back to plain text.
        if (alive) setLanguage(null);
      });
    return () => {
      alive = false;
    };
  }, [description, onLanguage]);

  const extensions = useMemo(
    () => (language ? [EditorView.lineWrapping, language] : [EditorView.lineWrapping]),
    [language],
  );

  return (
    <CodeMirror
      value={value}
      onChange={onChange}
      theme="dark"
      height="100%"
      className="workspace-editor"
      readOnly={readOnly}
      extensions={extensions}
      basicSetup={{
        lineNumbers: true,
        foldGutter: true,
        bracketMatching: true,
        closeBrackets: !readOnly,
        highlightActiveLine: !readOnly,
        highlightSelectionMatches: true,
        autocompletion: !readOnly,
        indentOnInput: true,
      }}
      onCreateEditor={(view) => {
        report.current = () => {
          if (!onCursor) return;
          const { scrollDOM } = view;
          if (scrollDOM.clientHeight > 0) lastScroll.current = scrollDOM.scrollTop;
          const selection = view.state.selection.main;
          onCursor({
            anchor: selection.anchor,
            head: selection.head,
            scrollTop: lastScroll.current,
          });
        };
        if (initialCursor) {
          const max = view.state.doc.length;
          const anchor = Math.min(Math.max(initialCursor.anchor, 0), max);
          const head = Math.min(Math.max(initialCursor.head, 0), max);
          if (anchor !== 0 || head !== 0) {
            view.dispatch({ selection: { anchor, head } });
          }
          // The scroll box only has a height once the document is laid out.
          requestAnimationFrame(() => {
            view.scrollDOM.scrollTop = Math.max(0, initialCursor.scrollTop);
          });
        }
        view.scrollDOM.addEventListener("scroll", schedule, { passive: true });
      }}
      onUpdate={(update) => {
        if (update.docChanged || update.selectionSet) schedule();
      }}
    />
  );
}
