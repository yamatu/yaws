import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  CircleStop,
  Copy,
  Cpu,
  FileCode2,
  FolderTree,
  LoaderCircle,
  MessageSquarePlus,
  Pencil,
  Play,
  Plus,
  Send,
  Settings2,
  Sparkles,
  Terminal,
  Trash2,
  Undo2,
} from "lucide-react";
import { diffLines } from "diff";
import { apiFetch } from "./api";
import {
  type Progress,
  acceptEvent,
  failProgress,
  progressLabel,
  progressTone,
  startProgress,
  stopProgress,
} from "./aiProgress";
import { getToken } from "./auth";
import { workspaceError } from "./workspaceErrors";
import { ConversationPicker } from "./ConversationPicker";
import { Markdown } from "./MarkdownView";
import { orderTurnEntries } from "./chatOrder";
import type { Conversation } from "./conversations";

type Profile = {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  protocol: "chat" | "responses";
  reasoning: string;
  allowPrivate: boolean;
  hasKey?: boolean;
};
/** A profile being edited: `apiKey` empty keeps the stored key unless dropped. */
type Draft = Profile & { apiKey: string; dropKey: boolean };
type AutoRun = "off" | "read" | "all";
type Tool = {
  id: string;
  name: string;
  detail: string;
  state: "running" | "ok" | "error" | "awaiting";
  output?: string;
  code?: number | null;
  readOnly?: boolean;
  auto?: boolean;
  purpose?: string;
};
type Proposal = {
  id: string;
  kind: "file" | "command";
  path: string;
  before: string;
  after: string;
  revision: string;
  status: string;
  summary: string;
  result: { output?: string; code?: number | null; backup?: string | null } | null;
};
type Entry =
  | { key: string; kind: "user"; text: string }
  | { key: string; kind: "assistant"; text: string }
  | { key: string; kind: "tool"; tool: Tool }
  | { key: string; kind: "proposal"; proposal: Proposal }
  | { key: string; kind: "error"; text: string };
/** One stored turn as the conversation endpoint returns it. */
type ChatTurn = {
  runId: string;
  prompt: string;
  answer: string;
  status: string;
  createdAt: number;
  trace: Tool[];
  proposals: Proposal[];
};
export const AUTO_RUN_KEY = "yaws.ai.autorun";
export const AUTO_RUN_MODES: Array<{ value: AutoRun; label: string }> = [
  { value: "read", label: "只读命令自动执行（推荐）" },
  { value: "all", label: "修改类命令也自动执行" },
  { value: "off", label: "每条命令都先确认" },
];
export const PROFILE_KEY = "yaws.ai.profile";
const EXAMPLES = [
  "服务器磁盘和内存现在什么情况？",
  "Nginx 为什么启动失败，帮我查日志并给出修复命令",
  "看看哪个进程占用 CPU 最高",
];

export function storedAutoRun(): AutoRun {
  try {
    const value = localStorage.getItem(AUTO_RUN_KEY);
    if (value === "off" || value === "read" || value === "all") return value;
  } catch {
    // private mode
  }
  return "read";
}

const chatKey = (machineId: number) => `yaws.ai.chat.${machineId}`;

