import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { apiFetch, type Machine } from "./api";
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

export function DashboardPage() {
  const [machines, setMachines] = useState<Machine[]>([]);
  const [latest, setLatest] = useState<Record<number, LiveMetric>>({});
  const [wsOk, setWsOk] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    const v = localStorage.getItem("yaws_view_mode");
    return v === "list" || v === "cards" ? (v as ViewMode) : "cards";
  });
  const [orderSaving, setOrderSaving] = useState(false);
  const [orderError, setOrderError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});
  const dragIdRef = useRef<number | null>(null);

  useEffect(() => {
    let alive = true;
    const ac = new AbortController();
    (async () => {
      try {
        const res = await apiFetch<{ machines: Machine[] }>("/api/machines", { signal: ac.signal });
        if (!alive) return;
        setMachines(res.machines);
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

  const rows = useMemo(() => machines, [machines]);

  async function persistOrder(next: Machine[]) {
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

  function moveBefore(list: Machine[], dragId: number, overId: number) {
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
    <div className="grid gap-3">
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex-1">
          <div className="text-lg font-extrabold">总览</div>
          <div className="text-xs text-white/60">WS：{wsOk ? "已连接" : "未连接/重连中"}</div>
        </div>
        <div className="flex items-center gap-2">
          <button
            className={`rounded-xl border px-3 py-2 text-sm ${
              viewMode === "cards"
                ? "border-sky-400/40 bg-sky-400/15"
                : "border-white/15 bg-white/10 hover:bg-white/15"
            }`}
            onClick={() => setViewMode("cards")}
          >
            卡片
          </button>
          <button
            className={`rounded-xl border px-3 py-2 text-sm ${
              viewMode === "list"
                ? "border-sky-400/40 bg-sky-400/15"
                : "border-white/15 bg-white/10 hover:bg-white/15"
            }`}
            onClick={() => setViewMode("list")}
          >
            列表
          </button>
        </div>
      </div>

      {orderError ? (
        <div className="rounded-2xl border border-rose-400/40 bg-rose-500/10 p-3 text-sm">{orderError}</div>
      ) : null}

      {viewMode === "cards" ? (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {rows.map((m) => {
            const lm = latest[m.id];
            const cpu = lm?.cpuUsage ?? null;
            const memP = lm ? pct(lm.memUsed, lm.memTotal) : null;
            const diskP = lm ? pct(lm.diskUsed, lm.diskTotal) : null;
            const left = daysLeft(m.expiresAt);
            return (
              <Link
                className="block rounded-2xl border border-white/15 bg-white/10 p-4 backdrop-blur hover:bg-white/15"
                key={m.id}
                to={`machines/${m.id}`}
              >
                <div className="mb-2 flex items-center gap-2">
                  <div className="flex-1 font-extrabold">{m.name}</div>
                  <span className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/5 px-2 py-1 text-xs text-white/70">
                    <span className={`h-2 w-2 rounded-full ${m.online ? "bg-emerald-400" : "bg-white/25"}`} />
                    {m.online ? "在线" : "离线"}
                  </span>
                </div>

                <div className="mb-3 text-xs text-white/60">Last seen: {fmtTime(m.lastSeenAt)}</div>

                <div className="grid gap-3">
                  <div>
                    <div className="mb-1 flex items-center gap-2 text-xs">
                      <div className="text-white/60">CPU</div>
                      <div className="flex-1" />
                      <div>{cpu == null ? "—" : `${Math.round(cpu * 100)}%`}</div>
                      <div className="text-white/60">{lm?.load1 != null ? `load ${lm.load1.toFixed(2)}` : ""}</div>
                    </div>
                    <div className="h-2 overflow-hidden rounded-full border border-white/15 bg-white/5">
                      <div
                        className="h-full bg-gradient-to-r from-sky-400/90 to-emerald-400/90"
                        style={{ width: `${Math.round((cpu ?? 0) * 100)}%` }}
                      />
                    </div>
                  </div>

                  <div>
                    <div className="mb-1 flex items-center gap-2 text-xs">
                      <div className="text-white/60">内存</div>
                      <div className="flex-1" />
                      <div className="text-white/90">
                        {lm ? `${formatBytes(lm.memUsed)} / ${formatBytes(lm.memTotal)}` : "—"}
                      </div>
                    </div>
                    <div className="h-2 overflow-hidden rounded-full border border-white/15 bg-white/5">
                      <div
                        className="h-full bg-gradient-to-r from-sky-400/90 to-emerald-400/90"
                        style={{ width: `${Math.round((memP ?? 0) * 100)}%` }}
                      />
                    </div>
                  </div>

                  <div>
                    <div className="mb-1 flex items-center gap-2 text-xs">
                      <div className="text-white/60">磁盘</div>
                      <div className="flex-1" />
                      <div className="text-white/90">
                        {lm ? `${formatBytes(lm.diskUsed)} / ${formatBytes(lm.diskTotal)}` : "—"}
                      </div>
                    </div>
                    <div className="h-2 overflow-hidden rounded-full border border-white/15 bg-white/5">
                      <div
                        className="h-full bg-gradient-to-r from-sky-400/90 to-emerald-400/90"
                        style={{ width: `${Math.round((diskP ?? 0) * 100)}%` }}
                      />
                    </div>
                  </div>

                  <div className="grid gap-2 text-xs text-white/70">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="rounded-full border border-white/15 bg-white/5 px-2 py-1">
                        流量：{lm?.netRxBytes != null ? `RX ${formatBytes(lm.netRxBytes)}` : "RX —"} ·{" "}
                        {lm?.netTxBytes != null ? `TX ${formatBytes(lm.netTxBytes)}` : "TX —"}
                      </span>
                      <span className="rounded-full border border-white/15 bg-white/5 px-2 py-1">
                        速度：{lm ? `RX ${formatBps(lm.rxBps ?? 0)} / TX ${formatBps(lm.txBps ?? 0)}` : "—"}
                      </span>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="rounded-full border border-white/15 bg-white/5 px-2 py-1">
                        到期：{m.expiresAt ? new Date(m.expiresAt).toLocaleDateString() : "—"}
                        {left != null ? `（${left} 天）` : ""}
                      </span>
                      <span className="rounded-full border border-white/15 bg-white/5 px-2 py-1">
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
            <div className="rounded-2xl border border-white/15 bg-white/10 p-4 backdrop-blur">
              <div className="mb-1 font-extrabold">还没有机器</div>
              <div className="mb-3 text-sm text-white/60">先新增机器，下载探针配置文件到被控端运行。</div>
              <Link
                className="inline-flex rounded-xl border border-sky-400/40 bg-sky-400/15 px-3 py-2 text-sm font-semibold hover:bg-sky-400/20"
                to="machines/new"
              >
                新增机器
              </Link>
            </div>
          ) : null}
        </div>
      ) : (
        <div className="grid gap-2">
          <div className="text-xs text-white/60">
            提示：按住左侧拖拽图标调整顺序{orderSaving ? "（保存中...）" : ""}
          </div>
          {rows.map((m) => {
            const lm = latest[m.id];
            const cpu = lm?.cpuUsage ?? null;
            const memP = lm ? pct(lm.memUsed, lm.memTotal) : null;
            const diskP = lm ? pct(lm.diskUsed, lm.diskTotal) : null;
            const left = daysLeft(m.expiresAt);
            const isExpanded = !!expanded[m.id];
            return (
              <div
                key={m.id}
                className="rounded-2xl border border-white/15 bg-white/10 p-3 backdrop-blur hover:bg-white/15"
                onDragOver={(e) => {
                  if (dragIdRef.current == null) return;
                  e.preventDefault();
                }}
                onDrop={async (e) => {
                  e.preventDefault();
                  const dragId = dragIdRef.current;
                  dragIdRef.current = null;
                  if (dragId == null) return;
                  const next = moveBefore(machines, dragId, m.id);
                  setMachines(next);
                  await persistOrder(next);
                }}
              >
                <div className="flex flex-col gap-2 md:flex-row md:items-center">
                  <div className="flex items-center gap-2 md:w-[420px]">
                    <button
                      className="cursor-grab rounded-lg border border-white/15 bg-white/5 px-2 py-1 text-xs text-white/70 active:cursor-grabbing"
                      draggable
                      onDragStart={() => {
                        dragIdRef.current = m.id;
                      }}
                      onDragEnd={() => {
                        dragIdRef.current = null;
                      }}
                      title="拖拽排序"
                    >
                      ☰
                    </button>
                    <span
                      className={`h-2 w-2 rounded-full ${m.online ? "bg-emerald-400" : "bg-white/25"}`}
                      title={m.online ? "在线" : "离线"}
                    />
                    <Link className="flex-1 font-semibold hover:underline" to={`machines/${m.id}`}>
                      {m.name}
                    </Link>
                    <button
                      className="rounded-xl border border-white/15 bg-white/10 px-2 py-1 text-xs hover:bg-white/15"
                      onClick={() => setExpanded((p) => ({ ...p, [m.id]: !p[m.id] }))}
                    >
                      {isExpanded ? "收起" : "更多"}
                    </button>
                  </div>

                  <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs md:flex md:flex-1 md:flex-wrap md:items-center md:justify-end">
                    <div className="text-white/70">
                      CPU：{cpu == null ? "—" : `${Math.round(cpu * 100)}%`}{" "}
                      {lm?.load1 != null ? `(${lm.load1.toFixed(2)})` : ""}
                    </div>
                    <div className="text-white/70">内存：{lm ? `${Math.round((memP ?? 0) * 100)}%` : "—"}</div>
                    <div className="text-white/70">磁盘：{lm ? `${Math.round((diskP ?? 0) * 100)}%` : "—"}</div>
                    <div className="text-white/70">
                      网速：{lm ? `RX ${formatBps(lm.rxBps ?? 0)} / TX ${formatBps(lm.txBps ?? 0)}` : "—"}
                    </div>
                    <div className="text-white/70">
                      到期：{m.expiresAt ? new Date(m.expiresAt).toLocaleDateString() : "—"}
                      {left != null ? `（${left}天）` : ""}
                    </div>
                  </div>
                </div>

                {isExpanded ? (
                  <div className="mt-2 grid gap-2 rounded-2xl border border-white/10 bg-black/20 p-3 text-xs text-white/70">
                    <div>Last seen: {fmtTime(m.lastSeenAt)}</div>
                    <div>
                      流量：{lm?.netRxBytes != null ? `RX ${formatBytes(lm.netRxBytes)}` : "RX —"} ·{" "}
                      {lm?.netTxBytes != null ? `TX ${formatBytes(lm.netTxBytes)}` : "TX —"}
                    </div>
                    <div>
                      计费：{cycleLabel(m.billingCycle)} · {formatMoneyCents(m.purchaseAmountCents)}
                      {m.autoRenew ? " · 自动续费" : ""}
                    </div>
                    {m.notes ? <div className="whitespace-pre-wrap">备注：{m.notes}</div> : null}
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
