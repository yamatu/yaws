import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  ImagePlus,
  ListPlus,
  MessageCircleReply,
  MessageSquarePlus,
  Pencil,
  PencilLine,
  Play,
  Plus,
  RotateCcw,
  Send,
  Server,
  Settings2,
  SlidersHorizontal,
  Sparkles,
  Terminal,
  Trash2,
  Undo2,
  X,
} from "lucide-react";
import { diffLines } from "diff";
import { apiFetch } from "./api";
import { copyText } from "./clipboard";
import {
  ENTER_PREFERENCES,
  MOBILE_INPUT_QUERY,
  enterAction,
  readEnterPreference,
  writeEnterPreference,
  type EnterPreference,
} from "./promptEnter";
import { draftKey, readDraft, writeDraft } from "./promptDrafts";
import {
  QUEUE_LIMIT,
  enqueue,
  flushDecision,
  removeQueued,
  type Queued,
} from "./promptQueue";
import {
  BUILTIN_COMMANDS,
  applyCommand,
  builtinCommand,
  matchCommands,
  slashQuery,
  type BuiltinCommand,
  type SlashCommand,
} from "./slashCommands";
import { repairViewportScroll, useMediaQuery } from "./viewport";
import {
  MAX_IMAGES,
  attachmentUrl,
  imageFiles,
  prepareImage,
  type Attachment,
} from "./imageAttach";
import { ImageStrip, ImageViewer, type ImageRef } from "./ChatImages";
import { groupSteps, stepSummary } from "./chatGroups";
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
import { McpSettings } from "./McpSettings";
import { ExtensionSettings } from "./ExtensionSettings";
import { Markdown } from "./MarkdownView";
import { type StreamBatch, createStreamBatch } from "./streamBatch";
import { orderTurnEntries } from "./chatOrder";
import { cacheStats, formatTokens } from "./aiUsage";
import type { Usage } from "./aiUsage";
import {
  hostChoices,
  hostNames,
  hostSummary,
  toggleHost,
  type HostOption,
} from "./aiHosts";
import { FloatingPanel } from "./FloatingPanel";
import {
  scrollIntent,
  shouldStickOnChange,
  stickAfterScroll,
} from "./chatScroll";
import {
  atEdge,
  down as historyDown,
  NEW_CURSOR,
  remember,
  up as historyUp,
  type HistoryCursor,
} from "./promptHistory";
import type { Conversation } from "./conversations";
import { OfficialModels, type OfficialProvider } from "./OfficialModels";

type Profile = {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  protocol: "chat" | "responses" | "anthropic";
  reasoning: string;
  speed: string;
  allowPrivate: boolean;
  /**
   * Serve the Messages protocol as the official Claude Code client (its
   * headers, beta list, tool names and system prompt) instead of as yaws.
   * Meant for relays that resell a Claude Code subscription.
   */
  claudeCode?: boolean;
  hasKey?: boolean;
  officialProvider?: string;
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
  /** Which server the step ran on, e.g. `web-2 (#4)`. */
  host?: string;
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
  /** Server the card applies to; `""` for conversations from older versions. */
  host?: string;
  result: { output?: string; code?: number | null; backup?: string | null } | null;
};
type Entry =
  | { key: string; kind: "user"; text: string; images?: ImageRef[] }
  | {
      key: string;
      kind: "steer";
      text: string;
      images?: ImageRef[];
      /** Sent, not yet seen by the model; keeps the pictures to re-queue it. */
      pending?: Attachment[];
      at?: number;
    }
  | { key: string; kind: "assistant"; text: string }
  | { key: string; kind: "thinking"; text: string }
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
  images?: string[];
  steers?: StoredSteer[];
};
/** A message added while a turn ran; `step` is how many steps came before it. */
type StoredSteer = { text: string; images: string[]; step: number; at: number };
/** The conversation endpoint reports the extra servers of a stored chat. */
type StoredConversation = { root: string; hosts?: HostOption[]; machineId?: number };
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
    speed: "",
    allowPrivate: false,
    claudeCode: false,
    officialProvider: "",
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

/**
 * Reads one NDJSON frame at a time out of a streamed response.
 *
 * Both the request that starts a run and the re-attach that follows one use
 * this, so a page that comes back after a reload parses the very same frames the
 * original request did. Frames are split on newlines and a partial trailing line
 * is kept in the buffer, because a socket read can land in the middle of one.
 */
async function readFrames(
  response: Response,
  onEvent: (event: Record<string, any>) => void,
) {
  if (!response.body) throw new Error(`http_${response.status}`);
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
        onEvent(JSON.parse(line) as Record<string, any>);
      } catch {
        // A malformed frame is skipped: one bad line must not kill the run.
      }
    }
  }
}

