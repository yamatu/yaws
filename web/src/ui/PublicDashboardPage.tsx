import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { apiFetch, type PublicMachine } from "./api";
import { cycleLabel, daysLeft, fmtTime, formatBps, formatBytes, pct } from "./format";

type ViewMode = "cards" | "list";
type GroupKey = string; // "__all__" | "__ungrouped__" | groupName

export function PublicDashboardPage() {
  const [machines, setMachines] = useState<PublicMachine[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [speed, setSpeed] = useState<Record<number, { rxBps: number; txBps: number }>>({});
  const lastRef = useRef<Record<number, { at: number; rx: number; tx: number }>>({});
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    const v = localStorage.getItem("yaws_public_view_mode");
    return v === "list" || v === "cards" ? (v as ViewMode) : "list";
  });
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});
  const [groupKey, setGroupKey] = useState<GroupKey>(() => localStorage.getItem("yaws_public_group") || "__all__");

  useEffect(() => {
    let alive = true;
    const ac = new AbortController();
    async function load() {
      try {
        const res = await apiFetch<{ machines: PublicMachine[] }>("/api/public/summary", { signal: ac.signal });
        if (!alive) return;

        const nextSpeed: Record<number, { rxBps: number; txBps: number }> = {};
        const nextLast: Record<number, { at: number; rx: number; tx: number }> = { ...lastRef.current };
        for (const m of res.machines) {
          const lm = m.latestMetric;
          if (!lm) continue;
          const prev = lastRef.current[m.id];
          const cur = { at: lm.at, rx: lm.netRxBytes ?? 0, tx: lm.netTxBytes ?? 0 };
          nextLast[m.id] = cur;
          if (prev && cur.at > prev.at) {
            const dt = (cur.at - prev.at) / 1000;
            nextSpeed[m.id] = {
              rxBps: Math.max(0, (cur.rx - prev.rx) / dt),
              txBps: Math.max(0, (cur.tx - prev.tx) / dt),
            };
          } else {
            nextSpeed[m.id] = { rxBps: 0, txBps: 0 };
          }
        }
        lastRef.current = nextLast;
        setSpeed(nextSpeed);

        setMachines(res.machines);
        setError(null);
      } catch (e: any) {
        if (!alive) return;
        setError(e?.message ?? "加载失败");
      }
    }
    load();
    const t = setInterval(load, 5000);
    return () => {
      alive = false;
      ac.abort();
      clearInterval(t);
    };
  }, []);

  useEffect(() => {
    localStorage.setItem("yaws_public_view_mode", viewMode);
  }, [viewMode]);

  useEffect(() => {
    localStorage.setItem("yaws_public_group", groupKey);
  }, [groupKey]);

  const rows = useMemo(() => machines, [machines]);
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

  const rowsFiltered = useMemo(() => {
    if (groupKey === "__all__") return rows;
    if (groupKey === "__ungrouped__") return rows.filter((m) => !(m.groupName ?? "").trim());
    return rows.filter((m) => (m.groupName ?? "").trim() === groupKey);
  }, [rows, groupKey]);

  return (
    <div className="mx-auto max-w-6xl px-5 py-5">
      <div className="mb-6 flex items-center gap-3 rounded-2xl border border-white/[0.06] bg-white/[0.03] px-5 py-3.5 backdrop-blur-xl">
        <div className="flex-1">
          <div className="text-lg font-extrabold tracking-wider text-white/95">YAWS</div>
          <div className="text-xs text-white/40">公开状态页（无需登录）</div>
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
        <Link className="yaws-btn" to="/login">
          登录后台
        </Link>
      </div>

      {error ? <div className="mb-3 yaws-alert-error">{error}</div> : null}

      <div className="mb-4 flex flex-wrap items-center gap-2">
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

      {viewMode === "cards" ? (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {rowsFiltered.map((m) => {
            const lm = m.latestMetric;
            const cpu = lm ? lm.cpuUsage : null;
            const memP = lm ? pct(lm.memUsed, lm.memTotal) : null;
            const diskP = lm ? pct(lm.diskUsed, lm.diskTotal) : null;
            const sp = speed[m.id] ?? { rxBps: 0, txBps: 0 };
            const left = daysLeft(m.expiresAt);
            return (
              <Link
                to={`/m/${m.id}`}
                key={m.id}
                className="yaws-card block p-4"
              >
                <div className="mb-3 flex items-center gap-2">
                  <div className="flex-1 font-bold tracking-wide">{m.name}</div>
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
                      <div className="text-white/30">{lm ? `load ${lm.load1.toFixed(2)}` : ""}</div>
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
                        流量：{lm ? `RX ${formatBytes(lm.netRxBytes)} · TX ${formatBytes(lm.netTxBytes)}` : "—"}
                      </span>
                      <span className="yaws-badge border-teal-400/20 bg-teal-500/8 text-teal-300/80">
                        账期：RX {formatBytes(m.monthTraffic?.rxBytes ?? 0)} · TX {formatBytes(m.monthTraffic?.txBytes ?? 0)}
                      </span>
                      <span className="yaws-badge border-violet-400/20 bg-violet-500/8 text-violet-300/80">
                        速度：{lm ? `RX ${formatBps(sp.rxBps)} / TX ${formatBps(sp.txBps)}` : "—"}
                      </span>
                      <span className="yaws-badge border-sky-400/20 bg-sky-500/8 text-sky-300/80">
                        连接：{lm ? `TCP ${String(lm.tcpConn ?? 0)} · UDP ${String(lm.udpConn ?? 0)}` : "—"}
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
                        {cycleLabel(m.billingCycle)}
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
              <div className="font-bold">暂无机器</div>
              <div className="mt-1 text-sm text-white/40">登录后台后新增机器并运行探针。</div>
            </div>
          ) : null}
        </div>
      ) : (
        <div className="grid gap-2">
          {rowsFiltered.map((m) => {
            const lm = m.latestMetric;
            const cpu = lm ? lm.cpuUsage : null;
            const memP = lm ? pct(lm.memUsed, lm.memTotal) : null;
            const diskP = lm ? pct(lm.diskUsed, lm.diskTotal) : null;
            const sp = speed[m.id] ?? { rxBps: 0, txBps: 0 };
            const left = daysLeft(m.expiresAt);
            const isExpanded = !!expanded[m.id];
            return (
              <div
                key={m.id}
                className="yaws-card p-3"
                onClick={() => setExpanded((p) => ({ ...p, [m.id]: !p[m.id] }))}
              >
                <div className="flex flex-col gap-2 md:flex-row md:items-center">
                  <div className="flex items-center gap-2 md:w-[420px]">
                    <span className={m.online ? "yaws-dot-online" : "yaws-dot-offline"} />
                    <Link
                      className="flex-1 font-semibold hover:underline"
                      to={`/m/${m.id}`}
                      onClick={(e) => e.stopPropagation()}
                    >
                      {m.name}
                    </Link>
                    <Link
                      className="yaws-btn !px-2 !py-1 !text-xs"
                      to={`/m/${m.id}`}
                      onClick={(e) => e.stopPropagation()}
                    >
                      详情
                    </Link>
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
                    <div className="text-white/50">CPU：{cpu == null ? "—" : `${Math.round(cpu * 100)}%`}</div>
                    <div className="text-white/50">内存：{lm ? `${Math.round((memP ?? 0) * 100)}%` : "—"}</div>
                    <div className="text-white/50">磁盘：{lm ? `${Math.round((diskP ?? 0) * 100)}%` : "—"}</div>
                    <div className="text-violet-300/70">
                      <span>网速：{lm ? `RX ${formatBps(sp.rxBps)} / TX ${formatBps(sp.txBps)}` : "—"}</span>
                      <span className="ml-2 text-sky-300/70">
                        连接：{lm ? `TCP ${String(lm.tcpConn ?? 0)} · UDP ${String(lm.udpConn ?? 0)}` : "—"}
                      </span>
                    </div>
                    <div className="text-amber-300/70">
                      到期：{m.expiresAt ? new Date(m.expiresAt).toLocaleDateString() : "—"}
                      {left != null ? (
                        <span className={`ml-1 ${left <= 10 ? "text-rose-300" : "text-amber-200/80"}`}>（{left}天）</span>
                      ) : (
                        ""
                      )}
                    </div>
                  </div>
                </div>

                {isExpanded ? (
                  <div className="yaws-panel mt-2 grid gap-1.5 text-xs text-white/50">
                    <div>Last seen: {fmtTime(m.lastSeenAt)}</div>
                    <div>load: {lm ? `${lm.load1.toFixed(2)} / ${lm.load5.toFixed(2)} / ${lm.load15.toFixed(2)}` : "—"}</div>
                    <div className="text-cyan-300/70">
                      流量：{lm ? `RX ${formatBytes(lm.netRxBytes)} · TX ${formatBytes(lm.netTxBytes)}` : "—"}
                    </div>
                    <div className="text-teal-300/70">
                      账期：RX {formatBytes(m.monthTraffic?.rxBytes ?? 0)} · TX {formatBytes(m.monthTraffic?.txBytes ?? 0)}
                    </div>
                    <div className="text-emerald-300/70">
                      计费：{cycleLabel(m.billingCycle)}
                      {m.autoRenew ? " · 自动续费" : ""}
                    </div>
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
