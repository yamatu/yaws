import { useEffect, useMemo, useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { EditorView } from "@codemirror/view";
import type { LanguageSupport } from "@codemirror/language";
import { detectLanguage, MAX_HIGHLIGHT_BYTES } from "./editorLanguage";

export function WorkspaceEditor({
  path,
  value,
  onChange,
  readOnly = false,
  onLanguage,
}: {
  path: string;
  value: string;
  onChange?: (text: string) => void;
  readOnly?: boolean;
  /** Called with the detected language name (or null for plain text). */
  onLanguage?: (name: string | null) => void;
}) {
  const [language, setLanguage] = useState<LanguageSupport | null>(null);
  // Only the head of the file matters for detection (shebang lines), so typing inside a
  // large file does not re-run language matching on every keystroke.
  const probe = value.slice(0, 256);
  const oversized = value.length > MAX_HIGHLIGHT_BYTES;
  const description = useMemo(
    () => (oversized ? null : detectLanguage(path, probe)),
    [oversized, path, probe],
  );

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
    />
  );
}