/** Lines added/removed by a file card, for the pending list. */
function diffStat(proposal: Pick<Proposal, "before" | "after">) {
  let added = 0;
  let removed = 0;
  for (const part of diffLines(proposal.before, proposal.after)) {
    if (part.added) added += part.count ?? 0;
    else if (part.removed) removed += part.count ?? 0;
  }
  return { added, removed };
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

/** What a transcript row may ask the chat to do. Held in one object that only
 *  changes when a handler does, so an unchanged row can skip re-rendering. */
type RowActions = {
  copy: (key: string, text: string) => void;
  edit: (text: string) => void;
  openImage: (url: string) => void;
  toggle: (key: string, open: boolean, thinking: boolean) => void;
  decide: (proposal: Proposal, action: "apply" | "revert" | "reject") => void;
};
type RowContext = { conversationId: string; actions: RowActions };

/**
 * One entry of the transcript.
 *
 * Memoised on the entry itself: a long conversation used to be rebuilt from its
 * first message on every streamed token, which is what made the page crawl while
 * an answer was being written. Now only the row whose own data changed
 * re-renders; every other row is skipped because React sees the same entry
 * object, the same flags and the same handlers as last time.
 */
const Row = memo(function Row({
  entry,
  ctx,
  copied,
  focused,
  open,
}: {
  entry: Entry;
  ctx: RowContext;
  /** This row's copy button just succeeded. */
  copied: boolean;
  /** This approval card is the one that was just scrolled to. */
  focused: boolean;
  /** A tool card or a thinking block is unfolded. */
  open: boolean;
}) {
  if (entry.kind === "steer")
    return (
      <div
        className={`ai-row user steer${entry.pending ? " pending" : ""}`}
        aria-label="运行中插话"
      >
        <div className="ai-bubble">
          <span className="ai-steer-tag">
            <MessageCircleReply size={12} />
            {entry.pending ? "插话 · 等这一步完成后送达" : "插话"}
          </span>
          {entry.images?.length ? (
            <ImageStrip
              images={entry.images}
              conversationId={ctx.conversationId}
              onOpen={ctx.actions.openImage}
            />
          ) : null}
          {entry.text}
        </div>
      </div>
    );
  if (entry.kind === "user")
    return (
      <div className="ai-row user">
        <div className="ai-bubble">
          {entry.images?.length ? (
            <ImageStrip
              images={entry.images}
              conversationId={ctx.conversationId}
              onOpen={ctx.actions.openImage}
            />
          ) : null}
          {entry.text}
        </div>
        <div className="ai-msg-actions">
          <button
            type="button"
            title="复制提问"
            aria-label="复制提问"
            onClick={() => ctx.actions.copy(entry.key, entry.text)}
          >
            {copied ? <Check size={13} /> : <Copy size={13} />}
          </button>
          <button
            type="button"
            title="放回输入框修改后再问"
            aria-label="编辑后重新提问"
            onClick={() => ctx.actions.edit(entry.text)}
          >
            <PencilLine size={13} />
          </button>
        </div>
      </div>
    );
  if (entry.kind === "assistant")
    return (
      <div className="ai-row answer">
        <div className="ai-answer">
          <Markdown text={entry.text} />
        </div>
        {entry.text.trim() ? (
          <div className="ai-msg-actions">
            <button
              type="button"
              title="复制回答（Markdown）"
              aria-label="复制回答"
              onClick={() => ctx.actions.copy(entry.key, entry.text)}
            >
              {copied ? <Check size={13} /> : <Copy size={13} />}
              {copied ? "已复制" : "复制"}
            </button>
          </div>
        ) : null}
      </div>
    );
  if (entry.kind === "error")
    return (
      <div role="alert" className="yaws-alert-error">
        {entry.text}
      </div>
    );
  if (entry.kind === "tool") {
    const Icon = TOOL_ICON[entry.tool.name] ?? Terminal;
    return (
      <div className="ai-tool">
        <button
          type="button"
          className="ai-tool-head"
          aria-expanded={open}
          onClick={() => ctx.actions.toggle(entry.key, open, false)}
        >
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          <Icon size={14} />
          <span className="ai-tool-name">{entry.tool.detail || entry.tool.name}</span>
          {entry.tool.host ? (
            <span className="ai-tag host" title="执行的主机">
              {entry.tool.host}
            </span>
          ) : null}
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
  if (entry.kind === "thinking") {
    return (
      <div className="ai-thinking">
        <button
          type="button"
          className="ai-thinking-head"
          aria-expanded={open}
          onClick={() => ctx.actions.toggle(entry.key, open, true)}
        >
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          <Sparkles size={13} />
          <span>思考过程</span>
        </button>
        {open ? (
          <div className="ai-thinking-text">{entry.text}</div>
        ) : null}
      </div>
    );
  }
  const { proposal } = entry;
  const dismissed = proposal.status === "rejected";
  return (
    <section
      data-proposal={proposal.id}
      className={`ai-proposal${dismissed ? " muted" : ""}${focused ? " focused" : ""}`}
    >
      <div className="workspace-toolbar">
        <strong className="min-w-0 flex-1 break-all text-sm">
          {proposal.host ? (
            <span className="ai-tag host">{proposal.host}</span>
          ) : null}
          {proposal.kind === "command" ? "执行命令" : proposal.path}
        </strong>
        {proposal.status === "pending" ? (
          <>
            <button
              className="yaws-btn tool-text"
              onClick={() => ctx.actions.decide(proposal, "reject")}
            >
              忽略
            </button>
            <button
              className="yaws-btn-primary tool-text"
              onClick={() => ctx.actions.decide(proposal, "apply")}
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
              onClick={() => ctx.actions.decide(proposal, "revert")}
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
});

export function AiChat({
  machineId,
  initialRoot,
  compact = false,
  onClose,
}: {
  machineId: number;
  initialRoot: string;
  compact?: boolean;
  /** Shown as a close button in the header when the chat owns the whole screen. */
  onClose?: () => void;
}) {
  const [profiles, setProfiles] = useState<Draft[]>([]);
  const [activeProfile, setActiveProfile] = useState("");
  const [editingId, setEditingId] = useState("");
  const [settings, setSettings] = useState(false);
  const [root, setRoot] = useState(initialRoot || "/");
  const [autoRun, setAutoRun] = useState<AutoRun>(storedAutoRun);
  const [entries, setEntries] = useState<Entry[]>([]);
  const entriesRef = useRef(entries);
  entriesRef.current = entries;
  // The unsent question survives a reload, a collapsed dock and a switch to
  // another conversation; each conversation keeps its own.
  const [input, setInput] = useState(() => readDraft(draftKey(machineId, "")));
  const mobile = useMediaQuery(MOBILE_INPUT_QUERY);
  const [enterPref, setEnterPref] = useState<EnterPreference>(readEnterPreference);
  const explicitShift = useRef(false);
  // Follow-ups typed while a turn is running go out one by one once it ends.
  const [queue, setQueue] = useState<Queued[]>([]);
  // The last turn was stopped or failed: queued questions wait for the operator.
  const [halted, setHalted] = useState(false);
  const [metaOpen, setMetaOpen] = useState(false);
  const [commands, setCommands] = useState<SlashCommand[]>(BUILTIN_COMMANDS);
  const commandsLoaded = useRef(false);
  const [caret, setCaret] = useState(0);
  const [slashIndex, setSlashIndex] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState(false);
  const [copied, setCopied] = useState("");
  // Pictures waiting in the composer; too big for the saved draft.
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [attaching, setAttaching] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const [viewer, setViewer] = useState("");
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});
  // A stream was lost (background tab, flaky network): refresh from the server
  // when the page is back instead of leaving a half-written answer.
  const stale = useRef(false);
  /**
   * Questions this conversation was asked, newest last, plus where the arrow
   * keys currently sit in them. Unlike the transcript this is only about the
   * input box, so it is deliberately not part of the saved conversation: the
   * stored turns are already the record, and a recalled question becomes a
   * stored turn the moment it is asked again.
   */
  const [history, setHistory] = useState<string[]>([]);
  const cursor = useRef<HistoryCursor>(NEW_CURSOR);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [conversationId, setConversationId] = useState("");
  const [conversations, setConversations] = useState<Conversation[]>([]);
  // Extra servers this conversation also works on. The primary host is the
  // machine the chat was opened from and is always part of the set.
  const [hosts, setHosts] = useState<number[]>([]);
  const [hostOptions, setHostOptions] = useState<HostOption[]>([]);
  const [hostOpen, setHostOpen] = useState(false);
  const [pendingOpen, setPendingOpen] = useState(false);
  const [focusedProposal, setFocusedProposal] = useState("");
  // The picker is drawn in a portal anchored to this button; an in-flow menu is
  // clipped by the dock's overflow.
  const hostButton = useRef<HTMLButtonElement | null>(null);
  const [session, setSession] = useState<{ name: string; model: string }>({
    name: "",
    model: "",
  });
  const [openTools, setOpenTools] = useState<Record<string, boolean>>({});
  const [openThinking, setOpenThinking] = useState<Record<string, boolean>>({});
  // Tokens the provider has reported for this conversation so far. Kept for as
  // long as the chat is open: the numbers are a running total, not a comment on
  // the answer that just ended.
  const [usage, setUsage] = useState<Usage | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  // A run that is still going on the server after this view left, e.g. the
  // floating panel was collapsed mid-answer, or the page was reloaded. Instead
  // of polling the transcript we re-attach to the run's own stream, so a
  // refresh keeps showing the answer as it is written.
  const [following, setFollowing] = useState(false);
  // The run this view is (re-)attached to, and how many frames of it have been
  // rendered. A reconnect passes the count so the answer is not duplicated.
  const attached = useRef<{ runId: string; frames: number }>({ runId: "", frames: 0 });
  /** The reader that is watching a detached run, so it can be stopped cleanly. */
  const follower = useRef<AbortController | null>(null);
  /**
   * Set while the operator is stopping a run, so the stream that owns it reports
   * a stop rather than the generic "connection lost" it would otherwise see
   * when its own socket is closed by the stop button.
   */
  const stopping = useRef(false);
  // The clock is kept in a ref so the ticking status line does not re-render
  // the whole transcript; `busy` drives the visible updates.
  const clock = useRef({ start: 0, end: 0 });
  const [, setTick] = useState(0);
  const controller = useRef<AbortController | null>(null);
  const transcript = useRef<HTMLDivElement | null>(null);
  // Whether the view follows the answer as it is written. It starts as `true`
  // (a fresh transcript should show its newest content) and the operator decides
  // from then on: reading back turns it off, returning to the end turns it on.
  // Kept in a ref because a scroll event must read the latest value without
  // waiting for a re-render, and mirrored into state so the jump-to-end button
  // can appear.
  const stick = useRef(true);
  const lastTop = useRef(0);
  const [atEnd, setAtEnd] = useState(true);
  const setStick = useCallback((value: boolean) => {
    stick.current = value;
    setAtEnd(value);
  }, []);
  const counter = useRef(0);
  const nextKey = () => `e${++counter.current}`;
  /**
   * Streamed text is applied once per animation frame instead of once per
   * frame that arrives (see `streamBatch`). A provider can send ten times more
   * deltas per second than the screen can show, and re-rendering the transcript
   * for each of them is what made a long answer lock the page up.
   */
  const stream = useRef<StreamBatch | null>(null);
  if (!stream.current)
    stream.current = createStreamBatch((answer, thinking) => {
      if (thinking)
        setEntries((old) => {
          const copy = old.slice();
          const last = copy[copy.length - 1];
          if (last?.kind === "thinking") {
            copy[copy.length - 1] = { ...last, text: last.text + thinking };
            return copy;
          }
          return [...copy, { key: nextKey(), kind: "thinking", text: thinking }];
        });
      if (answer)
        setEntries((old) => {
          const copy = old.slice();
          for (let i = copy.length - 1; i >= 0; i--) {
            const entry = copy[i];
            if (entry.kind === "user") break;
            if (entry.kind === "assistant") {
              copy[i] = { ...entry, text: entry.text + answer };
              return copy;
            }
          }
          return [...copy, { key: nextKey(), kind: "assistant", text: answer }];
        });
    });
  // A frame that is still scheduled when the chat goes away must not apply.
  useEffect(() => () => stream.current?.cancel(), []);
  // Read by listeners that outlive a render (page resume).
  const live = useRef({ busy, following, conversationId });
  live.current = { busy, following, conversationId };

  useEffect(() => setRoot(initialRoot || "/"), [initialRoot]);

  // The picker needs the machine list once. A viewer account cannot read it;
  // the chat then simply stays on its primary host.
  useEffect(() => {
    const ac = new AbortController();
    void (async () => {
      try {
        const data = await apiFetch<{ machines: HostOption[] }>("/api/machines", {
          signal: ac.signal,
        });
        setHostOptions(
          data.machines.map((machine) => ({ id: machine.id, name: machine.name })),
        );
      } catch {
        // ignored: the assistant still works on the primary host
      }
    })();
    return () => ac.abort();
  }, []);

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

  // Leaving the page detaches this reader; the run keeps going. The stored run
  // id is what brings the transcript back on the next mount, and an explicit
  // stop is the only thing that actually ends it (see `stopRun`).
  useEffect(() => () => follower.current?.abort(), []);

  /** Rebuilds the transcript from a stored conversation. */
  const applyConversation = useCallback(
    (
      id: string,
      data: {
        conversation: StoredConversation;
        turns: ChatTurn[];
        usage?: Usage;
      },
    ) => {
      // The transcript is replaced wholesale: text buffered for the previous one
      // must not land in the new one.
      stream.current?.cancel();
      const restored: Entry[] = [];
      for (const turn of data.turns) {
        restored.push({
          key: `e${++counter.current}`,
          kind: "user",
          text: turn.prompt,
          images: (turn.images ?? []).map((imageId) => ({ id: imageId })),
        });
        // Messages added mid-run go back between the steps they followed.
        const steers = [...(turn.steers ?? [])].sort((a, b) => a.step - b.step);
        const pushSteers = (upTo: number) => {
          while (steers.length && steers[0].step <= upTo) {
            const steer = steers.shift()!;
            restored.push({
              key: `e${++counter.current}`,
              kind: "steer",
              text: steer.text,
              images: steer.images.map((imageId) => ({ id: imageId })),
              at: steer.at,
            });
          }
        };
        (turn.trace ?? []).forEach((tool, index) => {
          pushSteers(index);
          restored.push({ key: `e${++counter.current}`, kind: "tool", tool });
        });
        pushSteers(Number.POSITIVE_INFINITY);
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
      // A reopened conversation can be recalled from, so switching away and back
      // does not lose the ability to press `up` for an earlier question.
      setHistory(
        data.turns.map((turn) => turn.prompt).filter((text) => text.trim()),
      );
      cursor.current = NEW_CURSOR;
      setInput(readDraft(draftKey(machineId, id)));
      setConversationId(id);
      // The stored total the server kept, so the usage line is complete the
      // moment a conversation is opened rather than after the next answer.
      setUsage(data.usage ?? null);
      if (data.conversation.root) setRoot(data.conversation.root);
      // Opened with the servers it last ran on, so adding a follow-up question
      // reaches the same machines instead of silently dropping back to one.
      setHosts(
        (data.conversation.hosts ?? [])
          .map((host) => host.id)
          .filter((hostId) => hostId !== machineId),
      );
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
   * Applies one frame of the run stream. Shared by the request that starts a
   * run and by a re-attach after a reload, so a refreshed page renders the
   * answer exactly the way the original request did.
   */
  const handleEvent = useCallback((event: Record<string, any>) => {
    // A step, the final answer or the end of the run must see the text that
    // arrived before it, so anything still buffered is applied first. The two
    // text channels are the only ones that are batched.
    if (event.type !== "delta" && event.type !== "thinking")
      stream.current?.flush();
    setProgress((old) => acceptEvent(old, event));
    if (event.type === "start") {
      // A new chat just got its id: whatever is typed now belongs to it, not
      // to the next new chat.
      if (!live.current.conversationId) writeDraft(draftKey(machineId, ""), "");
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
    } else if (event.type === "thinking") {
      // Reasoning streams on its own channel: it is shown apart from the answer
      // so a model that thinks out loud cannot be mistaken for a reply.
      stream.current?.thinking(String(event.text ?? ""));
    } else if (event.type === "steer") {
      // The model has the message now. It was shown when it was sent; a replay
      // after a reload or a message from another tab is added here.
      const steer = event.steer as StoredSteer;
      setEntries((old) => {
        if (old.some((entry) => entry.kind === "steer" && entry.at === steer.at)) return old;
        const index = old.findIndex(
          (entry) => entry.kind === "steer" && entry.pending && entry.text === steer.text,
        );
        if (index >= 0) {
          // Moved to where the model actually read it: after the steps that
          // finished while it waited.
          const found = old[index] as Extract<Entry, { kind: "steer" }>;
          return [
            ...old.slice(0, index),
            ...old.slice(index + 1),
            { ...found, pending: undefined, at: steer.at },
          ];
        }
        return [
          ...old,
          {
            key: nextKey(),
            kind: "steer",
            text: steer.text,
            images: steer.images.map((imageId) => ({ id: imageId })),
            at: steer.at,
          },
        ];
      });
    } else if (event.type === "steer_dropped") {
      // The turn ended before the model read them: they become the next questions.
      const dropped = entriesRef.current.filter(
        (entry): entry is Extract<Entry, { kind: "steer" }> =>
          entry.kind === "steer" && !!entry.pending,
      );
      if (dropped.length) {
        const keys = new Set(dropped.map((entry) => entry.key));
        setEntries((old) => old.filter((entry) => !keys.has(entry.key)));
        setQueue((queue) => [
          ...queue,
          ...dropped.map((entry) => ({
            id: newId(),
            text: entry.text,
            ...(entry.pending?.length ? { images: entry.pending } : {}),
          })),
        ]);
        setNotice("这一轮结束前没来得及插话，消息已改为排队发送");
      }
    } else if (event.type === "usage") {
      setUsage(event.usage as Usage);
    } else if (event.type === "delta") {
      stream.current?.answer(String(event.text));
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
      setHalted(true);
      setError(workspaceError(new Error(String(event.error ?? "请求失败"))));
    } else if (event.type === "note" && event.note === "answer_truncated") {
      // The model kept stopping at its own output cap and the automatic
      // continuation ran out of rounds, so the fragment on screen is all there
      // is. Say so instead of letting it look like a finished answer.
      setNotice("回答过长，已自动续写多轮仍未写完，回复「继续」可让它接着写。");
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
    }, [machineId]);

  const followRun = useCallback(
    async (runId: string, from = 0) => {
      if (!runId) return;
      const ac = new AbortController();
      follower.current = ac;
      attached.current = { runId, frames: from };
      setFollowing(true);
      try {
        const token = getToken();
        const response = await fetch(
          `/api/ai/conversations/${conversationId}/runs/${runId}/stream?after=${from}`,
          {
            headers: token ? { authorization: `Bearer ${token}` } : {},
            signal: ac.signal,
          },
        );
        if (!response.ok || !response.body)
          throw new Error(`http_${response.status}`);
        await readFrames(response, (event) => {
          // The server closes the stream when the run ends; `stream_end` is only
          // the control frame that says so, and it is not a frame of the run.
          if (event.type === "stream_end") {
            // The run is over: paint whatever arrived with the closing frame.
            stream.current?.flush();
            return;
          }
          attached.current.frames += 1;
          handleEvent(event);
        });
      } catch (e) {
        // A dropped reconnect is not a failed run: the run keeps going and the
        // next mount attaches again. Only a real HTTP error is worth showing.
        if (!ac.signal.aborted) {
          stale.current = true;
          if (workspaceError(e) !== "http_404") setError(workspaceError(e));
        }
      } finally {
        stream.current?.flush();
        if (follower.current === ac) follower.current = null;
        setFollowing(false);
        clock.current.end = clock.current.end || Date.now();
        setProgress((old) => (old ? { ...old, kind: "done", last: "" } : old));
      }
    },
    [conversationId, handleEvent],
  );

  /**
   * Decides whether a loaded conversation should keep updating itself.
   *
   * A stored turn whose status is `running` only says the row was not finished
   * when it was read. Whether there is still something to watch is answered by
   * the live-run field: after a reload the run is still going and is re-attached
   * to, while a row left over from a server restart is shown as it is, so the
   * page does not wait forever on a stream that no longer exists.
   */
  const syncFollow = useCallback(
    (turns: ChatTurn[], liveRunId: string) => {
      const last = turns.at(-1);
      const running = last?.status === "running";
      if (!running || !last) {
        setFollowing(false);
        setProgress(null);
        return;
      }
      // A live run can be picked up mid-answer; a `running` row without one is
      // history the process lost, and it must not look like it is still working.
      if (!liveRunId) {
        setFollowing(false);
        setProgress(null);
        setNotice("上一轮因为面板重启没有跑完，回复「继续」可以接着处理。");
        return;
      }
      let next = startProgress();
      for (const tool of last.trace ?? [])
        next = acceptEvent(next, { type: "tool", tool }) ?? next;
      setProgress(next);
      clock.current = { start: last.createdAt || Date.now(), end: 0 };
      // The stored trace is already on screen, so the replay starts after it and
      // the answer is not written twice.
      void followRun(liveRunId, 0);
    },
    [followRun],
  );

  const openConversation = useCallback(
    async (id: string) => {
      if (!id) return;
      if (id !== live.current.conversationId) {
        setQueue([]);
        setHalted(false);
      }
      try {
        const data = await apiFetch<{
          conversation: StoredConversation;
          turns: ChatTurn[];
          usage?: Usage;
          liveRunId?: string;
        }>(`/api/ai/conversations/${id}`);
        syncFollow(applyConversation(id, data), data.liveRunId ?? "");
      } catch (e) {
        setError(workspaceError(e));
      }
    },
    [applyConversation, syncFollow],
  );

  // A different machine means a different conversation: drop the extra hosts
  // and the usage total of the previous one before the stored conversation
  // restores its own.
  useEffect(() => {
    setHosts([]);
    setUsage(null);
  }, [machineId]);

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

  // Phones kill background sockets. When the page is shown again (tab switch,
  // unlock, network back) pick the run up again, or reload a transcript whose
  // stream was cut, without touching what is typed in the box.
  useEffect(() => {
    let checking = false;
    const resume = async () => {
      if (document.visibilityState !== "visible" || checking) return;
      const { busy: running, following: watching, conversationId: id } = live.current;
      if (running || watching || !id) return;
      checking = true;
      try {
        const data = await apiFetch<{
          conversation: StoredConversation;
          turns: ChatTurn[];
          usage?: Usage;
          liveRunId?: string;
        }>(`/api/ai/conversations/${id}`);
        const now = live.current;
        if (now.busy || now.following || now.conversationId !== id) return;
        if (!data.liveRunId && !stale.current) return;
        stale.current = false;
        setError("");
        syncFollow(applyConversation(id, data), data.liveRunId ?? "");
      } catch {
        // still offline: the next resume tries again
      } finally {
        checking = false;
      }
    };
    const onResume = () => void resume();
    document.addEventListener("visibilitychange", onResume);
    window.addEventListener("online", onResume);
    window.addEventListener("pageshow", onResume);
    return () => {
      document.removeEventListener("visibilitychange", onResume);
      window.removeEventListener("online", onResume);
      window.removeEventListener("pageshow", onResume);
    };
  }, [applyConversation, syncFollow]);

  useEffect(() => {
    writeDraft(draftKey(machineId, conversationId), input);
  }, [machineId, conversationId, input]);

  // Follow the transcript only while the operator is at the end of it. Steps
  // push the answer down from above, so jumping on every change is what made
  // reading back impossible mid-run; a finished answer is still revealed, and
  // the timer never scrolls on its own (see `chatScroll`).
  useEffect(() => {
    const node = transcript.current;
    if (!node) return;
    if (!shouldStickOnChange({ stick: stick.current, busy, entries })) return;
    node.scrollTop = node.scrollHeight;
    lastTop.current = node.scrollTop;
  }, [entries, busy, progress?.kind, progress?.step]);

  /**
   * One scroll event from the operator: away from the end stops the follow, back
   * to the end resumes it and jumps, so the tokens that arrived while reading
   * are not missed. A transcript that already sits at the end (a re-render, a
   * resize) must not undo a running follow.
   */
  function onTranscriptScroll() {
    const node = transcript.current;
    if (!node) return;
    const intent = scrollIntent(lastTop.current, node.scrollTop);
    lastTop.current = node.scrollTop;
    if (intent === "up") {
      setStick(false);
      return;
    }
    if (intent === "down") setStick(stickAfterScroll(stick.current, node).stick);
  }

  /** Scrolls the transcript (not the page) to one approval card and flashes it. */
  function locateProposal(id: string) {
    const node = transcript.current;
    const card = node?.querySelector<HTMLElement>(`[data-proposal="${CSS.escape(id)}"]`);
    if (!node || !card) return;
    setStick(false);
    const offset =
      card.getBoundingClientRect().top - node.getBoundingClientRect().top + node.scrollTop;
    node.scrollTo({ top: Math.max(0, offset - 12), behavior: "smooth" });
    setFocusedProposal(id);
    window.setTimeout(() => setFocusedProposal((old) => (old === id ? "" : old)), 2000);
  }

  /** The arrow in the transcript: come back to the newest content. */
  function jumpToEnd() {
    const node = transcript.current;
    if (!node) return;
    setStick(true);
    node.scrollTop = node.scrollHeight;
    lastTop.current = node.scrollTop;
  }

  // One shared clock for the run: it stops ticking when the stream is over.
  useEffect(() => {
    if (!busy && !following) return;
    setTick((v) => v + 1);
    const timer = setInterval(() => setTick((v) => v + 1), 500);
    return () => clearInterval(timer);
  }, [busy, following]);

  /**
   * Re-attaches to a run that is still going on the server.
   *
   * `following` used to mean "poll the transcript every 1.5 s". The run is a
   * stream now, so the re-attach endpoint replays what has already happened and
   * then keeps writing live frames — the answer appears written out, not in
   * 1.5-second lumps, and a refresh costs nothing but a reconnect.
   *
   * `from` is the number of frames already rendered, so coming back to a tab
   * after a dropped socket does not duplicate the part that was already shown.
   */
  /**
   * Stops the run the operator is looking at.
   *
   * The button used to close the socket, which stopped the run only because the
   * run lived inside that request. Now the run is detached, so stopping is an
   * explicit call: the stream is closed here and the server is told to abort, so
   * the same button works on a page that merely re-attached after a reload.
   */
  async function stopRun() {
    const runId = attached.current.runId;
    stopping.current = true;
    setHalted(true);
    follower.current?.abort();
    controller.current?.abort();
    setFollowing(false);
    setError("已停止");
    setProgress((old) => (old ? stopProgress(old) : old));
    if (!runId || !conversationId) {
      stopping.current = false;
      return;
    }
    try {
      await apiFetch(
        `/api/ai/conversations/${conversationId}/runs/${runId}/stop`,
        { method: "POST", body: JSON.stringify({ confirm: true }) },
      );
    } catch (e) {
      setError(workspaceError(e));
    } finally {
      stopping.current = false;
    }
  }

  function newChat() {
    follower.current?.abort();
    controller.current?.abort();
    setEntries([]);
    // A new chat has no questions of its own to recall yet, and keeping the old
    // ones would offer `up` questions that belong to a conversation the operator
    // just left.
    setHistory([]);
    cursor.current = NEW_CURSOR;
    setInput(readDraft(draftKey(machineId, "")));
    setQueue([]);
    setHalted(false);
    stale.current = false;
    setConversationId("");
    setError("");
    setNotice("");
    setProgress(null);
    setUsage(null);
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

  function addOfficialProfile(provider: OfficialProvider, model: string) {
    if (profiles.length >= 20) { setError("最多只能保存 20 个模型配置"); return; }
    const draft: Draft = {
      ...blankDraft(), name: `${provider.name} · ${model}`,
      baseUrl: provider.baseUrl, protocol: "chat", model,
      officialProvider: provider.id,
    };
    setProfiles((old) => [...old, draft]);
    setEditingId(draft.id);
    setActiveProfile(draft.id);
    setNotice("官方模型已添加，请点击「保存全部配置」后使用");
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
      writeDraft(draftKey(machineId, id), "");
      setConversations((old) => old.filter((item) => item.id !== id));
      if (id === conversationId) newChat();
      setNotice("已删除对话");
    } catch (e) {
      setError(workspaceError(e));
    }
  }

  function runBuiltin(command: BuiltinCommand) {
    if (command === "new") newChat();
    else if (command === "settings") setSettings(true);
    else if (busy || following) void stopRun();
    else setNotice("当前没有正在运行的一轮");
  }

  function clearBox() {
    setInput("");
    setAttachments([]);
    cursor.current = NEW_CURSOR;
  }

  /** Keeps the box for after this turn; `false` when the queue is full. */
  function queueBox(message: string, images: Attachment[]) {
    const next = enqueue(queue, message, newId(), images);
    if (!next) {
      setError(`最多排队 ${QUEUE_LIMIT} 条消息`);
      return false;
    }
    setQueue(next);
    clearBox();
    return true;
  }

  /**
   * Sends the box into the running turn (steering): the model reads it after
   * the step it is on, or instead of finishing. A turn that is already wrapping
   * up refuses it, and the message is queued for right after.
   */
  async function steerBox() {
    const message = input.trim();
    const images = attachments;
    if (!message && !images.length) return;
    if (builtinCommand(message)) return void send();
    const runId = attached.current.runId;
    if (!runId || !conversationId) {
      queueBox(message, images);
      return;
    }
    const key = nextKey();
    push({
      key,
      kind: "steer",
      text: message,
      images: images.map((image) => ({ src: attachmentUrl(image) })),
      pending: images,
    });
    clearBox();
    setStick(true);
    try {
      await apiFetch(`/api/ai/conversations/${conversationId}/runs/${runId}/steer`, {
        method: "POST",
        body: JSON.stringify({
          message,
          images: images.map(({ mime, data }) => ({ mime, data })),
        }),
      });
    } catch (e) {
      setEntries((old) => old.filter((entry) => entry.key !== key));
      if ((e as Error)?.message === "run_not_steerable") {
        const next = enqueue(queue, message, newId(), images);
        if (next) setQueue(next);
        setNotice("这一轮正在收尾，消息已改为排队，结束后自动发送");
      } else {
        setInput(message);
        setAttachments(images);
        setError(workspaceError(e));
      }
    }
  }

  /**
   * Sends the box, or `text` when a queued follow-up goes out. While a turn is
   * running (here or watched after a reload) the box is queued instead: one
   * conversation runs one turn at a time on the server.
   */
  async function send(text?: string, queuedImages?: Attachment[]) {
    const fromBox = text === undefined;
    const message = (text ?? input).trim();
    const images = fromBox ? attachments : (queuedImages ?? []);
    if (!message && !images.length) return;
    const builtin = images.length ? null : builtinCommand(message);
    if (builtin) {
      if (fromBox) setInput("");
      runBuiltin(builtin);
      return;
    }
    if (busy || following) {
      if (fromBox) queueBox(message, images);
      return;
    }
    if (fromBox) clearBox();
    setHalted(false);
    stale.current = false;
    // The question just asked is now the newest one `up` reaches, and the box
    // stops browsing: recall is per conversation, so `setHistory` here is the
    // one place the list grows from the operator's own typing.
    if (message) setHistory((old) => remember(old, message));
    cursor.current = NEW_CURSOR;
    setError("");
    setNotice("");
    setHostOpen(false);
    push({
      key: nextKey(),
      kind: "user",
      text: message,
      images: images.map((image) => ({ src: attachmentUrl(image) })),
    });
    setBusy(true);
    setProgress(startProgress());
    // The running total stays on screen while the new question is answered: it
    // grows as the provider reports, instead of going blank until the end.
    clock.current = { start: Date.now(), end: 0 };
    attached.current = { runId: "", frames: 0 };
    const ac = new AbortController();
    controller.current = ac;
    try {
      const token = getToken();
      // A deleted machine cannot be unchecked in the picker, so drop ids that
      // are gone from the machine list instead of failing the whole question.
      const active = hostOptions.length
        ? hosts.filter((id) => hostOptions.some((option) => option.id === id))
        : hosts;
      if (active.length !== hosts.length) setHosts(active);
      const response = await fetch(`/api/ai/machines/${machineId}/chat`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          conversationId,
          message,
          images: images.map(({ mime, data }) => ({ mime, data })),
          root,
          autoRun,
          profileId: activeProfile,
          hosts: active,
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
      await readFrames(response, (event) => {
        // Remember which run this is the moment the server names it, so a
        // reload (or the reconnect below) can find it again. The count is kept
        // in step with the frames so a reconnect resumes without repeating.
        if (event.type === "start" && typeof event.runId === "string")
          attached.current = { runId: event.runId, frames: 0 };
        attached.current.frames += 1;
        handleEvent(event);
      });
      void loadConversations();
    } catch (e) {
      const aborted = ac.signal.aborted || (e as Error)?.name === "AbortError";
      setHalted(true);
      if (!stopping.current) stale.current = true;
      // A stopped request no longer stops the run (the run is detached now), so
      // the wording must not claim it did.
      if (stopping.current) {
        setError("已停止");
        setProgress((old) => (old ? stopProgress(old) : old));
      } else {
        setError(aborted ? "已断开与这一轮的连接" : workspaceError(e));
        setProgress((old) => (aborted ? stopProgress(old) : failProgress(old)));
      }
      // Losing the socket is exactly the case the run is detached for: come
      // back to it instead of leaving a half-written answer on screen.
      const runId = attached.current.runId;
      const offline =
        !aborted &&
        (/network|failed to fetch|load failed/i.test(String(e)) ||
          /^http_5/.test(workspaceError(e)));
      if (runId && offline) void followRun(runId, attached.current.frames);
    } finally {
      // Nothing may still be buffered once the run is reported as over: the
      // last tokens belong to the answer the operator is reading.
      stream.current?.flush();
      // The run clock stops here: the status line keeps the final duration.
      clock.current.end = clock.current.end || Date.now();
      setBusy(false);
      controller.current = null;
    }
  }

  const updateProposal = useCallback((proposal: Proposal) => {
    setEntries((old) =>
      old.map((entry) =>
        entry.kind === "proposal" && entry.proposal.id === proposal.id
          ? { key: entry.key, kind: "proposal", proposal }
          : entry,
      ),
    );
  }, []);

  const decide = useCallback(
    async (proposal: Proposal, action: "apply" | "revert" | "reject") => {
      // The card knows which server it belongs to; the conversation root is only
      // a fallback for cards written before the multi-host assistant existed.
      const where = proposal.host ? `主机 ${proposal.host} 上` : "服务器上";
      const confirmText =
        action === "apply"
          ? proposal.kind === "command"
            ? `在${where}的目录 ${proposal.path || root} 执行以下命令？\n\n${proposal.after}`
            : `写入${where}的 ${proposal.path}？修改前的版本会自动备份。`
          : action === "revert"
            ? `撤销对${where} ${proposal.path} 的修改？`
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
    },
    [machineId, root, updateProposal],
  );

  const pendingList = useMemo(
    () =>
      entries.flatMap((entry) =>
        entry.kind === "proposal" && entry.proposal.status === "pending"
          ? [{ proposal: entry.proposal, stat: entry.proposal.kind === "file" ? diffStat(entry.proposal) : null }]
          : [],
      ),
    [entries],
  );
  const pending = pendingList.length;
  const running = busy || following;
  const hasContent = input.trim().length > 0 || attachments.length > 0;
  const flush = flushDecision({ running, queued: queue.length, pending, halted });

  useEffect(() => {
    if (flush !== "send") return;
    const [next, ...rest] = queue;
    setQueue(rest);
    void send(next.text, next.images);
  }, [flush, queue]);

  function sendQueuedNow(item: Queued) {
    setQueue((old) => removeQueued(old, item.id));
    void send(item.text, item.images);
  }

  function editQueued(item: Queued) {
    setQueue((old) => removeQueued(old, item.id));
    setInput((old) => (old.trim() ? `${item.text}\n${old}` : item.text));
    if (item.images?.length)
      setAttachments((old) => [...old, ...item.images!].slice(0, MAX_IMAGES));
    inputRef.current?.focus();
  }

  /** Pictures from the picker, a paste or a drop; downscaled before upload. */
  async function addImages(files: File[]) {
    if (!files.length) return;
    const room = MAX_IMAGES - attachments.length;
    if (room <= 0) {
      setError(`每条消息最多 ${MAX_IMAGES} 张图片`);
      return;
    }
    if (files.length > room) setNotice(`每条消息最多 ${MAX_IMAGES} 张图片，多出的已忽略`);
    setAttaching(true);
    try {
      const prepared: Attachment[] = [];
      for (const file of files.slice(0, room)) {
        try {
          prepared.push(await prepareImage(file, newId()));
        } catch (e) {
          setError(workspaceError(e));
        }
      }
      setAttachments((old) => [...old, ...prepared].slice(0, MAX_IMAGES));
    } finally {
      setAttaching(false);
    }
  }

  const slash = slashDismissed ? null : slashQuery(input, caret);
  const slashMatches = useMemo(
    () => (slash === null ? [] : matchCommands(commands, slash)),
    [commands, slash],
  );
  const slashOpen = slashMatches.length > 0;

  useEffect(() => {
    if (slash === null || commandsLoaded.current) return;
    commandsLoaded.current = true;
    void (async () => {
      try {
        const data = await apiFetch<{
          prompts: Array<{ name: string; description?: string; packageName?: string }>;
        }>("/api/ai/extensions");
        setCommands([
          ...BUILTIN_COMMANDS,
          ...data.prompts.map((prompt) => ({
            name: prompt.name,
            description: prompt.description || "扩展提示模板",
            source: "extension" as const,
            packageName: prompt.packageName,
          })),
        ]);
      } catch {
        // built-in commands still work
      }
    })();
  }, [slash]);

  useEffect(() => setSlashIndex(0), [slash]);

  function chooseCommand(command: SlashCommand) {
    if (command.source === "builtin") {
      setInput("");
      runBuiltin(command.name as BuiltinCommand);
      return;
    }
    const next = applyCommand(input, command.name);
    setInput(next);
    setCaret(next.length);
    requestAnimationFrame(() => {
      const node = inputRef.current;
      if (!node) return;
      node.focus();
      node.setSelectionRange(next.length, next.length);
    });
  }

  // The box grows with the question up to a cap, instead of a fixed height
  // plus a drag handle that is unusable on a phone.
  useEffect(() => {
    const node = inputRef.current;
    if (!node) return;
    node.style.height = "auto";
    node.style.height = `${Math.min(node.scrollHeight + 2, mobile ? 168 : 240)}px`;
  }, [input, mobile]);

  const copyEntry = useCallback(async (key: string, text: string) => {
    if (!(await copyText(text))) {
      setError("复制失败，请手动选择文本");
      return;
    }
    setCopied(key);
    window.setTimeout(() => setCopied((old) => (old === key ? "" : old)), 1500);
  }, []);

  const editPrompt = useCallback((text: string) => {
    setInput(text);
    cursor.current = NEW_CURSOR;
    requestAnimationFrame(() => {
      const node = inputRef.current;
      if (!node) return;
      node.focus();
      node.setSelectionRange(text.length, text.length);
    });
  }, []);

  /** Folds or unfolds one tool card or thinking block. */
  const toggleRow = useCallback(
    (key: string, open: boolean, thinking: boolean) => {
      const set = thinking ? setOpenThinking : setOpenTools;
      set((old) => ({ ...old, [key]: !open }));
    },
    [],
  );

  const lastPrompt = history.at(-1) ?? "";
  const runLabel =
    AUTO_RUN_MODES.find((mode) => mode.value === autoRun)?.label.replace(/（.*）/, "") ?? "";
  // The elapsed time freezes as soon as the stream is over.
  const elapsed = clock.current.start
    ? Math.max(0, (clock.current.end || Date.now()) - clock.current.start)
    : 0;
  // Shown for the whole conversation, from the stored total and every report
  // that follows. The cache part appears once the provider has said how much of
  // the prompt it served from its cache; a provider that stays quiet is not
  // shown as a permanent miss.
  const cache = cacheStats(usage);
  const choices = hostChoices(hostOptions, machineId);
  // Falls back to the id when the machine list is unavailable (viewer account),
  // so the picker still names the host a turn will use.
  const primaryName =
    hostOptions.find((option) => option.id === machineId)?.name ?? `#${machineId}`;
  const selectedNames = hostNames(hosts, hostOptions, primaryName);

  // Steps of the turn that is still running stay unfolded so progress is
  // visible; finished turns fold long runs of steps into one line.
  const lastUser = ordered.reduce(
    (found, entry, index) => (entry.kind === "user" ? index : found),
    -1,
  );
  const liveKeys = new Set(
    running ? ordered.slice(lastUser + 1).map((entry) => entry.key) : [],
  );
  const transcriptItems = useMemo(() => groupSteps(ordered), [ordered]);
  // Everything a row may call, in one object that only changes when a handler
  // does. Together with the memoised `Row` this is what keeps a reply that is
  // already on screen from being re-rendered token by token.
  const actions = useMemo<RowActions>(
    () => ({
      copy: copyEntry,
      edit: editPrompt,
      openImage: setViewer,
      toggle: toggleRow,
      decide,
    }),
    [copyEntry, editPrompt, toggleRow, decide],
  );
  const rowCtx = useMemo(
    () => ({ conversationId, actions }),
    [conversationId, actions],
  );
  // A thinking block is unfolded while it is the newest thing on screen and
  // folds itself once the answer it produced starts to arrive.
  const newest = ordered.at(-1)?.key ?? "";

  const renderRow = (entry: Entry) => (
    <Row
      key={entry.key}
      entry={entry}
      ctx={rowCtx}
      copied={copied === entry.key}
      focused={entry.kind === "proposal" && focusedProposal === entry.proposal.id}
      open={
        entry.kind === "tool"
          ? (openTools[entry.key] ?? entry.tool.state === "error")
          : entry.kind === "thinking" &&
            (openThinking[entry.key] ?? (running && entry.key === newest))
      }
    />
  );

  const renderGroup = (
    item: Extract<ReturnType<typeof groupSteps<Entry>>[number], { type: "group" }>,
  ) => {
    const open = openGroups[item.key] ?? liveKeys.has(item.entries[0].key);
    const summary = stepSummary(
      item.entries.flatMap((entry) => (entry.kind === "tool" ? [entry.tool.state] : [])),
    );
    return (
      <div key={item.key} className="ai-step-group">
        <button
          type="button"
          className="ai-step-group-head"
          aria-expanded={open}
          onClick={() => setOpenGroups((old) => ({ ...old, [item.key]: !open }))}
        >
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          <span>已执行 {summary.total} 个步骤</span>
          {summary.running ? <span className="ai-tool-state running">{summary.running} 个进行中</span> : null}
          {summary.awaiting ? <span className="ai-tool-state awaiting">{summary.awaiting} 个待确认</span> : null}
          {summary.failed ? <span className="ai-tool-state error">{summary.failed} 个失败</span> : null}
          {!summary.running && !summary.failed && !summary.awaiting ? (
            <span className="ai-tool-state ok">全部完成</span>
          ) : null}
        </button>
        {open ? (
          <div className="ai-step-group-body">{item.entries.map(renderRow)}</div>
        ) : null}
      </div>
    );
  };

  return (
    <div
      className={`ai-chat${compact ? " compact" : ""}${settings ? " ai-settings-open" : ""}${mobile ? " touch" : ""}`}
    >
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
          onChange={(e) => {
            // Choosing the model for the next question also ends the editing
            // session, so the chat is not left covered by the settings panel.
            setSettings(false);
            void activate(e.target.value);
          }}
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
          aria-controls="ai-settings-panel"
          onClick={() => setSettings((v) => !v)}
        >
          <Settings2 size={17} />
        </button>
        {onClose ? (
          <button
            className="icon-btn"
            title="收起 AI 助手"
            aria-label="收起 AI 助手"
            onClick={onClose}
          >
            <X size={18} />
          </button>
        ) : null}
      </div>
      {settings && (
        <form
          id="ai-settings-panel"
          className="ai-settings ai-profiles"
          onSubmit={(e) => {
            e.preventDefault();
            void saveSettings();
          }}
        >
          <div className="ai-profiles-top">
            <span className="ai-profiles-label">模型配置</span>
            <div className="ai-profiles-actions">
              <button
                type="button"
                className="ai-profile-mini"
                title="添加一个自定义（第三方）API 配置"
                onClick={addProfile}
              >
                <Plus size={13} />
                添加三方 API
              </button>
              <button
                type="button"
                className="ai-profile-mini"
                aria-label="收起设置"
                title="收起设置"
                onClick={() => setSettings(false)}
              >
                <X size={13} />
                收起
              </button>
            </div>
          </div>
          <OfficialModels onAdd={addOfficialProfile} />
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
                {!profile.officialProvider && !profile.hasKey && !profile.apiKey ? (
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
                  readOnly={!!current.officialProvider}
                  placeholder={
                    current.protocol === "anthropic"
                      ? "https://api.anthropic.com"
                      : "https://api.example.com/v1"
                  }
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
                  readOnly={!!current.officialProvider}
                  placeholder={
                    current.protocol === "anthropic"
                      ? "claude-sonnet-4-5"
                      : ""
                  }
                  onChange={(e) => patch(current.id, { model: e.target.value })}
                />
              </label>
              <label>
                协议
                <select
                  className="yaws-select w-full"
                  aria-label="协议"
                  value={current.protocol}
                  disabled={!!current.officialProvider}
                  onChange={(e) =>
                    patch(current.id, {
                      protocol: e.target.value as Profile["protocol"],
                    })
                  }
                >
                  <option value="chat">Chat Completions</option>
                  <option value="responses">Responses</option>
                  <option value="anthropic">Anthropic Messages</option>
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
              {(!current.officialProvider ||
                current.officialProvider === "openai-codex") &&
                // `service_tier` is an OpenAI field; the Messages API rejects it.
                current.protocol !== "anthropic" && (
                <label>
                  输出速度
                  <select
                    className="yaws-select w-full"
                    aria-label="输出速度"
                    value={current.speed}
                    onChange={(e) => patch(current.id, { speed: e.target.value })}
                  >
                    <option value="">默认</option>
                    <option value="priority">快速 Fast（约 2× 费用）</option>
                    <option value="flex">经济 Flex（约 0.5× 费用）</option>
                    <option value="ultrafast">极速 Ultrafast（限部分模型）</option>
                  </select>
                </label>
              )}
              {!current.officialProvider && <label>
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
              </label>}
              {!current.officialProvider && <div className="ai-profile-keynote">
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
              </div>}
              {!current.officialProvider && <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={current.allowPrivate}
                  onChange={(e) =>
                    patch(current.id, { allowPrivate: e.target.checked })
                  }
                />
                允许内网 / HTTP 接口
              </label>}
              {!current.officialProvider && current.protocol === "anthropic" && (
                <>
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={!!current.claudeCode}
                      onChange={(e) =>
                        patch(current.id, { claudeCode: e.target.checked })
                      }
                    />
                    伪装成 Claude Code 客户端
                  </label>
                  <p className="ai-profile-note">
                    打开后请求会带上官方客户端的身份：
                    <code>user-agent: claude-cli/…</code>、<code>x-app: cli</code>、
                    <code>X-Claude-Code-Session-Id</code>、
                    <code>anthropic-beta</code>（含 <code>claude-code-20250219</code>）、
                    <code>metadata.user_id</code>，系统提示词换成客户端那段（后面接本对话的运行环境），
                    工具名也换成它的写法（执行前会换回来）。
                    用于只给 Claude Code 订阅通道开门的中转站；直接连官方接口时不必打开。
                  </p>
                </>
              )}
              {current.officialProvider && <p className="ai-profile-keynote">
                官方账号授权 · {current.officialProvider}；地址与协议由 pi 固定，不能修改。
                退出登录请在上方「登录官方模型」中操作。
              </p>}
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
          <McpSettings />
          <ExtensionSettings />
        </form>
      )}
      <div className="ai-chat-body">
        <div
          className="ai-chat-transcript"
          ref={transcript}
          onScroll={onTranscriptScroll}
        >
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
        {transcriptItems.map((item) =>
          item.type === "group" ? renderGroup(item) : renderRow(item.entry),
        )}
        </div>
        {/* Only offered while the update stream is off: the operator scrolled
            back to read something and the newest tokens are below the fold. */}
        {!atEnd ? (
          <button
            type="button"
            className="ai-chat-jump"
            title="回到最新内容"
            aria-label="回到最新内容"
            onClick={jumpToEnd}
          >
            <ChevronDown size={15} />
            回到最新
          </button>
        ) : null}
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
      {/* What this conversation has cost, kept on screen like the footer of a
          terminal agent: an answer ending does not make the numbers stop being
          true, and the cache rate is what makes a long chat cheap. */}
      <div
        className="ai-usage"
        title="本对话累计：每一轮上报的输入/输出 tokens 相加，缓存命中率按累计提示词计算"
      >
        <span className="ai-usage-scope">本对话</span>
        <span>输入 {formatTokens(usage?.promptTokens ?? 0)}</span>
        <span>输出 {formatTokens(usage?.completionTokens ?? 0)}</span>
        <span>共 {formatTokens(usage?.totalTokens ?? 0)} tokens</span>
        {cache ? (
          <span
            className="ai-usage-cache"
            data-hit={cache.cached > 0 ? "yes" : "no"}
            title={`本对话提示词缓存命中 ${cache.cached} / ${cache.prompt} tokens`}
          >
            缓存 {formatTokens(cache.cached)}/{formatTokens(cache.prompt)} ·{" "}
            命中率 {cache.rate}%
            <i className="ai-usage-bar">
              <b style={{ width: `${Math.min(100, cache.rate)}%` }} />
            </i>
          </span>
        ) : null}
      </div>
      {error && (
        <div role="alert" className="yaws-alert-error ai-chat-error">
          <span>{error}</span>
          {!running && lastPrompt && error !== "已停止" ? (
            <button
              type="button"
              className="ai-error-retry"
              title={`重新发送：${lastPrompt}`}
              onClick={() => void send(lastPrompt)}
            >
              <RotateCcw size={13} />
              重试
            </button>
          ) : null}
          <button
            type="button"
            className="ai-error-close"
            title="关闭"
            aria-label="关闭提示"
            onClick={() => setError("")}
          >
            <X size={13} />
          </button>
        </div>
      )}
      {notice && <div className="workspace-notice">{notice}</div>}
      {pending > 0 ? (
        <div className="ai-chat-pending">
          <button
            type="button"
            className="ai-pending-toggle"
            aria-expanded={pendingOpen}
            onClick={() => setPendingOpen((open) => !open)}
          >
            {pendingOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            <AlertTriangle size={13} />
            <span>有 {pending} 条操作等待你确认，确认后助手才能继续。</span>
            <span className="ai-pending-hint">{pendingOpen ? "收起" : "点击查看待确认列表"}</span>
          </button>
          {pendingOpen ? (
            <ol className="ai-pending-list" aria-label="待确认操作">
              {pendingList.map(({ proposal, stat }, index) => (
                <li key={proposal.id} className="ai-pending-item">
                  <div className="ai-pending-head">
                    <span className="ai-pending-index">{index + 1}</span>
                    {proposal.host ? <span className="ai-tag host">{proposal.host}</span> : null}
                    <span className="ai-tag">{proposal.kind === "command" ? "执行命令" : "修改文件"}</span>
                    <span className="ai-pending-path">
                      {proposal.kind === "command" ? `目录 ${proposal.path || root}` : proposal.path}
                    </span>
                    <span className="ai-pending-actions">
                      <button
                        type="button"
                        className="yaws-btn tool-text"
                        onClick={() => locateProposal(proposal.id)}
                      >
                        定位
                      </button>
                      <button
                        type="button"
                        className="yaws-btn tool-text"
                        onClick={() => void decide(proposal, "reject")}
                      >
                        忽略
                      </button>
                      <button
                        type="button"
                        className="yaws-btn-primary tool-text"
                        onClick={() => void decide(proposal, "apply")}
                      >
                        {proposal.kind === "file" ? <Check size={14} /> : <Play size={14} />}
                        {proposal.kind === "file" ? "应用" : "执行"}
                      </button>
                    </span>
                  </div>
                  {proposal.summary ? (
                    <div className="ai-pending-summary">{proposal.summary}</div>
                  ) : null}
                  {proposal.kind === "command" ? (
                    <pre className="ai-pending-cmd">{proposal.after}</pre>
                  ) : stat ? (
                    <div className="ai-pending-summary">
                      <span className="diff-add">+{stat.added}</span>{" "}
                      <span className="diff-remove">-{stat.removed}</span> 行
                    </div>
                  ) : null}
                </li>
              ))}
            </ol>
          ) : null}
        </div>
      ) : null}
      {queue.length ? (
        <div className="ai-queue" aria-label="排队中的消息">
          <div className="ai-queue-head">
            <ListPlus size={13} />
            <span>
              {flush === "hold"
                ? halted
                  ? "上一轮已停止或出错，排队消息暂不自动发送"
                  : "处理完待确认操作后自动发送"
                : `排队 ${queue.length} 条，本轮结束后依次发送`}
            </span>
          </div>
          <ol className="ai-queue-list">
            {queue.map((item) => (
              <li key={item.id} className="ai-queue-item">
                <span className="ai-queue-text" title={item.text}>
                  {item.images?.length ? (
                    <span className="ai-tag">图片 {item.images.length}</span>
                  ) : null}{" "}
                  {item.text || "（仅图片）"}
                </span>
                {!running ? (
                  <button
                    type="button"
                    title="立即发送"
                    aria-label="立即发送"
                    onClick={() => sendQueuedNow(item)}
                  >
                    <Send size={13} />
                  </button>
                ) : null}
                <button
                  type="button"
                  title="放回输入框编辑"
                  aria-label="编辑"
                  onClick={() => editQueued(item)}
                >
                  <PencilLine size={13} />
                </button>
                <button
                  type="button"
                  title="移除"
                  aria-label="移除"
                  onClick={() => setQueue((old) => removeQueued(old, item.id))}
                >
                  <X size={13} />
                </button>
              </li>
            ))}
          </ol>
        </div>
      ) : null}
      <form
        className={`ai-chat-composer${dragOver ? " drag" : ""}`}
        onSubmit={(e) => {
          e.preventDefault();
          void (running ? steerBox() : send());
        }}
        onDragOver={(e) => {
          if (!Array.from(e.dataTransfer.types).includes("Files")) return;
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver(false);
        }}
        onDrop={(e) => {
          const files = imageFiles(e.dataTransfer.files);
          setDragOver(false);
          if (!files.length) return;
          e.preventDefault();
          void addImages(files);
        }}
      >
        <button
          type="button"
          className="ai-meta-toggle"
          aria-expanded={metaOpen}
          aria-controls="ai-chat-meta"
          onClick={() => setMetaOpen((v) => !v)}
        >
          <SlidersHorizontal size={13} />
          <span className="ai-meta-summary">
            {root} · {runLabel} · {hostSummary(hosts, hostOptions.length || 1)}
          </span>
          {metaOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>
        <div id="ai-chat-meta" className={`ai-chat-meta${metaOpen ? " open" : ""}`}>
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
          <div className="ai-meta-hosts">
            <button
              type="button"
              ref={hostButton}
              className="ai-host-toggle"
              aria-label="选择主机"
              aria-expanded={hostOpen}
              title="本轮问题可以操作的主机"
              disabled={busy || following}
              onClick={() => setHostOpen((open) => !open)}
            >
              <Server size={14} />
              {hostSummary(hosts, hostOptions.length || 1)}
            </button>
            {hostOpen ? (
              <FloatingPanel
                anchor={hostButton.current}
                className="ai-host-menu"
                label="选择主机"
                onClose={() => setHostOpen(false)}
              >
                <div className="ai-host-row">
                  <Check size={13} />
                  <span className="ai-host-name">
                    {primaryName} (#{machineId})
                  </span>
                  <span className="ai-tag">主</span>
                </div>
                {choices.length === 0 ? (
                  <p className="ai-host-note">
                    只有这一台主机。在「机器」里添加其它服务器后，可以在这里一起选中。
                  </p>
                ) : (
                  choices.map((host) => (
                    <label key={host.id} className="ai-host-row">
                      <input
                        type="checkbox"
                        checked={hosts.includes(host.id)}
                        onChange={() =>
                          setHosts((old) => toggleHost(old, host.id, machineId))
                        }
                      />
                      <span className="ai-host-name">
                        {host.name} (#{host.id})
                      </span>
                    </label>
                  ))
                )}
                <p className="ai-host-note">
                  勾选的主机会随本轮问题一起提交。只读检查可以一次跑多台；修改类操作仍然一台一张确认卡片。
                </p>
              </FloatingPanel>
            ) : null}
          </div>
          {session.model ? (
            <span
              className="ai-chat-session"
              title={`本对话由「${session.name || "配置"}」生成`}
            >
              {session.name ? `${session.name} · ` : ""}
              {session.model}
            </span>
          ) : null}
          <label className="ai-meta-enter flex items-center gap-1">
            回车键
            <select
              className="yaws-select"
              aria-label="回车键行为"
              value={enterPref}
              onChange={(e) => {
                const value = e.target.value as EnterPreference;
                setEnterPref(value);
                writeEnterPreference(value);
              }}
            >
              {ENTER_PREFERENCES.map((pref) => (
                <option key={pref.value} value={pref.value}>
                  {pref.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        {selectedNames.length > 1 ? (
          <div className="ai-host-chips" aria-label="本轮主机">
            {selectedNames.map((name, index) => (
              <span key={`${name}-${index}`} className="ai-host-chip">
                {name}
                {index === 0 ? <em>主</em> : null}
              </span>
            ))}
          </div>
        ) : null}
        {attachments.length || attaching ? (
          <div className="ai-attachments" aria-label="待发送的图片">
            {attachments.map((image) => (
              <span key={image.id} className="ai-attachment">
                <button
                  type="button"
                  className="ai-attachment-view"
                  aria-label="查看图片"
                  onClick={() => setViewer(attachmentUrl(image))}
                >
                  <img src={attachmentUrl(image)} alt="" />
                </button>
                <button
                  type="button"
                  className="ai-attachment-remove"
                  title="移除图片"
                  aria-label="移除图片"
                  onClick={() =>
                    setAttachments((old) => old.filter((item) => item.id !== image.id))
                  }
                >
                  <X size={12} />
                </button>
              </span>
            ))}
            {attaching ? <span className="ai-attachment loading">处理中…</span> : null}
          </div>
        ) : null}
        <div className="ai-chat-input">
          <input
            ref={fileInput}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(e) => {
              const files = imageFiles(e.target.files);
              e.target.value = "";
              void addImages(files);
            }}
          />
          <button
            type="button"
            className="icon-btn ai-attach"
            title={`添加图片（也可以粘贴或拖进来，最多 ${MAX_IMAGES} 张）`}
            aria-label="添加图片"
            disabled={attachments.length >= MAX_IMAGES || attaching}
            onClick={() => fileInput.current?.click()}
          >
            <ImagePlus size={17} />
          </button>
          {slashOpen ? (
            <ul className="ai-slash-menu" role="listbox" aria-label="命令">
              {slashMatches.map((command, index) => (
                <li key={`${command.source}-${command.name}`} role="presentation">
                  <button
                    type="button"
                    role="option"
                    aria-selected={index === slashIndex}
                    className={index === slashIndex ? "active" : ""}
                    // Keep the focus (and the phone keyboard) in the box.
                    onPointerDown={(e) => e.preventDefault()}
                    onClick={() => chooseCommand(command)}
                  >
                    <span className="ai-slash-name">/{command.name}</span>
                    <span className="ai-slash-desc">{command.description}</span>
                    {command.packageName ? (
                      <span className="ai-tag">{command.packageName}</span>
                    ) : command.source === "builtin" ? (
                      <span className="ai-tag">内置</span>
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          <textarea
            className="yaws-input"
            rows={mobile ? 1 : compact ? 2 : 3}
            value={input}
            ref={inputRef}
            placeholder={
              mobile
                ? "问点什么… 输入 / 查看命令"
                : "问点什么，例如：帮我看看 nginx 为什么 502    （↑ / ↓ 翻历史问题，/ 查看命令）"
            }
            aria-label="问题"
            enterKeyHint={
              enterAction({ key: "Enter", shiftKey: false }, mobile, enterPref) === "send"
                ? "send"
                : "enter"
            }
            onChange={(e) => {
              setInput(e.target.value);
              setCaret(e.target.selectionStart ?? e.target.value.length);
              setSlashDismissed(false);
              // Editing is not browsing: the recalled question becomes the
              // operator's own text, so `down` must not silently replace it.
              cursor.current = { ...cursor.current, index: 0 };
            }}
            onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
            onPaste={(e) => {
              const files = imageFiles(e.clipboardData.items);
              if (!files.length) return;
              e.preventDefault();
              void addImages(files);
            }}
            onBlur={() => {
              explicitShift.current = false;
              if (mobile) repairViewportScroll();
            }}
            onKeyUp={(e) => {
              if (e.key === "Shift") explicitShift.current = false;
            }}
            onKeyDown={(e) => {
              if (e.key === "Shift") {
                explicitShift.current = true;
                return;
              }
              if (slashOpen) {
                if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                  e.preventDefault();
                  const step = e.key === "ArrowDown" ? 1 : -1;
                  setSlashIndex(
                    (old) => (old + step + slashMatches.length) % slashMatches.length,
                  );
                  return;
                }
                if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
                  e.preventDefault();
                  chooseCommand(slashMatches[slashIndex] ?? slashMatches[0]);
                  return;
                }
                if (e.key === "Escape") {
                  e.preventDefault();
                  setSlashDismissed(true);
                  return;
                }
              }
              const action = enterAction(
                {
                  key: e.key,
                  shiftKey: e.shiftKey,
                  ctrlKey: e.ctrlKey,
                  metaKey: e.metaKey,
                  composing: e.nativeEvent.isComposing || e.keyCode === 229,
                  explicitShift: explicitShift.current,
                },
                mobile,
                enterPref,
              );
              if (action === "send") {
                e.preventDefault();
                void (running ? steerBox() : send());
                return;
              }
              if (action === "newline") return;
              if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
              if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
              // In a multi-line question the arrow keys first have to move the
              // caret through the lines the operator is writing; recall only
              // takes over once there is no line left in that direction.
              const caret = e.currentTarget.selectionStart ?? 0;
              if (!atEdge(input, caret, e.key === "ArrowUp" ? -1 : 1)) return;
              const target = e.currentTarget;
              const moved =
                e.key === "ArrowUp"
                  ? historyUp(history, cursor.current, input)
                  : historyDown(history, cursor.current, input);
              // Nothing older/newer: let the caret have the key instead of
              // swallowing it, so `up` in an empty box is not a dead key.
              if (!moved) return;
              e.preventDefault();
              cursor.current = moved.cursor;
              setInput(moved.value);
              // The replacement is written by React on the next frame, so the
              // caret is placed there: end of the question, which is where a
              // recalled question is most likely to want an edit.
              requestAnimationFrame(() => {
                const end = target.value.length;
                target.setSelectionRange(end, end);
              });
            }}
          />
          <div className="ai-chat-buttons">
            {running ? (
              <button
                type="button"
                className="yaws-btn tool-text ai-btn-stop"
                title="停止这一轮"
                aria-label="停止"
                onClick={() => void stopRun()}
              >
                <CircleStop size={16} />
                <span className="ai-btn-label">停止</span>
              </button>
            ) : null}
            {running ? (
              hasContent ? (
                <>
                  <button
                    type="button"
                    className="yaws-btn tool-text"
                    title="等这一轮结束后再发送"
                    aria-label="排队发送"
                    onClick={() => void send()}
                  >
                    <ListPlus size={16} />
                    <span className="ai-btn-label">排队</span>
                  </button>
                  <button
                    className="yaws-btn-primary tool-text"
                    type="submit"
                    title="现在就告诉助手：它做完手头这一步就会读到"
                    aria-label="插话"
                  >
                    <MessageCircleReply size={16} />
                    <span className="ai-btn-label">插话</span>
                  </button>
                </>
              ) : null
            ) : (
              <button
                className="yaws-btn-primary tool-text"
                type="submit"
                aria-label="发送"
                disabled={!hasContent}
              >
                <Send size={16} />
                <span className="ai-btn-label">发送</span>
              </button>
            )}
          </div>
        </div>
        <div className="ai-chat-hint">
          {mobile && enterPref !== "send"
            ? "回车换行，点按钮发送。"
            : enterPref === "newline"
              ? "回车换行，Shift+回车 / Ctrl+回车发送。"
              : "回车发送，Shift+回车换行。"}
          运行中发送是“插话”（做完当前这一步就读到），也可以选“排队”等结束后再发；图片可以粘贴、拖入或点图片按钮添加。危险命令（rm -rf、mkfs、改密码等）永远需要确认；凭据文件不会被读取。
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
      {viewer ? <ImageViewer src={viewer} onClose={() => setViewer("")} /> : null}
    </div>
  );

  async function deleteConversation() {
    if (!conversationId || !window.confirm("删除这轮对话记录？")) return;
    try {
      await apiFetch(`/api/ai/conversations/${conversationId}`, { method: "DELETE" });
      writeDraft(draftKey(machineId, conversationId), "");
      newChat();
      void loadConversations();
    } catch (e) {
      setError(workspaceError(e));
    }
  }
}
