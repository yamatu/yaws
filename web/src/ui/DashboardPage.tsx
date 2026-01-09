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

export function DashboardPage() {
  const [machines, setMachines] = useState<Machine[]>([]);
  const [latest, setLatest] = useState<Record<number, LiveMetric>>({});
  const [wsOk, setWsOk] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    let alive = true;
    const ac = new AbortController();
    (async () => {
      try {
        const res = await apiFetch<{ machines: Machine[] }>("/api/machines", { signal: ac.signal });
        if (!alive) return;
        setMachines(res.machines);
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

  return (
    <div className="grid gap-3">
      <div className="flex items-end gap-3">
        <div className="flex-1">
          <div className="text-lg font-extrabold">总览</div>
          <div className="text-xs text-white/60">WS：{wsOk ? "已连接" : "未连接/重连中"}</div>
        </div>
      </div>

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
                    <div className="text-white/90">{lm ? `${formatBytes(lm.memUsed)} / ${formatBytes(lm.memTotal)}` : "—"}</div>
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

                <div className="flex flex-wrap items-center gap-2 text-xs text-white/70">
                  <span className="rounded-full border border-white/15 bg-white/5 px-2 py-1">
                    流量：{lm?.netRxBytes != null ? `RX ${formatBytes(lm.netRxBytes)}` : "RX —"} ·{" "}
                    {lm?.netTxBytes != null ? `TX ${formatBytes(lm.netTxBytes)}` : "TX —"} · 速度：
                    {lm ? ` RX ${formatBps(lm.rxBps ?? 0)} / TX ${formatBps(lm.txBps ?? 0)}` : " —"}
                  </span>
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
    </div>
  );
}
