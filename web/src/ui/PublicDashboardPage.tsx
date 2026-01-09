import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { apiFetch, type PublicMachine } from "./api";
import { fmtTime, formatBytes, pct } from "./format";

export function PublicDashboardPage() {
  const [machines, setMachines] = useState<PublicMachine[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const ac = new AbortController();
    async function load() {
      try {
        const res = await apiFetch<{ machines: PublicMachine[] }>("/api/public/summary", { signal: ac.signal });
        if (!alive) return;
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

  const rows = useMemo(() => machines, [machines]);

  return (
    <div className="mx-auto max-w-6xl px-5 py-5">
      <div className="mb-4 flex items-center gap-3">
        <div className="flex-1">
          <div className="font-extrabold tracking-wide">YAWS</div>
          <div className="text-xs text-white/60">公开状态页（无需登录）</div>
        </div>
        <Link className="rounded-xl border border-white/15 bg-white/10 px-3 py-2 text-sm hover:bg-white/15" to="/login">
          登录后台
        </Link>
      </div>

      {error ? (
        <div className="mb-3 rounded-2xl border border-rose-400/40 bg-rose-500/10 p-3 text-sm">{error}</div>
      ) : null}

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {rows.map((m) => {
          const lm = m.latestMetric;
          const cpu = lm ? lm.cpuUsage : null;
          const memP = lm ? pct(lm.memUsed, lm.memTotal) : null;
          const diskP = lm ? pct(lm.diskUsed, lm.diskTotal) : null;
          return (
            <div key={m.id} className="rounded-2xl border border-white/15 bg-white/10 p-4 backdrop-blur">
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
                    <div className="text-white/60">{lm ? `load ${lm.load1.toFixed(2)}` : ""}</div>
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

                <div className="text-xs text-white/70">
                  流量：{lm ? `RX ${formatBytes(lm.netRxBytes)} · TX ${formatBytes(lm.netTxBytes)}` : "—"}
                </div>
              </div>
            </div>
          );
        })}

        {rows.length === 0 ? (
          <div className="rounded-2xl border border-white/15 bg-white/10 p-4 backdrop-blur">
            <div className="font-extrabold">暂无机器</div>
            <div className="mt-1 text-sm text-white/60">登录后台后新增机器并运行探针。</div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
