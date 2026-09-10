import { useEffect, useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { languages } from "@codemirror/language-data";
import type { LanguageSupport } from "@codemirror/language";

export function WorkspaceEditor({
  path,
  value,
  onChange,
  readOnly = false,
}: {
  path: string;
  value: string;
  onChange?: (text: string) => void;
  readOnly?: boolean;
}) {
  const [language, setLanguage] = useState<LanguageSupport | null>(null);
  useEffect(() => {
    let alive = true;
    setLanguage(null);
    const name = path.split("/").pop() ?? "";
    const ext = name.split(".").pop() ?? "";
    const match = languages.find(
      (l) => l.extensions.includes(ext) || l.filename?.test(name),
    );
    if (match)
      void match.load().then((support) => {
        if (alive) setLanguage(support);
      });
    return () => {
      alive = false;
    };
  }, [path]);
  return (
    <CodeMirror
      value={value}
      onChange={onChange}
      theme="dark"
      height="100%"
      className="workspace-editor"
      readOnly={readOnly}
      extensions={language ? [language] : []}
      basicSetup={{
        lineNumbers: true,
        foldGutter: true,
        highlightActiveLine: !readOnly,
        autocompletion: !readOnly,
      }}
    />
  );
}
