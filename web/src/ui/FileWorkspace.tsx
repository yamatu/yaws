import { lazy, Suspense, useEffect, useRef, useState } from "react";
import {
  ArrowUp,
  Download,
  File,
  Folder,
  RefreshCw,
  Save,
  Upload,
  FilePlus,
} from "lucide-react";
import { apiFetch, apiFetchBlob } from "./api";
import { getToken } from "./auth";
import { workspaceError } from "./workspaceErrors";
const Editor = lazy(() =>
  import("./WorkspaceEditor").then((m) => ({ default: m.WorkspaceEditor })),
);
type Entry = {
  name: string;
  path: string;
  directory: boolean;
  symlink: boolean;
  size: number;
};
type OpenFile = { path: string; content: string; revision: string | null };
export function FileWorkspace({
  machineId,
  onRoot,
}: {
  machineId: number;
  onRoot: (path: string) => void;
}) {
  const base = `/api/machines/${machineId}/workspace`;
  const [dir, setDir] = useState("/");
  const [pathInput, setPathInput] = useState("/");
  const [entries, setEntries] = useState<Entry[]>([]);
  const [products, setProducts] = useState<
    Array<{ name: string; path: string }>
  >([]);
  const [file, setFile] = useState<OpenFile | null>(null);
  const [content, setContent] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const upload = useRef<HTMLInputElement>(null);
  const request = useRef<AbortController | null>(null);
  const dirty = file != null && file.content !== content;
  useEffect(() => {
    const ac = new AbortController();
    void apiFetch<{
      home: string;
      products: Array<{ name: string; path: string }>;
    }>(`${base}/products`, { signal: ac.signal })
      .then((r) => {
        setProducts([{ name: "用户目录", path: r.home }, ...r.products]);
      })
      .catch((e: unknown) => {
        if (!ac.signal.aborted) setError(workspaceError(e));
      });
    void browse("/");
    return () => {
      ac.abort();
      request.current?.abort();
    };
  }, [base]);
  useEffect(() => {
    if (!dirty) return;
    const before = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", before);
    return () => window.removeEventListener("beforeunload", before);
  }, [dirty]);
  async function browse(path: string) {
    request.current?.abort();
    const ac = new AbortController();
    request.current = ac;
    setBusy(true);
    setError("");
    try {
      const r = await apiFetch<{ path: string; entries: Entry[] }>(
        `${base}/files?path=${encodeURIComponent(path)}`,
        { signal: ac.signal },
      );
      if (ac.signal.aborted) return;
      setDir(r.path);
      setPathInput(r.path);
      setEntries(r.entries);
      onRoot(r.path);
    } catch (e) {
      if (!ac.signal.aborted) setError(workspaceError(e));
    } finally {
      if (!ac.signal.aborted) setBusy(false);
    }
  }
  async function open(path: string) {
    if (dirty && !window.confirm("放弃当前文件未保存的修改？")) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const r = await apiFetch<OpenFile>(
        `${base}/file?path=${encodeURIComponent(path)}`,
      );
      setFile(r);
      setContent(r.content);
    } catch (e) {
      setError(workspaceError(e));
    } finally {
      setBusy(false);
    }
  }
  async function select(entry: Entry) {
    if (!entry.symlink)
      return entry.directory ? browse(entry.path) : open(entry.path);
    try {
      const actual = await apiFetch<{ path: string; directory: boolean }>(
        `${base}/resolve?path=${encodeURIComponent(entry.path)}`,
      );
      await (actual.directory ? browse(actual.path) : open(actual.path));
    } catch (e) {
      setError(workspaceError(e));
    }
  }
  async function save() {
    if (!file) return;
    setBusy(true);
    setError("");
    try {
      const r = await apiFetch<{
        path: string;
        revision: string;
        backup: string | null;
      }>(`${base}/file`, {
        method: "PUT",
        body: JSON.stringify({
          path: file.path,
          content,
          revision: file.revision,
        }),
      });
      setFile({ path: r.path, content, revision: r.revision });
      setNotice(r.backup ? `已保存 · 备份 ${r.backup}` : "已创建");
    } catch (e) {
      setError(workspaceError(e));
    } finally {
      setBusy(false);
    }
  }
  async function download(path: string) {
    setError("");
    try {
      const r = await apiFetchBlob(
        `${base}/download?path=${encodeURIComponent(path)}`,
      );
      const url = URL.createObjectURL(r.blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = path.split("/").pop() ?? "download";
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (e) {
      setError(workspaceError(e));
    }
  }
  async function sendFile(selected: globalThis.File) {
    if (selected.size > 8 * 1024 * 1024) {
      setError("上传文件最大 8 MiB");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const path = `${dir.replace(/\/$/, "")}/${selected.name}`;
      const res = await fetch(
        `${base}/upload?path=${encodeURIComponent(path)}`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${getToken()}`,
            "content-type": "application/octet-stream",
          },
          body: selected,
        },
      );
      if (!res.ok) {
        const body = (await res.json()) as { error?: string };
        throw new Error(body.error ?? `http_${res.status}`);
      }
      setNotice(`已上传 ${selected.name}`);
      await browse(dir);
    } catch (e) {
      setError(workspaceError(e));
    } finally {
      setBusy(false);
      if (upload.current) upload.current.value = "";
    }
  }
  return (
    <div className="file-workspace">
      <aside className="file-sidebar">
        <select
          aria-label="产品目录"
          className="yaws-select w-full"
          value=""
          onChange={(e) => void browse(e.target.value)}
        >
          <option value="">产品目录</option>
          {products.map((p) => (
            <option key={`${p.name}:${p.path}`} value={p.path}>
              {p.name} · {p.path}
            </option>
          ))}
        </select>
        <form
          className="workspace-toolbar"
          onSubmit={(e) => {
            e.preventDefault();
            void browse(pathInput);
          }}
        >
          <input
            aria-label="目录路径"
            className="yaws-input"
            disabled={busy}
            value={pathInput}
            onChange={(e) => setPathInput(e.target.value)}
          />
          <button
            className="icon-btn"
            disabled={busy}
            title="打开目录"
            aria-label="打开目录"
          >
            <Folder size={17} />
          </button>
        </form>
        <div className="workspace-toolbar">
          <button
            className="icon-btn"
            title="上一级"
            aria-label="上一级"
            disabled={busy}
            onClick={() =>
              void browse(dir.split("/").slice(0, -1).join("/") || "/")
            }
          >
            <ArrowUp size={17} />
          </button>
          <button
            className="icon-btn"
            title="刷新目录"
            aria-label="刷新目录"
            disabled={busy}
            onClick={() => void browse(dir)}
          >
            <RefreshCw size={17} />
          </button>
          <button
            className="icon-btn"
            title="上传文件"
            aria-label="上传文件"
            disabled={busy}
            onClick={() => upload.current?.click()}
          >
            <Upload size={17} />
          </button>
          <input
            ref={upload}
            type="file"
            className="hidden"
            onChange={(e) => {
              if (e.target.files?.[0]) void sendFile(e.target.files[0]);
            }}
          />
          <button
            className="icon-btn"
            title="新建文件"
            aria-label="新建文件"
            disabled={busy}
            onClick={() => {
              if (dirty && !window.confirm("放弃未保存的修改？")) return;
              const name = window.prompt("文件名");
              if (
                !name ||
                /[\\/\x00-\x1f]/.test(name) ||
                name === "." ||
                name === ".."
              )
                return;
              setFile({
                path: `${dir.replace(/\/$/, "")}/${name}`,
                content: "",
                revision: null,
              });
              setContent("");
            }}
          >
            <FilePlus size={17} />
          </button>
        </div>
        <div className="file-list">
          {entries.map((entry) => (
            <div className="file-row" key={entry.path}>
              <button
                disabled={busy}
                title={entry.name}
                onClick={() => void select(entry)}
              >
                {entry.directory ? <Folder size={16} /> : <File size={16} />}
                <span>
                  {entry.name}
                  {entry.symlink ? " ↗" : ""}
                </span>
              </button>
              {!entry.directory && (
                <button
                  className="icon-btn"
                  title="下载文件"
                  aria-label={`下载 ${entry.name}`}
                  onClick={() => void download(entry.path)}
                >
                  <Download size={14} />
                </button>
              )}
            </div>
          ))}
        </div>
      </aside>
      <section className="file-editor-pane">
        <div className="workspace-toolbar">
          <span className="flex-1 min-w-0 break-all text-sm">
            {file?.path ?? "文件编辑器"}
            {dirty ? " *" : ""}
          </span>
          <button
            className="icon-btn"
            title="保存文件"
            aria-label="保存文件"
            disabled={busy || !file || (!dirty && file.revision !== null)}
            onClick={() => void save()}
          >
            <Save size={17} />
          </button>
        </div>
        {error && (
          <div role="alert" className="yaws-alert-error">
            {error}
          </div>
        )}
        {notice && <div className="workspace-notice">{notice}</div>}
        {file ? (
          <Suspense fallback={<div className="p-4">加载编辑器…</div>}>
            <Editor path={file.path} value={content} onChange={setContent} />
          </Suspense>
        ) : (
          <div className="workspace-empty">选择文件</div>
        )}
      </section>
    </div>
  );
}
