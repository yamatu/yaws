import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { apiFetch, type MachineSummary } from "./api";
import { connectUiWs } from "./ws";
import { cycleLabel, daysLeft, fmtTime, formatBps, formatBytes, formatMoneyCents, pct } from "./format";

type LiveMetric = {
  at: number;
  cpuUsage: number;
  memUsed: number;
  memTotal: number;
  diskUsed: number;
  diskTotal: number;
  netRxBytes?: number;
  netTxBytes?: number;
  rxBps?: number;
  txBps?: number;
  load1?: number;
};

type ViewMode = "cards" | "list";
type SortMode = "custom" | "expiry" | "offline";
type GroupKey = string; // "__all__" | "__ungrouped__" | groupName

export function DashboardPage() {
  const nav = useNavigate();
  const [machines, setMachines] = useState<MachineSummary[]>([]);
  const [latest, setLatest] = useState<Record<number, LiveMetric>>({});
  const [wsOk, setWsOk] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    const v = localStorage.getItem("yaws_view_mode");
    return v === "list" || v === "cards" ? (v as ViewMode) : "cards";
  });
  const [sortMode, setSortMode] = useState<SortMode>(() => {
    const v = localStorage.getItem("yaws_sort_mode");
    return v === "expiry" || v === "custom" || v === "offline" ? (v as SortMode) : "custom";
  });
  const [orderSaving, setOrderSaving] = useState(false);
  const [orderError, setOrderError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});
  const dragIdRef = useRef<number | null>(null);
  const [draggingId, setDraggingId] = useState<number | null>(null);
  const [dragOverId, setDragOverId] = useState<number | null>(null);
  const [groupKey, setGroupKey] = useState<GroupKey>(() => localStorage.getItem("yaws_group") || "__all__");

  useEffect(() => {
    let alive = true;
    const ac = new AbortController();
    (async () => {
      try {
        const res = await apiFetch<{ machines: MachineSummary[] }>("/api/machines/summary", { signal: ac.signal });
        if (!alive) return;
        setMachines(res.machines);
        const seed: Record<number, LiveMetric> = {};
        for (const m of res.machines) {
          const lm = m.latestMetric;
          if (!lm) continue;
          seed[m.id] = {
            at: lm.at,
            cpuUsage: lm.cpuUsage,
            memUsed: lm.memUsed,
            memTotal: lm.memTotal,
            diskUsed: lm.diskUsed,
            diskTotal: lm.diskTotal,
            netRxBytes: lm.netRxBytes,
            netTxBytes: lm.netTxBytes,
            load1: lm.load1,
          };
        }
        setLatest((prev) => ({ ...seed, ...prev }));
        if (localStorage.getItem("yaws_view_mode") == null && res.machines.length >= 12) {
          setViewMode("list");
        }
        const ids = res.machines.map((m) => m.id);
        tryConnectWs(ids);
      } catch {
        // ignore
      }
    })();
    return () => {
      alive = false;
      ac.abort();
      wsRef.current?.close();
      wsRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    localStorage.setItem("yaws_view_mode", viewMode);
  }, [viewMode]);

  useEffect(() => {
    localStorage.setItem("yaws_sort_mode", sortMode);
  }, [sortMode]);

  useEffect(() => {
    localStorage.setItem("yaws_group", groupKey);
  }, [groupKey]);

  useEffect(() => {
    if (draggingId == null) return;
    let lastY = 0;
    let raf = 0;
    const onDragOver = (e: DragEvent) => {
      lastY = e.clientY;
      e.preventDefault();
    };
    window.addEventListener("dragover", onDragOver, { passive: false });
    const tick = () => {
      const edge = 90;
      const maxSpeed = 18;
      if (lastY > 0) {
        if (lastY < edge) {
          const p = (edge - lastY) / edge;
          window.scrollBy({ top: -Math.ceil(maxSpeed * p), left: 0 });
        } else if (lastY > window.innerHeight - edge) {
          const p = (lastY - (window.innerHeight - edge)) / edge;
          window.scrollBy({ top: Math.ceil(maxSpeed * p), left: 0 });
        }
      }
      raf = window.requestAnimationFrame(tick);
    };
    raf = window.requestAnimationFrame(tick);
    return () => {
      window.cancelAnimationFrame(raf);
      window.removeEventListener("dragover", onDragOver as any);
    };
  }, [draggingId]);

  function tryConnectWs(machineIds: number[]) {
    try {
      wsRef.current?.close();
      const ws = connectUiWs({
        onEvent: (ev) => {
          if (ev.type === "hello") setWsOk(true);
          if (ev.type === "machine_status") {
            setMachines((prev) =>
              prev.map((m) =>
                m.id === ev.machineId ? { ...m, online: ev.online ? 1 : 0, lastSeenAt: ev.lastSeenAt } : m
              )
            );
          }
          if (ev.type === "metrics") {
            if (ev.monthTraffic) {
              setMachines((prev) =>
                prev.map((m) =>
                  m.id === ev.machineId
                    ? { ...m, monthTraffic: { month: ev.monthTraffic!.month, rxBytes: ev.monthTraffic!.rxBytes, txBytes: ev.monthTraffic!.txBytes } }
                    : m
                )
              );
            }
            setLatest((prev) => {
              const prevOne = prev[ev.machineId];
              const at = ev.metric.at;
              const rx = ev.metric.net?.rxBytes ?? 0;
              const tx = ev.metric.net?.txBytes ?? 0;
              const dt = prevOne ? (at - prevOne.at) / 1000 : 0;
              const rxBps = prevOne && dt > 0 ? Math.max(0, (rx - (prevOne.netRxBytes ?? 0)) / dt) : 0;
              const txBps = prevOne && dt > 0 ? Math.max(0, (tx - (prevOne.netTxBytes ?? 0)) / dt) : 0;
              return {
                ...prev,
                [ev.machineId]: {
                  at,
                  cpuUsage: ev.metric.cpu.usage,
                  memUsed: ev.metric.mem.used,
                  memTotal: ev.metric.mem.total,
                  diskUsed: ev.metric.disk.used,
                  diskTotal: ev.metric.disk.total,
                  netRxBytes: rx,
                  netTxBytes: tx,
                  rxBps,
                  txBps,
                  load1: ev.metric.load?.l1,
                },
              };
            });
            setMachines((prev) =>
              prev.map((m) => (m.id === ev.machineId ? { ...m, lastSeenAt: ev.metric.at, online: 1 } : m))
            );
          }
        },
        onClose: () => setWsOk(false),
        onError: () => setWsOk(false),
      });
      wsRef.current = ws;
      ws.onopen = () => ws.send(JSON.stringify({ type: "subscribe", machineIds }));
    } catch {
      setWsOk(false);
    }
  }

  const groups = useMemo(() => {
    const set = new Set<string>();
    let hasUngrouped = false;
    for (const m of machines) {
      const g = (m.groupName ?? "").trim();
      if (!g) hasUngrouped = true;
      else set.add(g);
    }
    return {
      named: Array.from(set).sort((a, b) => a.localeCompare(b, "zh-Hans-CN")),
      hasUngrouped,
    };
  }, [machines]);

  const rows = useMemo(() => {
    if (groupKey === "__all__") return machines;
    if (groupKey === "__ungrouped__") return machines.filter((m) => !(m.groupName ?? "").trim());
    return machines.filter((m) => (m.groupName ?? "").trim() === groupKey);
  }, [machines, groupKey]);

  const offlineCount = useMemo(() => rows.filter((m) => !m.online).length, [rows]);

  const rowsMode = useMemo(() => {
    if (sortMode !== "offline") return rows;
    return rows.filter((m) => !m.online);
  }, [rows, sortMode]);

  const rowsSorted = useMemo(() => {
    if (sortMode === "custom") return rowsMode;
    const next = rowsMode.slice();
    if (sortMode === "offline") {
      next.sort((a, b) => (a.lastSeenAt ?? 0) - (b.lastSeenAt ?? 0));
      return next;
    }
    next.sort((a, b) => {
      const da = daysLeft(a.expiresAt);
      const db = daysLeft(b.expiresAt);
      const aHas = da != null;
      const bHas = db != null;
      if (!aHas && !bHas) return 0;
      if (!aHas) return 1;
      if (!bHas) return -1;
      return da! - db!;
    });
    return next;
  }, [rowsMode, sortMode]);

  async function persistOrder(next: MachineSummary[]) {
    setOrderSaving(true);
    setOrderError(null);
    try {
      await apiFetch("/api/machines/order", {
        method: "PUT",
        body: JSON.stringify({ machineIds: next.map((m) => m.id) }),
      });
    } catch (e: any) {
      setOrderError(e?.message ?? "保存排序失败");
    } finally {
      setOrderSaving(false);
    }
  }

  function moveBefore(list: MachineSummary[], dragId: number, overId: number) {
    if (dragId === overId) return list;
    const from = list.findIndex((m) => m.id === dragId);
    const to = list.findIndex((m) => m.id === overId);
    if (from < 0 || to < 0) return list;
    const next = list.slice();
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    return next;
  }

  return (
    <div className="grid gap-4">
      {/* Header */}
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex-1">
          <div className="text-lg font-extrabold tracking-wide">总览</div>
          <div className="flex items-center gap-2 text-xs text-white/40">
            <span className={`inline-block h-1.5 w-1.5 rounded-full ${wsOk ? "bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.5)]" : "bg-white/20"}`} />
            WS：{wsOk ? "已连接" : "未连接/重连中"}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="text-xs text-white/40">排序</div>
          <select
            className="yaws-select text-sm"
            value={sortMode}
            onChange={(e) => setSortMode(e.target.value as SortMode)}
          >
            <option value="custom">自定义</option>
            <option value="expiry">到期剩余天数（升序）</option>
            <option value="offline">{offlineCount ? `仅离线（${offlineCount}）` : "仅离线"}</option>
          </select>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            className={`rounded-lg px-3 py-1.5 text-sm transition-all duration-200 ${
              viewMode === "cards"
                ? "border border-sky-400/30 bg-sky-400/12 text-white/90"
                : "border border-white/[0.06] bg-white/[0.03] text-white/50 hover:bg-white/[0.06] hover:text-white/70"
            }`}
            onClick={() => setViewMode("cards")}
          >
            卡片
          </button>
          <button
            className={`rounded-lg px-3 py-1.5 text-sm transition-all duration-200 ${
              viewMode === "list"
                ? "border border-sky-400/30 bg-sky-400/12 text-white/90"
                : "border border-white/[0.06] bg-white/[0.03] text-white/50 hover:bg-white/[0.06] hover:text-white/70"
            }`}
            onClick={() => setViewMode("list")}
          >
            列表
          </button>
        </div>
      </div>

      {orderError ? <div className="yaws-alert-error">{orderError}</div> : null}

      {/* Group filter tags */}
      <div className="flex flex-wrap items-center gap-2">
        <button
          className={`yaws-tag ${groupKey === "__all__" ? "yaws-tag-active" : ""}`}
          onClick={() => setGroupKey("__all__")}
        >
          全部
        </button>
        {groups.hasUngrouped ? (
          <button
            className={`yaws-tag ${groupKey === "__ungrouped__" ? "yaws-tag-active" : ""}`}
            onClick={() => setGroupKey("__ungrouped__")}
          >
            未分组
          </button>
        ) : null}
        {groups.named.map((g) => (
          <button
            key={g}
            className={`yaws-tag ${groupKey === g ? "yaws-tag-active" : ""}`}
            onClick={() => setGroupKey(g)}
            title={g}
          >
            {g}
          </button>
        ))}
      </div>

      {sortMode === "offline" && rowsSorted.length === 0 ? (
        <div className="yaws-card p-5 text-sm text-white/50">
          当前没有离线机器
        </div>
      ) : null}

      {viewMode === "cards" ? (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {rowsSorted.map((m) => {
            const lm = latest[m.id];
            const cpu = lm?.cpuUsage ?? null;
            const memP = lm ? pct(lm.memUsed, lm.memTotal) : null;
            const diskP = lm ? pct(lm.diskUsed, lm.diskTotal) : null;
            const left = daysLeft(m.expiresAt);
            const sshOk = !!(m.sshHost && m.sshUser && (m.sshAuthType === "key" ? m.sshHasKey : m.sshHasPassword));
            return (
              <Link
                className="yaws-card block p-4"
                key={m.id}
                to={`machines/${m.id}`}
              >
                <div className="mb-3 flex items-center gap-2">
                  <div className="flex-1 font-bold tracking-wide">{m.name}</div>
                  <button
                    className={`rounded-lg p-1.5 transition-all duration-200 ${
                      sshOk ? "border border-white/[0.08] bg-white/[0.04] text-white/60 hover:bg-white/[0.08] hover:text-white/80" : "text-white/20"
                    }`}
                    title={sshOk ? "WebSSH" : "未配置 SSH"}
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      if (!sshOk) return;
                      nav(`machines/${m.id}/ssh`);
                    }}
                  >
                    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className="h-4 w-4">
                      <path d="M4 6h16v12H4V6Z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
                      <path d="M7 10l3 2-3 2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                      <path d="M12 14h5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                    </svg>
                  </button>
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-white/[0.06] bg-white/[0.03] px-2.5 py-1 text-xs text-white/50">
                    <span className={m.online ? "yaws-dot-online" : "yaws-dot-offline"} />
                    {m.online ? "在线" : "离线"}
                  </span>
                </div>

                <div className="mb-3 text-xs text-white/30">Last seen: {fmtTime(m.lastSeenAt)}</div>

                <div className="grid gap-3">
                  <div>
                    <div className="mb-1.5 flex items-center gap-2 text-xs">
                      <div className="text-white/40">CPU</div>
                      <div className="flex-1" />
                      <div className="font-medium">{cpu == null ? "—" : `${Math.round(cpu * 100)}%`}</div>
                      <div className="text-white/30">{lm?.load1 != null ? `load ${lm.load1.toFixed(2)}` : ""}</div>
                    </div>
                    <div className="yaws-meter">
                      <div style={{ width: `${Math.round((cpu ?? 0) * 100)}%` }} />
                    </div>
                  </div>

                  <div>
                    <div className="mb-1.5 flex items-center gap-2 text-xs">
                      <div className="text-white/40">内存</div>
                      <div className="flex-1" />
                      <div className="text-white/80">
                        {lm ? `${formatBytes(lm.memUsed)} / ${formatBytes(lm.memTotal)}` : "—"}
                      </div>
                    </div>
                    <div className="yaws-meter">
                      <div style={{ width: `${Math.round((memP ?? 0) * 100)}%` }} />
                    </div>
                  </div>

                  <div>
                    <div className="mb-1.5 flex items-center gap-2 text-xs">
                      <div className="text-white/40">磁盘</div>
                      <div className="flex-1" />
                      <div className="text-white/80">
                        {lm ? `${formatBytes(lm.diskUsed)} / ${formatBytes(lm.diskTotal)}` : "—"}
                      </div>
                    </div>
                    <div className="yaws-meter">
                      <div style={{ width: `${Math.round((diskP ?? 0) * 100)}%` }} />
                    </div>
                  </div>

                  <div className="grid gap-1.5 text-xs">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="yaws-badge border-cyan-400/20 bg-cyan-500/8 text-cyan-300/80">
                        流量：{lm?.netRxBytes != null ? `RX ${formatBytes(lm.netRxBytes)}` : "RX —"} ·{" "}
                        {lm?.netTxBytes != null ? `TX ${formatBytes(lm.netTxBytes)}` : "TX —"}
                      </span>
                      <span className="yaws-badge border-teal-400/20 bg-teal-500/8 text-teal-300/80">
                        账期：RX {formatBytes(m.monthTraffic?.rxBytes ?? 0)} · TX {formatBytes(m.monthTraffic?.txBytes ?? 0)}
                      </span>
                      <span className="yaws-badge border-violet-400/20 bg-violet-500/8 text-violet-300/80">
                        速度：{lm ? `RX ${formatBps(lm.rxBps ?? 0)} / TX ${formatBps(lm.txBps ?? 0)}` : "—"}
                      </span>
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="yaws-badge border-amber-400/20 bg-amber-500/8 text-amber-300/80">
                        到期：{m.expiresAt ? new Date(m.expiresAt).toLocaleDateString() : "—"}
                        {left != null ? (
                          <span className={`ml-1 ${left <= 10 ? "text-rose-300" : "text-amber-200/80"}`}>（{left} 天）</span>
                        ) : (
                          ""
                        )}
                      </span>
                      <span className="yaws-badge border-emerald-400/20 bg-emerald-500/8 text-emerald-300/80">
                        {cycleLabel(m.billingCycle)} · {formatMoneyCents(m.purchaseAmountCents)}
                        {m.autoRenew ? " · 自动续费" : ""}
                      </span>
                    </div>
                  </div>
                </div>
              </Link>
            );
          })}

          {rows.length === 0 ? (
            <div className="yaws-card p-5">
              <div className="mb-1 font-bold">还没有机器</div>
              <div className="mb-4 text-sm text-white/40">先新增机器，下载探针配置文件到被控端运行。</div>
              <Link
                className="yaws-btn-primary inline-flex"
                to="machines/new"
              >
                新增机器
              </Link>
            </div>
          ) : null}
        </div>
      ) : (
        <div className="grid gap-2">
          <div className="text-xs text-white/30">
            {sortMode === "custom"
              ? `按住左侧拖拽图标调整顺序${orderSaving ? "（保存中...）" : ""}`
              : "当前为筛选/到期排序（不支持拖拽）"}
          </div>
          {rowsSorted.map((m) => {
            const lm = latest[m.id];
            const cpu = lm?.cpuUsage ?? null;
            const memP = lm ? pct(lm.memUsed, lm.memTotal) : null;
            const diskP = lm ? pct(lm.diskUsed, lm.diskTotal) : null;
            const left = daysLeft(m.expiresAt);
            const isExpanded = !!expanded[m.id];
            const expiryClass = left != null && left <= 10 ? "text-rose-300" : "text-white/50";
            const sshOk = !!(m.sshHost && m.sshUser && (m.sshAuthType === "key" ? m.sshHasKey : m.sshHasPassword));
            return (
              <div
                key={m.id}
                className={`yaws-card p-3 ${
                  dragOverId === m.id ? "!border-sky-400/30 ring-1 ring-sky-400/20" : ""
                } ${draggingId === m.id ? "opacity-50" : ""}`}
                onDragOver={(e) => {
                  if (sortMode !== "custom") return;
                  if (dragIdRef.current == null) return;
                  e.preventDefault();
                }}
                onDragEnter={() => {
                  if (sortMode !== "custom") return;
                  if (draggingId == null) return;
                  setDragOverId(m.id);
                }}
                onDragLeave={() => {
                  if (sortMode !== "custom") return;
                  if (dragOverId === m.id) setDragOverId(null);
                }}
                onDrop={async (e) => {
                  if (sortMode !== "custom") return;
                  e.preventDefault();
                  const dragId = dragIdRef.current;
                  dragIdRef.current = null;
                  setDraggingId(null);
                  setDragOverId(null);
                  if (dragId == null) return;
                  const next = moveBefore(machines, dragId, m.id);
                  setMachines(next);
                  await persistOrder(next);
                }}
                onClick={() => setExpanded((p) => ({ ...p, [m.id]: !p[m.id] }))}
              >
                <div className="flex flex-col gap-2 md:flex-row md:items-center">
                  <div className="flex items-center gap-2 md:w-[420px]">
                    <button
                      className={`rounded-md border border-white/[0.06] bg-white/[0.03] px-1.5 py-1 text-xs text-white/40 transition-colors ${
                        sortMode === "custom" ? "cursor-grab hover:bg-white/[0.06] hover:text-white/60 active:cursor-grabbing" : "cursor-not-allowed opacity-40"
                      }`}
                      draggable={sortMode === "custom"}
                      onClick={(e) => e.stopPropagation()}
                      onDragStart={(e) => {
                        if (sortMode !== "custom") return;
                        dragIdRef.current = m.id;
                        setDraggingId(m.id);
                        setDragOverId(null);
                        e.dataTransfer?.setData("text/plain", String(m.id));
                        e.dataTransfer?.setDragImage(new Image(), 0, 0);
                        e.dataTransfer!.effectAllowed = "move";
                      }}
                      onDragEnd={() => {
                        dragIdRef.current = null;
                        setDraggingId(null);
                        setDragOverId(null);
                      }}
                      title="拖拽排序"
                    >
                      ☰
                    </button>
                    <span
                      className={m.online ? "yaws-dot-online" : "yaws-dot-offline"}
                      title={m.online ? "在线" : "离线"}
                    />
                    <div className="flex-1 font-semibold">{m.name}</div>
                    <Link
                      className="yaws-btn !px-2 !py-1 !text-xs"
                      to={`machines/${m.id}`}
                      onClick={(e) => e.stopPropagation()}
                    >
                      详情
                    </Link>
                    <button
                      className={`rounded-lg border p-1.5 text-xs transition-all duration-200 ${
                        sshOk ? "border-white/[0.08] bg-white/[0.04] text-white/60 hover:bg-white/[0.08]" : "border-white/[0.04] bg-white/[0.02] text-white/20"
                      }`}
                      title={sshOk ? "WebSSH" : "未配置 SSH"}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (!sshOk) return;
                        nav(`machines/${m.id}/ssh`);
                      }}
                    >
                      <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className="h-4 w-4">
                        <path d="M4 6h16v12H4V6Z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
                        <path d="M7 10l3 2-3 2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                        <path d="M12 14h5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                      </svg>
                    </button>
                    <div className="rounded-md border border-white/[0.06] bg-white/[0.03] p-1.5 text-xs text-white/40">
                      <svg
                        className={`h-4 w-4 transition-transform duration-200 ${isExpanded ? "rotate-180" : ""}`}
                        viewBox="0 0 24 24"
                        fill="none"
                        xmlns="http://www.w3.org/2000/svg"
                        aria-hidden="true"
                      >
                        <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs md:flex md:flex-1 md:flex-wrap md:items-center md:justify-end">
                    <div className="text-white/50">
                      CPU：{cpu == null ? "—" : `${Math.round(cpu * 100)}%`}{" "}
                      {lm?.load1 != null ? `(${lm.load1.toFixed(2)})` : ""}
                    </div>
                    <div className="text-white/50">内存：{lm ? `${Math.round((memP ?? 0) * 100)}%` : "—"}</div>
                    <div className="text-white/50">磁盘：{lm ? `${Math.round((diskP ?? 0) * 100)}%` : "—"}</div>
                    <div className="text-violet-300/70">
                      网速：{lm ? `RX ${formatBps(lm.rxBps ?? 0)} / TX ${formatBps(lm.txBps ?? 0)}` : "—"}
                    </div>
                    <div className="text-amber-300/70">
                      到期：{m.expiresAt ? new Date(m.expiresAt).toLocaleDateString() : "—"}
                      {left != null ? <span className={`ml-1 ${expiryClass}`}>（{left}天）</span> : ""}
                    </div>
                  </div>
                </div>

                {isExpanded ? (
                  <div className="yaws-panel mt-2 grid gap-1.5 text-xs text-white/50">
                    <div>Last seen: {fmtTime(m.lastSeenAt)}</div>
                    <div className="text-cyan-300/70">
                      流量：{lm?.netRxBytes != null ? `RX ${formatBytes(lm.netRxBytes)}` : "RX —"} ·{" "}
                      {lm?.netTxBytes != null ? `TX ${formatBytes(lm.netTxBytes)}` : "TX —"}
                    </div>
                    <div className="text-teal-300/70">
                      账期：RX {formatBytes(m.monthTraffic?.rxBytes ?? 0)} · TX {formatBytes(m.monthTraffic?.txBytes ?? 0)}
                    </div>
                    <div className="text-emerald-300/70">
                      计费：{cycleLabel(m.billingCycle)} · {formatMoneyCents(m.purchaseAmountCents)}
                      {m.autoRenew ? " · 自动续费" : ""}
                    </div>
                    {m.notes ? <div className="whitespace-pre-wrap text-white/40">备注：{m.notes}</div> : null}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
