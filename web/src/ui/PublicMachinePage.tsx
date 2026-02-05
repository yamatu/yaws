import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { apiFetch, type PublicMachineDetail, type UptimeSummary } from "./api";
import { daysLeft, fmtTime, formatBps, formatBytes, pct } from "./format";

export function PublicMachinePage() {
  const { id } = useParams();
  const machineId = Number(id);
  const [data, setData] = useState<PublicMachineDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const lastRef = useRef<{ at: number; rx: number; tx: number } | null>(null);
  const [rxBps, setRxBps] = useState(0);
  const [txBps, setTxBps] = useState(0);
  const [uptime, setUptime] = useState<UptimeSummary | null>(null);
  const [uptimeHours, setUptimeHours] = useState(24);

  useEffect(() => {
    if (!Number.isInteger(machineId) || machineId <= 0) return;
    let alive = true;
    const ac = new AbortController();
    async function load() {
      try {
        const res = await apiFetch<PublicMachineDetail>(`/api/public/machines/${machineId}`, { signal: ac.signal });
        if (!alive) return;
        setData(res);
        setError(null);

        try {
          const up = await apiFetch<UptimeSummary>(`/api/public/machines/${machineId}/uptime?hours=${uptimeHours}&bucketMin=5`, {
            signal: ac.signal,
          });
          if (!alive) return;
          setUptime(up);
        } catch {
          // ignore
        }
        const last = res.metrics.length ? res.metrics[res.metrics.length - 1] : null;
        if (last) {
          const prev = lastRef.current;
          const cur = { at: last.at, rx: last.netRxBytes, tx: last.netTxBytes };
          lastRef.current = cur;
          if (prev && cur.at > prev.at) {
            const dt = (cur.at - prev.at) / 1000;
            setRxBps(Math.max(0, (cur.rx - prev.rx) / dt));
            setTxBps(Math.max(0, (cur.tx - prev.tx) / dt));
          }
        }
      } catch (e: any) {
        if (!alive) return;
        setError(e?.message ?? "加载失败");
      }
    }
    load();
    const t = window.setInterval(load, 5000);
    return () => {
      alive = false;
      ac.abort();
      window.clearInterval(t);
    };
  }, [machineId, uptimeHours]);

  const m = data?.machine ?? null;
  const metrics = data?.metrics ?? [];
  const last = metrics.length ? metrics[metrics.length - 1] : null;

  const cpu = last ? last.cpuUsage : null;
  const memP = last ? pct(last.memUsed, last.memTotal) : null;
  const diskP = last ? pct(last.diskUsed, last.diskTotal) : null;
  const left = m ? daysLeft(m.expiresAt) : null;

  if (!Number.isInteger(machineId) || machineId <= 0) {
    return (
      <div className="mx-auto max-w-6xl px-5 py-5">
        <div className="rounded-2xl border border-white/15 bg-white/10 p-4 backdrop-blur">bad id</div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl px-5 py-5">
      <div className="mb-4 flex items-center gap-3">
        <div className="flex-1">
          <div className="font-extrabold tracking-wide">YAWS</div>
          <div className="text-xs text-white/60">公开状态页</div>
        </div>
        <Link className="rounded-xl border border-white/15 bg-white/10 px-3 py-2 text-sm hover:bg-white/15" to="/">
          返回
        </Link>
        <Link className="rounded-xl border border-white/15 bg-white/10 px-3 py-2 text-sm hover:bg-white/15" to="/login">
          登录后台
        </Link>
      </div>

      {error ? (
        <div className="mb-3 rounded-2xl border border-rose-400/40 bg-rose-500/10 p-3 text-sm">{error}</div>
      ) : null}

      {!m ? (
        <div className="rounded-2xl border border-white/15 bg-white/10 p-4 backdrop-blur">加载中...</div>
      ) : (
        <div className="grid gap-3">
          <div className="rounded-2xl border border-white/15 bg-white/10 p-4 backdrop-blur">
            <div className="mb-2 flex items-start gap-3">
              <div className="flex-1">
                <div className="text-lg font-extrabold">{m.name}</div>
                <div className="text-xs text-white/60">
                  ID: {m.id} · Last seen: {fmtTime(m.lastSeenAt)}
                </div>
              </div>
              <span className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/5 px-2 py-1 text-xs text-white/70">
                <span className={`h-2 w-2 rounded-full ${m.online ? "bg-emerald-400" : "bg-white/25"}`} />
                {m.online ? "在线" : "离线"}
              </span>
              <span className="rounded-full border border-amber-400/30 bg-amber-500/10 px-2 py-1 text-xs text-amber-200">
                到期：{m.expiresAt ? new Date(m.expiresAt).toLocaleDateString() : "—"}
                {left != null ? (
                  <span className={`ml-1 ${left <= 10 ? "text-rose-300" : "text-amber-100"}`}>（{left}天）</span>
                ) : (
                  ""
                )}
              </span>
              <span className="rounded-full border border-teal-400/30 bg-teal-500/10 px-2 py-1 text-xs text-teal-200">
                账期：RX {formatBytes(m.monthTraffic?.rxBytes ?? 0)} · TX {formatBytes(m.monthTraffic?.txBytes ?? 0)}
              </span>
            </div>

            {uptime ? (
              <div className="mt-3 rounded-2xl border border-white/10 bg-black/20 p-3">
                <div className="mb-2 flex items-center gap-2">
                  <div className="flex-1 text-sm font-semibold">在线率（SLA）</div>
                  <select
                    className="yaws-select text-xs"
                    value={uptimeHours}
                    onChange={(e) => setUptimeHours(Number(e.target.value))}
                  >
                    <option value={6}>近 6 小时</option>
                    <option value={12}>近 12 小时</option>
                    <option value={24}>近 24 小时</option>
                    <option value={72}>近 3 天</option>
                    <option value={168}>近 7 天</option>
                  </select>
                  <div className="text-xs text-white/60">{Math.round(uptime.upPct * 10000) / 100}%</div>
                </div>

                <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-white/60">
                  <span className="inline-flex items-center gap-1">
                    <span className="h-2 w-3 rounded-sm bg-emerald-400" />
                    在线
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <span className="h-2 w-3 rounded-sm bg-amber-400" />
                    可能掉线
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <span className="h-2 w-3 rounded-sm bg-rose-500" />
                    离线
                  </span>
                  <span className="ml-auto text-white/50">每格 {uptime.bucketMin} 分钟</span>
                </div>

                <div className="grid grid-cols-[repeat(auto-fit,minmax(10px,1fr))] gap-1">
                  {uptime.buckets.map((b) => (
                    <div
                      key={b.at}
                      title={`${new Date(b.at).toLocaleString()} · ${b.state === "up" ? "在线" : b.state === "warn" ? "可能掉线" : "离线"}`}
                      className={`h-3 rounded-sm border border-white/10 ${
                        b.state === "up" ? "bg-emerald-400" : b.state === "warn" ? "bg-amber-400" : "bg-rose-500"
                      }`}
                    />
                  ))}
                </div>

                <div className="mt-2 text-xs text-white/50">
                  统计口径：按探针上报间隔推断；当某段时间内没有新 metrics，则视为离线（阈值 {uptime.offlineAfterMin} 分钟）。
                </div>
              </div>
            ) : null}
          </div>

          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <div className="rounded-2xl border border-white/15 bg-white/10 p-4 backdrop-blur">
              <div className="mb-1 text-xs text-white/60">CPU</div>
              <div className="mb-2 flex items-end gap-2">
                <div className="text-3xl font-black">{cpu == null ? "—" : `${Math.round(cpu * 100)}%`}</div>
                <div className="flex-1" />
                <div className="text-xs text-white/60">{last ? new Date(last.at).toLocaleTimeString() : "—"}</div>
              </div>
              <div className="yaws-meter">
                <div style={{ width: `${Math.round((cpu ?? 0) * 100)}%` }} />
              </div>
              <div className="mt-2 text-xs text-white/60">
                load: {last ? `${last.load1.toFixed(2)} / ${last.load5.toFixed(2)} / ${last.load15.toFixed(2)}` : "—"}
              </div>
            </div>

            <div className="rounded-2xl border border-white/15 bg-white/10 p-4 backdrop-blur">
              <div className="mb-1 text-xs text-white/60">内存</div>
              <div className="mb-2 flex items-end gap-2">
                <div className="text-lg font-black">
                  {last ? `${formatBytes(last.memUsed)} / ${formatBytes(last.memTotal)}` : "—"}
                </div>
                <div className="flex-1" />
                <div className="text-xs">{last ? `${Math.round((memP ?? 0) * 100)}%` : "—"}</div>
              </div>
              <div className="yaws-meter">
                <div style={{ width: `${Math.round((memP ?? 0) * 100)}%` }} />
              </div>
            </div>

            <div className="rounded-2xl border border-white/15 bg-white/10 p-4 backdrop-blur">
              <div className="mb-1 text-xs text-white/60">磁盘（/）</div>
              <div className="mb-2 flex items-end gap-2">
                <div className="text-lg font-black">
                  {last ? `${formatBytes(last.diskUsed)} / ${formatBytes(last.diskTotal)}` : "—"}
                </div>
                <div className="flex-1" />
                <div className="text-xs">{last ? `${Math.round((diskP ?? 0) * 100)}%` : "—"}</div>
              </div>
              <div className="yaws-meter">
                <div style={{ width: `${Math.round((diskP ?? 0) * 100)}%` }} />
              </div>
            </div>

            <div className="rounded-2xl border border-white/15 bg-white/10 p-4 backdrop-blur">
              <div className="mb-1 text-xs text-white/60">网络</div>
              <div className="text-sm text-white/80">
                <span className="text-cyan-200/90">流量：RX {last ? formatBytes(last.netRxBytes) : "—"} · TX {last ? formatBytes(last.netTxBytes) : "—"}</span>
              </div>
              <div className="mt-1 text-sm text-white/80">
                <span className="text-violet-200/90">速度：RX {formatBps(rxBps)} · TX {formatBps(txBps)}</span>
                <span className="ml-2 text-sky-200/90">
                  连接：TCP {last ? String(last.tcpConn ?? 0) : "—"} · UDP {last ? String(last.udpConn ?? 0) : "—"}
                </span>
              </div>
              <div className="mt-2 text-xs text-white/50">按 5 秒刷新间隔计算速度。</div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