const newId = () =>
  `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

function blankDraft(): Draft {
  return {
    id: newId(),
    name: "新配置",
    baseUrl: "",
    model: "",
    protocol: "chat",
    reasoning: "",
    allowPrivate: false,
    apiKey: "",
    dropKey: false,
  };
}

function toDraft(profile: Profile): Draft {
  return { ...profile, apiKey: "", dropKey: false };
}

/** The stored key is never returned, so an empty field means "keep it". */
function toBody(draft: Draft) {
  const { apiKey, dropKey, ...rest } = draft;
  return {
    ...rest,
    baseUrl: rest.baseUrl.trim(),
    name: rest.name.trim() || "未命名配置",
    ...(dropKey ? { apiKey: null } : apiKey ? { apiKey } : {}),
  };
}

function storedConversation(machineId: number): string {
  try {
    return localStorage.getItem(chatKey(machineId)) ?? "";
  } catch {
    return "";
  }
}

const TOOL_ICON: Record<string, typeof Terminal> = {
  list_files: FolderTree,
  read_file: FileCode2,
  read_log: Terminal,
  run_command: Terminal,
  server_stats: Cpu,
  write_file: Pencil,
};

const TOOL_STATE: Record<Tool["state"], string> = {
  running: "执行中…",
  ok: "完成",
  error: "失败",
  awaiting: "等待确认",
};

export function AiChat({
  machineId,
  initialRoot,
  compact = false,
}: {
  machineId: number;
  initialRoot: string;
  compact?: boolean;
}) {
  const [profiles, setProfiles] = useState<Draft[]>([]);
  const [activeProfile, setActiveProfile] = useState("");
  const [editingId, setEditingId] = useState("");
  const [settings, setSettings] = useState(false);
  const [root, setRoot] = useState(initialRoot || "/");
  const [autoRun, setAutoRun] = useState<AutoRun>(storedAutoRun);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [conversationId, setConversationId] = useState("");
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [session, setSession] = useState<{ name: string; model: string }>({
    name: "",
    model: "",
  });
  const [openTools, setOpenTools] = useState<Record<string, boolean>>({});
  const [progress, setProgress] = useState<Progress | null>(null);
  // A run that is still going on the server after this view left, e.g. the
  // floating panel was collapsed mid-answer. We poll it until it finishes
  // instead of showing a frozen half-transcript.
  const [following, setFollowing] = useState(false);
  // The clock is kept in a ref so the ticking status line does not re-render
  // the whole transcript; `busy` drives the visible updates.
  const clock = useRef({ start: 0, end: 0 });
  const [, setTick] = useState(0);
  const controller = useRef<AbortController | null>(null);
  const transcript = useRef<HTMLDivElement | null>(null);
  const counter = useRef(0);
  const nextKey = () => `e${++counter.current}`;

  useEffect(() => setRoot(initialRoot || "/"), [initialRoot]);

  // Steps are always rendered above the answer they produced, even when the
  // model streamed its first sentence before calling a tool.
  const ordered = useMemo(() => orderTurnEntries(entries), [entries]);

  const push = useCallback((entry: Entry) => {
    setEntries((old) => [...old, entry]);
  }, []);

  const loadConversations = useCallback(async () => {
    try {
      const data = await apiFetch<{ conversations: Conversation[] }>(
        `/api/ai/conversations?machineId=${machineId}`,
      );
      setConversations(data.conversations);
      return data.conversations;
    } catch {
      return [] as Conversation[];
    }
  }, [machineId]);

  const current = profiles.find((p) => p.id === editingId) ?? profiles[0];

  const applyProfiles = useCallback(
    (data: { activeId: string; profiles: Profile[] }) => {
      const drafts = data.profiles.map(toDraft);
      setProfiles(drafts);
      setActiveProfile((id) =>
        drafts.some((p) => p.id === id)
          ? id
          : drafts.some((p) => p.id === data.activeId)
            ? data.activeId
            : (drafts[0]?.id ?? ""),
      );
      setEditingId((id) =>
        drafts.some((p) => p.id === id) ? id : (drafts[0]?.id ?? ""),
      );
      return drafts;
    },
    [],
  );

  useEffect(() => {
    const ac = new AbortController();
    void (async () => {
      try {
        const data = await apiFetch<{ activeId: string; profiles: Profile[] }>(
          "/api/ai/profiles",
          { signal: ac.signal },
        );
        // Nothing configured yet: start from a blank profile and open the editor.
        if (applyProfiles(data).length === 0) {
          setProfiles([blankDraft()]);
          setSettings(true);
        }
      } catch (e: unknown) {
        if (!ac.signal.aborted) setError(workspaceError(e));
      }
    })();
    return () => {
      ac.abort();
      // The chat run is deliberately left alone: collapsing the floating panel
      // or switching tabs unmounts this component, and killing the request there
      // made the assistant look "cancelled" halfway through real work. The run
      // finishes on the server and the transcript is reloaded next time.
    };
  }, [applyProfiles]);

  /** Rebuilds the transcript from a stored conversation. */
  const applyConversation = useCallback(
    (id: string, data: { conversation: { root: string }; turns: ChatTurn[] }) => {
      const restored: Entry[] = [];
      for (const turn of data.turns) {
        restored.push({ key: `e${++counter.current}`, kind: "user", text: turn.prompt });
        for (const tool of turn.trace ?? [])
          restored.push({ key: `e${++counter.current}`, kind: "tool", tool });
        for (const proposal of turn.proposals ?? [])
          restored.push({ key: `e${++counter.current}`, kind: "proposal", proposal });
        if (turn.answer)
          restored.push({
            key: `e${++counter.current}`,
            kind: "assistant",
            text: turn.answer,
          });
      }
      setEntries(restored);
      setConversationId(id);
      if (data.conversation.root) setRoot(data.conversation.root);
      try {
        localStorage.setItem(chatKey(machineId), id);
      } catch {
        // ignore
      }
      return data.turns;
    },
    [machineId],
  );

  /**
   * Decides whether a loaded conversation should keep updating itself. A run
   * that is still `running` is followed: its answer arrives later, so showing
   * the steps alone would look like the answer was lost.
   */
  const syncFollow = useCallback(
    (turns: ChatTurn[]) => {
      const last = turns.at(-1);
      const running = last?.status === "running";
      setFollowing(running);
      if (!running || !last) {
        setProgress(null);
        return;
      }
      let next = startProgress();
      for (const tool of last.trace ?? [])
        next = acceptEvent(next, { type: "tool", tool }) ?? next;
      setProgress(next);
      clock.current = { start: last.createdAt || Date.now(), end: 0 };
    },
    [],
  );

  const openConversation = useCallback(
    async (id: string) => {
      if (!id) return;
      try {
        const data = await apiFetch<{
          conversation: { root: string };
          turns: ChatTurn[];
        }>(`/api/ai/conversations/${id}`);
        syncFollow(applyConversation(id, data));
      } catch (e) {
        setError(workspaceError(e));
      }
    },
    [applyConversation, syncFollow],
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const list = await loadConversations();
      const stored = storedConversation(machineId);
      if (!cancelled && stored && list.some((c) => c.id === stored))
        await openConversation(stored);
    })();
    return () => {
      cancelled = true;
    };
  }, [machineId, loadConversations, openConversation]);

  // Scroll on transcript changes and when a step starts — never on a clock tick:
  // the timer must not yank the view back while the operator reads back.
  useEffect(() => {
    const node = transcript.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [entries, progress?.kind, progress?.step]);

  // One shared clock for the run: it stops ticking when the stream is over.
  useEffect(() => {
    if (!busy && !following) return;
    setTick((v) => v + 1);
    const timer = setInterval(() => setTick((v) => v + 1), 500);
    return () => clearInterval(timer);
  }, [busy, following]);

  // Follow a run this view is not streaming itself. The server keeps writing
  // the answer and steps as it goes, so a short poll is enough to show the
  // operator the result instead of a frozen transcript.
  useEffect(() => {
    if (!following || busy || !conversationId) return;
    let stopped = false;
    const tick = async () => {
      try {
        const data = await apiFetch<{
          conversation: { root: string };
          turns: ChatTurn[];
        }>(`/api/ai/conversations/${conversationId}`);
        if (stopped) return;
        const turns = applyConversation(conversationId, data);
        const last = turns.at(-1);
        if (!last || last.status !== "running") {
          setFollowing(false);
          clock.current.end = clock.current.end || Date.now();
          setProgress((old) => (old ? { ...old, kind: "done", last: "" } : old));
          return;
        }
        let next = startProgress();
        for (const tool of last.trace ?? [])
          next = acceptEvent(next, { type: "tool", tool }) ?? next;
        setProgress(next);
      } catch {
        if (!stopped) setFollowing(false);
      }
    };
    const timer = setInterval(() => void tick(), 1500);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [following, busy, conversationId, applyConversation]);

  function newChat() {
    controller.current?.abort();
    setEntries([]);
    setConversationId("");
    setError("");
    setNotice("");
    setProgress(null);
    setFollowing(false);
    clock.current = { start: 0, end: 0 };
    try {
      localStorage.removeItem(chatKey(machineId));
    } catch {
      // ignore
    }
  }

  /** Saves every profile in one request; the server keeps stored keys. */
  async function saveSettings() {
    setError("");
    try {
      const data = await apiFetch<{ activeId: string; profiles: Profile[] }>(
        "/api/ai/profiles",
        {
          method: "PUT",
          body: JSON.stringify({
            activeId: activeProfile || profiles[0]?.id || "",
            profiles: profiles.map(toBody),
          }),
        },
      );
      applyProfiles(data);
      setSettings(false);
      setNotice("AI 设置已保存");
    } catch (e) {
      setError(workspaceError(e));
    }
  }

  async function activate(id: string) {
    setActiveProfile(id);
    try {
      localStorage.setItem(PROFILE_KEY, id);
    } catch {
      // ignore
    }
    try {
      await apiFetch("/api/ai/profiles/active", {
        method: "PUT",
        body: JSON.stringify({ id }),
      });
    } catch {
      // The next send still uses the profile that is selected here.
    }
  }

  function patch(id: string, changes: Partial<Draft>) {
    setProfiles((old) =>
      old.map((profile) =>
        profile.id === id ? { ...profile, ...changes } : profile,
      ),
    );
  }

  function addProfile() {
    const draft = blankDraft();
    setProfiles((old) => [...old, draft]);
    setEditingId(draft.id);
    setActiveProfile(draft.id);
    setSettings(true);
  }

  function duplicateProfile(source: Draft) {
    // The API key cannot be copied: it is never sent back to the browser.
    const draft: Draft = {
      ...source,
      id: newId(),
      name: `${source.name} 副本`,
      apiKey: "",
      dropKey: false,
      hasKey: false,
    };
    setProfiles((old) => [...old, draft]);
    setEditingId(draft.id);
    setSettings(true);
  }

  async function removeProfile(id: string) {
    const rest = profiles.filter((profile) => profile.id !== id);
    const next = rest[0]?.id ?? "";
    setProfiles(rest);
    setEditingId(next);
    await activate(next);
    if (!rest.length) {
      setSettings(false);
      try {
        await apiFetch("/api/ai/profiles", {
          method: "PUT",
          body: JSON.stringify({ activeId: "", profiles: [] }),
        });
        setNotice("已删除全部配置");
      } catch (e) {
        setError(workspaceError(e));
      }
      return;
    }
    try {
      const data = await apiFetch<{ activeId: string; profiles: Profile[] }>(
        "/api/ai/profiles",
        {
          method: "PUT",
          body: JSON.stringify({
            activeId: next,
            profiles: rest.map(toBody),
          }),
        },
      );
      applyProfiles(data);
      setNotice("已删除配置");
    } catch (e) {
      setError(workspaceError(e));
    }
  }

  async function renameConversation(id: string, title: string) {
    try {
      await apiFetch(`/api/ai/conversations/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ title }),
      });
      setConversations((old) =>
        old.map((item) => (item.id === id ? { ...item, title } : item)),
      );
    } catch (e) {
      setError(workspaceError(e));
    }
  }

  /** The picker asks for confirmation inline, so no extra dialog here. */
  async function removeConversation(id: string) {
    try {
      await apiFetch(`/api/ai/conversations/${id}`, { method: "DELETE" });
      setConversations((old) => old.filter((item) => item.id !== id));
      if (id === conversationId) newChat();
      setNotice("已删除对话");
    } catch (e) {
      setError(workspaceError(e));
    }
  }

  function handleEvent(event: Record<string, any>) {
    setProgress((old) => acceptEvent(old, event));
    if (event.type === "start") {
      setConversationId(event.conversationId);
      if (event.profile?.name || event.model)
        setSession({ name: event.profile?.name ?? "", model: event.model ?? "" });
      try {
        localStorage.setItem(chatKey(machineId), event.conversationId);
      } catch {
        // ignore
      }
    } else if (event.type === "tool") {
      const tool = event.tool as Tool;
      setEntries((old) => {
        const index = old.findIndex(
          (entry) => entry.kind === "tool" && entry.tool.id === tool.id,
        );
        if (index < 0) return [...old, { key: nextKey(), kind: "tool", tool }];
        const copy = old.slice();
        copy[index] = { key: copy[index].key, kind: "tool", tool };
        return copy;
      });
    } else if (event.type === "proposal") {
      const proposal = event.proposal as Proposal;
      setEntries((old) => {
        const index = old.findIndex(
          (entry) => entry.kind === "proposal" && entry.proposal.id === proposal.id,
        );
        if (index < 0)
          return [...old, { key: nextKey(), kind: "proposal", proposal }];
        const copy = old.slice();
        copy[index] = { key: copy[index].key, kind: "proposal", proposal };
        return copy;
      });
    } else if (event.type === "delta") {
      setEntries((old) => {
        const copy = old.slice();
        for (let i = copy.length - 1; i >= 0; i--) {
          const entry = copy[i];
          if (entry.kind === "user") break;
          if (entry.kind === "assistant") {
            copy[i] = { ...entry, text: entry.text + String(event.text) };
            return copy;
          }
        }
        return [...copy, { key: nextKey(), kind: "assistant", text: String(event.text) }];
      });
    } else if (event.type === "answer") {
      const text = String(event.text ?? "");
      setEntries((old) => {
        const copy = old.slice();
        for (let i = copy.length - 1; i >= 0; i--) {
          const entry = copy[i];
          if (entry.kind === "user") break;
          if (entry.kind === "assistant") {
            copy[i] = { ...entry, text };
            return copy;
          }
        }
        return [...copy, { key: nextKey(), kind: "assistant", text }];
      });
    } else if (event.type === "error") {
      setError(workspaceError(new Error(String(event.error ?? "请求失败"))));
    } else if (event.type === "done") {
      const proposals = (event.proposals ?? []) as Proposal[];
      if (proposals.length)
        setEntries((old) =>
          old.map((entry) => {
            if (entry.kind !== "proposal") return entry;
            const found = proposals.find((p) => p.id === entry.proposal.id);
            return found
              ? { key: entry.key, kind: "proposal", proposal: found }
              : entry;
          }),
        );
    }
  }

  async function send() {
    const message = input.trim();
    if (!message || busy || following) return;
    setInput("");
    setError("");
    setNotice("");
    setFollowing(false);
    push({ key: nextKey(), kind: "user", text: message });
    setBusy(true);
    setProgress(startProgress());
    clock.current = { start: Date.now(), end: 0 };
    const ac = new AbortController();
    controller.current = ac;
    try {
      const token = getToken();
      const response = await fetch(`/api/ai/machines/${machineId}/chat`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          conversationId,
          message,
          root,
          autoRun,
          profileId: activeProfile,
        }),
        signal: ac.signal,
      });
      if (!response.ok || !response.body) {
        let text = `http_${response.status}`;
        try {
          const body = await response.json();
          if (body?.error) text = String(body.error);
        } catch {
          // ignore
        }
        throw new Error(text);
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            handleEvent(JSON.parse(line));
          } catch {
            // ignore malformed frame
          }
        }
      }
      void loadConversations();
    } catch (e) {
      const aborted =
        ac.signal.aborted || (e as Error)?.name === "AbortError";
      setError(aborted ? "已停止" : workspaceError(e));
      setProgress((old) => (aborted ? stopProgress(old) : failProgress(old)));
    } finally {
      // The run clock stops here: the status line keeps the final duration.
      clock.current.end = clock.current.end || Date.now();
      setBusy(false);
      controller.current = null;
    }
  }

  async function decide(proposal: Proposal, action: "apply" | "revert" | "reject") {
    const confirmText =
      action === "apply"
        ? proposal.kind === "command"
          ? `在目录 ${root} 执行以下命令？\n\n${proposal.after}`
          : `写入 ${proposal.path}？修改前的版本会自动备份。`
        : action === "revert"
          ? `撤销对 ${proposal.path} 的修改？`
          : `忽略这条待确认操作？`;
    if (!window.confirm(confirmText)) return;
    setError("");
    setNotice("");
    try {
      if (action === "reject") {
        await apiFetch(
          `/api/ai/machines/${machineId}/proposals/${proposal.id}/reject`,
          { method: "POST", body: JSON.stringify({ confirm: true }) },
        );
        updateProposal({ ...proposal, status: "rejected" });
        setNotice("已忽略该操作");
        return;
      }
      const data = await apiFetch<{
        result: {
          output?: string;
          code?: number | null;
          backup?: string | null;
          revision?: string;
        };
      }>(
        `/api/ai/machines/${machineId}/proposals/${proposal.id}/${action}`,
        { method: "POST", body: JSON.stringify({ confirm: true }) },
      );
      updateProposal({
        ...proposal,
        status: action === "apply" ? "applied" : "reverted",
        result: data.result ?? null,
      });
      setNotice(
        action === "revert"
          ? `已还原 ${proposal.path}`
          : proposal.kind === "command"
            ? `命令执行完成（退出码 ${data.result?.code ?? "未知"}）`
            : `已保存 ${proposal.path}${data.result?.backup ? ` · 备份 ${data.result.backup}` : ""}`,
      );
    } catch (e) {
      setError(workspaceError(e));
    }
  }

  function updateProposal(proposal: Proposal) {
    setEntries((old) =>
      old.map((entry) =>
        entry.kind === "proposal" && entry.proposal.id === proposal.id
          ? { key: entry.key, kind: "proposal", proposal }
          : entry,
      ),
    );
  }

  const pending = entries.filter(
    (entry) => entry.kind === "proposal" && entry.proposal.status === "pending",
  ).length;
  // The elapsed time freezes as soon as the stream is over.
  const elapsed = clock.current.start
    ? Math.max(0, (clock.current.end || Date.now()) - clock.current.start)
    : 0;

  return (
    <div className={`ai-chat${compact ? " compact" : ""}`}>
      <div className="workspace-toolbar ai-chat-head">
        <Sparkles size={16} />
        <strong className="flex-1 min-w-0 truncate text-sm">AI 助手</strong>
        <select
          aria-label="模型配置"
          className="yaws-select ai-chat-profile"
          title={
            current
              ? `${current.name} · ${current.model || "未填写模型"}`
              : "未配置模型"
          }
          value={activeProfile}
          disabled={busy || !profiles.length}
          onChange={(e) => void activate(e.target.value)}
        >
          {profiles.length === 0 && <option value="">未配置</option>}
          {profiles.map((profile) => (
            <option key={profile.id} value={profile.id}>
              {profile.name}
            </option>
          ))}
        </select>
        <ConversationPicker
          conversations={conversations}
          currentId={conversationId}
          busy={busy}
          onSelect={(id) => void openConversation(id)}
          onNew={newChat}
          onRename={renameConversation}
          onDelete={removeConversation}
          onRefresh={() => void loadConversations()}
        />
        <button
          className="icon-btn"
          title="新对话"
          aria-label="新对话"
          onClick={newChat}
        >
          <MessageSquarePlus size={17} />
        </button>
        <button
          className="icon-btn"
          title="AI 设置"
          aria-label="AI 设置"
          aria-expanded={settings}
          onClick={() => setSettings((v) => !v)}
        >
          <Settings2 size={17} />
        </button>
      </div>
      {settings && (
        <form
          className="ai-settings ai-profiles"
          onSubmit={(e) => {
            e.preventDefault();
            void saveSettings();
          }}
        >
          <div className="ai-profiles-top">
            <span className="ai-profiles-label">模型配置</span>
            <button
              type="button"
              className="ai-profile-mini"
              onClick={addProfile}
            >
              <Plus size={13} />
              新建配置
            </button>
          </div>
          <div className="ai-profile-list">
            {profiles.map((profile) => (
              <button
                key={profile.id}
                type="button"
                className={`ai-profile-chip${
                  profile.id === current?.id ? " active" : ""
                }`}
                aria-pressed={profile.id === current?.id}
                onClick={() => setEditingId(profile.id)}
              >
                {profile.name}
                {profile.id === activeProfile ? (
                  <span className="ai-profile-dot" title="当前使用" />
                ) : null}
                {!profile.hasKey && !profile.apiKey ? (
                  <span className="ai-profile-warn" title="还没有 API Key">
                    !
                  </span>
                ) : null}
              </button>
            ))}
          </div>
          {current ? (
            <>
              <label>
                名称
                <input
                  className="yaws-input"
                  value={current.name}
                  required
                  onChange={(e) => patch(current.id, { name: e.target.value })}
                />
              </label>
              <label>
                API 地址
                <input
                  className="yaws-input"
                  type="url"
                  value={current.baseUrl}
                  required
                  placeholder="https://api.example.com/v1"
                  onChange={(e) =>
                    patch(current.id, { baseUrl: e.target.value })
                  }
                />
              </label>
              <label>
                模型
                <input
                  className="yaws-input"
                  value={current.model}
                  required
                  onChange={(e) => patch(current.id, { model: e.target.value })}
                />
              </label>
              <label>
                协议
                <select
                  className="yaws-select w-full"
                  value={current.protocol}
                  onChange={(e) =>
                    patch(current.id, {
                      protocol: e.target.value as Profile["protocol"],
                    })
                  }
                >
                  <option value="chat">Chat Completions</option>
                  <option value="responses">Responses</option>
                </select>
              </label>
              <label>
                推理级别
                <input
                  list="reasoning-levels"
                  className="yaws-input"
                  value={current.reasoning}
                  placeholder="默认"
                  onChange={(e) =>
                    patch(current.id, { reasoning: e.target.value })
                  }
                />
                <datalist id="reasoning-levels">
                  {["low", "medium", "high", "xhigh", "max"].map((v) => (
                    <option key={v} value={v} />
                  ))}
                </datalist>
              </label>
              <label>
                API Key
                <input
                  className="yaws-input"
                  type="password"
                  autoComplete="new-password"
                  value={current.apiKey}
                  placeholder={current.hasKey ? "已保存，留空不修改" : "可选"}
                  onChange={(e) =>
                    patch(current.id, { apiKey: e.target.value })
                  }
                />
              </label>
              <div className="ai-profile-keynote">
                <span>
                  {current.dropKey
                    ? "保存后将清除该配置的密钥"
                    : current.hasKey
                      ? "密钥已保存，不会显示"
                      : "该配置还没有密钥"}
                </span>
                <button
                  type="button"
                  className="ai-profile-mini"
                  onClick={() =>
                    patch(current.id, {
                      dropKey: !current.dropKey,
                      apiKey: "",
                    })
                  }
                >
                  {current.dropKey ? "取消清除" : "清除密钥"}
                </button>
              </div>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={current.allowPrivate}
                  onChange={(e) =>
                    patch(current.id, { allowPrivate: e.target.checked })
                  }
                />
                允许内网 / HTTP 接口
              </label>
              <div className="ai-settings-actions">
                <button className="yaws-btn-primary tool-text" type="submit">
                  <Check size={16} />
                  保存全部配置
                </button>
                <button
                  type="button"
                  className="yaws-btn tool-text"
                  disabled={current.id === activeProfile}
                  onClick={() => void activate(current.id)}
                >
                  {current.id === activeProfile ? "正在使用" : "设为当前"}
                </button>
                <button
                  type="button"
                  className="yaws-btn tool-text"
                  title="复制该配置（API Key 需要重新填写）"
                  onClick={() => duplicateProfile(current)}
                >
                  <Copy size={15} />
                  复制
                </button>
                <button
                  type="button"
                  className="yaws-btn tool-text danger"
                  onClick={() => void removeProfile(current.id)}
                >
                  <Trash2 size={15} />
                  删除
                </button>
              </div>
            </>
          ) : null}
        </form>
      )}
      <div className="ai-chat-transcript" ref={transcript}>
        {entries.length === 0 && !busy && (
          <div className="ai-chat-empty">
            <p>
              直接提问即可。助手会自己读取服务器上的文件和日志，需要改动服务器时会先生成待确认的操作卡片。
            </p>
            <div className="ai-chips">
              {EXAMPLES.map((example) => (
                <button
                  key={example}
                  type="button"
                  className="ai-chip"
                  onClick={() => setInput(example)}
                >
                  {example}
                </button>
              ))}
            </div>
          </div>
        )}
        {ordered.map((entry) => {
          if (entry.kind === "user")
            return (
              <div key={entry.key} className="ai-row user">
                <div className="ai-bubble">{entry.text}</div>
              </div>
            );
          if (entry.kind === "assistant")
            return (
              <div key={entry.key} className="ai-row answer">
                <div className="ai-answer">
                  <Markdown text={entry.text} />
                </div>
              </div>
            );
          if (entry.kind === "error")
            return (
              <div key={entry.key} role="alert" className="yaws-alert-error">
                {entry.text}
              </div>
            );
          if (entry.kind === "tool") {
            const Icon = TOOL_ICON[entry.tool.name] ?? Terminal;
            const open = openTools[entry.key] ?? entry.tool.state === "error";
            return (
              <div key={entry.key} className="ai-tool">
                <button
                  type="button"
                  className="ai-tool-head"
                  aria-expanded={open}
                  onClick={() =>
                    setOpenTools((old) => ({ ...old, [entry.key]: !open }))
                  }
                >
                  {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  <Icon size={14} />
                  <span className="ai-tool-name">{entry.tool.detail || entry.tool.name}</span>
                  {entry.tool.readOnly ? (
                    <span className="ai-tag">只读</span>
                  ) : null}
                  <span className={`ai-tool-state ${entry.tool.state}`}>
                    {TOOL_STATE[entry.tool.state]}
                  </span>
                </button>
                {open && entry.tool.output ? (
                  <pre className="ai-tool-out">{entry.tool.output}</pre>
                ) : null}
              </div>
            );
          }
          const { proposal } = entry;
          const dismissed = proposal.status === "rejected";
          return (
            <section key={entry.key} className={`ai-proposal${dismissed ? " muted" : ""}`}>
              <div className="workspace-toolbar">
                <strong className="min-w-0 flex-1 break-all text-sm">
                  {proposal.kind === "command" ? "执行命令" : proposal.path}
                </strong>
                {proposal.status === "pending" ? (
                  <>
                    <button
                      className="yaws-btn tool-text"
                      onClick={() => void decide(proposal, "reject")}
                    >
                      忽略
                    </button>
                    <button
                      className="yaws-btn-primary tool-text"
                      onClick={() => void decide(proposal, "apply")}
                    >
                      {proposal.kind === "file" ? <Check size={16} /> : <Play size={16} />}
                      {proposal.kind === "file" ? "应用修改" : "执行命令"}
                    </button>
                  </>
                ) : proposal.status === "applied" && proposal.kind === "file" ? (
                  <>
                    <span className="ai-tag ok">已应用</span>
                    <button
                      className="yaws-btn tool-text"
                      onClick={() => void decide(proposal, "revert")}
                    >
                      <Undo2 size={16} />
                      撤销
                    </button>
                  </>
                ) : (
                  <span className={`ai-tag ${proposal.status}`}>
                    {proposal.status === "applied"
                      ? "已执行"
                      : proposal.status === "reverted"
                        ? "已还原"
                        : proposal.status === "rejected"
                          ? "已忽略"
                          : proposal.status === "failed"
                            ? "执行失败"
                            : proposal.status}
                  </span>
                )}
              </div>
              {proposal.summary ? (
                <div className="ai-proposal-note">{proposal.summary}</div>
              ) : null}
              {proposal.status === "pending" && proposal.kind === "command" ? (
                <div className="ai-proposal-note">
                  <AlertTriangle size={13} /> 需要你确认后才会在服务器上执行
                </div>
              ) : null}
              <pre className="diff-view">
                {proposal.kind === "command"
                  ? proposal.after
                  : diffLines(proposal.before, proposal.after).map((part, i) => (
                      <span
                        key={i}
                        className={
                          part.added
                            ? "diff-add"
                            : part.removed
                              ? "diff-remove"
                              : ""
                        }
                      >
                        {part.value.split("\n").map((line, j, all) =>
                          j === all.length - 1 && line === "" ? null : (
                            <span key={j} className="diff-line">
                              {part.added ? "+" : part.removed ? "-" : " "} {line}
                              {"\n"}
                            </span>
                          ),
                        )}
                      </span>
                    ))}
              </pre>
              {proposal.result?.output ? (
                <pre className="command-output">{proposal.result.output}</pre>
              ) : null}
            </section>
          );
        })}
      </div>
      {/* The live status is chrome, not transcript content: keeping it outside
          leaves the answer as the element that closes the turn. */}
      {progress ? (
        <div
          className="ai-chat-working"
          data-tone={progressTone(progress)}
          title={progressLabel(progress, elapsed, pending)}
        >
          {progressLabel(progress, elapsed, pending)}
        </div>
      ) : null}
      {error && (
        <div role="alert" className="yaws-alert-error">
          {error}
        </div>
      )}
      {notice && <div className="workspace-notice">{notice}</div>}
      {pending > 0 ? (
        <div className="ai-chat-pending">
          有 {pending} 条操作等待你确认，确认后助手才能继续。
        </div>
      ) : null}
      <form
        className="ai-chat-composer"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <div className="ai-chat-meta">
          <label className="ai-meta-root flex items-center gap-1">
            目录
            <input
              className="yaws-input font-mono"
              aria-label="工作目录"
              required
              value={root}
              disabled={busy || following}
              onChange={(e) => setRoot(e.target.value)}
            />
          </label>
          <label className="ai-meta-run flex items-center gap-1">
            执行方式
            <select
              className="yaws-select"
              aria-label="执行方式"
              value={autoRun}
              disabled={busy || following}
              onChange={(e) => {
                const value = e.target.value as AutoRun;
                setAutoRun(value);
                try {
                  localStorage.setItem(AUTO_RUN_KEY, value);
                } catch {
                  // ignore
                }
              }}
            >
              {AUTO_RUN_MODES.map((mode) => (
                <option key={mode.value} value={mode.value}>
                  {mode.label}
                </option>
              ))}
            </select>
          </label>
          {session.model ? (
            <span
              className="ai-chat-session"
              title={`本对话由「${session.name || "配置"}」生成`}
            >
              {session.name ? `${session.name} · ` : ""}
              {session.model}
            </span>
          ) : null}
        </div>
        <div className="ai-chat-input">
          <textarea
            className="yaws-input"
            rows={compact ? 2 : 3}
            value={input}
            placeholder="问点什么，例如：帮我看看 nginx 为什么 502"
            aria-label="问题"
            disabled={busy || following}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
          />
          {busy ? (
            <button
              type="button"
              className="yaws-btn tool-text"
              title="停止"
              aria-label="停止"
              onClick={() => controller.current?.abort()}
            >
              <CircleStop size={16} />
              停止
            </button>
          ) : following ? (
            <button
              type="button"
              className="yaws-btn tool-text"
              disabled
              title="后台仍在运行"
            >
              <LoaderCircle size={16} className="animate-spin" />
              运行中
            </button>
          ) : (
            <button
              className="yaws-btn-primary tool-text"
              type="submit"
              disabled={!input.trim()}
            >
              <Send size={16} />
              发送
            </button>
          )}
        </div>
        <div className="ai-chat-hint">
          危险命令（rm -rf、mkfs、改密码等）永远需要确认；凭据文件不会被读取。
        </div>
        <button
          type="button"
          className="ai-chat-clear"
          title="清空对话"
          onClick={() => void deleteConversation()}
          hidden={!conversationId}
        >
          <Trash2 size={12} /> 删除这轮对话
        </button>
      </form>
    </div>
  );

  async function deleteConversation() {
    if (!conversationId || !window.confirm("删除这轮对话记录？")) return;
    try {
      await apiFetch(`/api/ai/conversations/${conversationId}`, { method: "DELETE" });
      newChat();
      void loadConversations();
    } catch (e) {
      setError(workspaceError(e));
    }
  }
}
