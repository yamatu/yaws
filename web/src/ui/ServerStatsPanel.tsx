import { useCallback, useEffect, useRef, useState } from "react";
import { Cpu, HardDrive, RefreshCw } from "lucide-react";
import { apiFetch } from "./api";
import { formatBytes } from "./format";
import { formatUptime, usageLevel } from "./serverStats";
import { workspaceError } from "./workspaceErrors";

export type SystemStats = {
  at: number;
  hostname: string | null;
  kernel: string | null;
  uptimeSeconds: number | null;
  load: { one: number | null; five: number | null; fifteen: number | null };
  cpu: {
    cores: number;
    percent: number | null;
    source: "sample" | "boot" | null;
    userPercent: number | null;
    systemPercent: number | null;
    iowaitPercent: number | null;
    idlePercent: number | null;
  };
  memory: {
    totalKb: number;
    usedKb: number;
    availableKb: number;
    cachedKb: number;
    buffersKb: number;
    percent: number;
    swapTotalKb: number;
    swapUsedKb: number;
    swapPercent: number;
  } | null;
  disks: Array<{
    filesystem: string;
    mount: string;
    totalKb: number;
    usedKb: number;
    availKb: number;
    usePercent: number;
  }>;
  processes: Array<{
    pid: number;
    command: string;
    cpuPercent: number;
    memPercent: number;
    rssKb: number;
  }>;
  network: { rxBytes: number; txBytes: number } | null;
};

const REFRESH_MS = 15000;

function Bar({ percent }: { percent: number | null }) {
  const level = usageLevel(percent);
  return (
    <div className="stat-bar" role="presentation">
      <span
        className={`stat-bar-fill level-${level}`}
        style={{ width: `${Math.max(0, Math.min(100, percent ?? 0))}%` }}
      />
    </div>
  );
}

function Row({
  label,
  percent,
  detail,
  title,
}: {
  label: string;
  percent: number | null;
  detail: string;
  title?: string;
}) {
  return (
    <div className="stat-row" title={title}>
      <div className="stat-row-head">
        <span className="stat-label">{label}</span>
        <span className={`stat-value level-${usageLevel(percent)}`}>
          {percent === null ? "—" : `${Math.round(percent)}%`}
        </span>
      </div>
      <Bar percent={percent} />
      <div className="stat-detail">{detail}</div>
    </div>
  );
}

/**
 * Live CPU / memory / disk usage for the machine the terminal is connected to. The
 * backend runs one probe per `REFRESH_MS` per machine (see server/src/system-stats.ts),
 * on top of the SSH credentials of the workspace, so machines without an agent still
 * show real numbers.
 */
export function ServerStatsPanel({
  machineId,
  enabled,
}: {
  machineId: number;
  /** Fetching requires a trusted host key, otherwise the probe is refused. */
  enabled: boolean;
}) {
  const [stats, setStats] = useState<SystemStats | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [auto, setAuto] = useState(true);
  const timer = useRef<number | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setBusy(true);
      try {
        const res = await apiFetch<{ stats: SystemStats }>(
          `/api/machines/${machineId}/workspace/system`,
          { signal },
        );
        setStats(res.stats);
        setUpdatedAt(Date.now());
        setError("");
      } catch (e) {
        if (signal?.aborted) return;
        setError(workspaceError(e));
      } finally {
        if (!signal?.aborted) setBusy(false);
      }
    },
    [machineId],
  );

  useEffect(() => {
    if (!enabled) return;
    const ac = new AbortController();
    void load(ac.signal);
    return () => ac.abort();
  }, [enabled, load]);

  useEffect(() => {
    if (!enabled || !auto) return;
    // Pause while the tab is in the background; a probe costs an SSH connection.
    const tick = () => {
      if (!document.hidden) void load();
    };
    timer.current = window.setInterval(tick, REFRESH_MS);
    const onVisible = () => {
      if (!document.hidden) void load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      if (timer.current !== null) window.clearInterval(timer.current);
      timer.current = null;
    };
  }, [auto, enabled, load]);

  const cpu = stats?.cpu;
  const memory = stats?.memory;
  const loadDetail = stats
    ? `${[stats.load.one, stats.load.five, stats.load.fifteen]
        .map((v) => (v === null ? "—" : v.toFixed(2)))
        .join(" / ")}`
    : "—";

  return (
    <section className="stats-panel" aria-label="服务器占用情况">
      <div className="workspace-toolbar">
        <h2 className="flex-1 text-sm font-semibold">服务器占用</h2>
        <button
          className="icon-btn"
          title={auto ? "暂停自动刷新" : "每 15 秒自动刷新"}
          aria-label={auto ? "暂停自动刷新" : "每 15 秒自动刷新"}
          aria-pressed={auto}
          onClick={() => setAuto((v) => !v)}
        >
          <Cpu size={16} />
        </button>
        <button
          className="icon-btn"
          title="刷新占用情况"
          aria-label="刷新占用情况"
          disabled={busy || !enabled}
          onClick={() => void load()}
        >
          <RefreshCw size={16} className={busy ? "spin" : undefined} />
        </button>
      </div>
      {!enabled ? (
        <p className="stat-hint">确认主机指纹后可查看实时占用情况。</p>
      ) : error ? (
        <p className="stat-hint" role="alert">
          {error}
        </p>
      ) : !stats ? (
        <p className="stat-hint">{busy ? "正在读取…" : "暂无数据"}</p>
      ) : (
        <>
          <div className="stat-body">
            <Row
              label="CPU"
              percent={cpu?.percent ?? null}
              detail={
                cpu?.percent === null || !cpu
                  ? "读取失败"
                  : `${cpu.source === "boot" ? "开机以来平均" : "实时采样"}${
                      cpu.cores > 0 ? ` · ${cpu.cores} 核` : ""
                    }${
                      cpu.userPercent !== null
                        ? ` · 用户 ${Math.round(cpu.userPercent)}% / 系统 ${Math.round(cpu.systemPercent ?? 0)}%${
                            (cpu.iowaitPercent ?? 0) >= 1
                              ? ` / IO ${Math.round(cpu.iowaitPercent ?? 0)}%`
                              : ""
                          }`
                        : ""
                    }`
              }
            />
            <Row
              label="内存"
              percent={memory?.percent ?? null}
              detail={
                memory
                  ? `${formatBytes(memory.usedKb * 1024)} / ${formatBytes(memory.totalKb * 1024)}`
                  : "读取失败"
              }
              title={
                memory
                  ? `缓存 ${formatBytes(memory.cachedKb * 1024)} · 缓冲 ${formatBytes(memory.buffersKb * 1024)} · 可用 ${formatBytes(memory.availableKb * 1024)}`
                  : undefined
              }
            />
            {memory && memory.swapTotalKb > 0 ? (
              <Row
                label="Swap"
                percent={memory.swapPercent}
                detail={`${formatBytes(memory.swapUsedKb * 1024)} / ${formatBytes(memory.swapTotalKb * 1024)}`}
              />
            ) : null}
            <Row label="负载（1/5/15 分钟）" percent={null} detail={loadDetail} />
          </div>
          <div className="stat-section">
            <div className="stat-section-head">
              <HardDrive size={14} />
              <span>磁盘空间</span>
            </div>
            {stats.disks.length === 0 ? (
              <p className="stat-hint">未读取到磁盘信息。</p>
            ) : (
              stats.disks.map((disk) => (
                <div className="stat-row" key={`${disk.filesystem}:${disk.mount}`}>
                  <div className="stat-row-head">
                    <span className="stat-label mono-break" title={disk.mount}>
                      {disk.mount}
                    </span>
                    <span className={`stat-value level-${usageLevel(disk.usePercent)}`}>
                      {Math.round(disk.usePercent)}%
                    </span>
                  </div>
                  <Bar percent={disk.usePercent} />
                  <div className="stat-detail" title={disk.filesystem}>
                    已用 {formatBytes(disk.usedKb * 1024)} / {formatBytes(disk.totalKb * 1024)} · 可用{" "}
                    {formatBytes(disk.availKb * 1024)}
                  </div>
                </div>
              ))
            )}
          </div>
          {stats.processes.length > 0 && (
            <div className="stat-section">
              <div className="stat-section-head">
                <Cpu size={14} />
                <span>占用最高的进程</span>
              </div>
              <table className="stat-processes">
                <tbody>
                  {stats.processes.map((proc) => (
                    <tr key={proc.pid} title={`PID ${proc.pid} · 内存 ${formatBytes(proc.rssKb * 1024)}`}>
                      <td className="mono-break">{proc.command}</td>
                      <td className="text-right">{proc.cpuPercent.toFixed(1)}%</td>
                      <td className="text-right text-white/50">
                        {proc.memPercent.toFixed(1)}%
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="stat-footer">
            <span>{stats.hostname ?? "未知主机"}</span>
            {stats.network ? (
              <span>
                RX {formatBytes(stats.network.rxBytes)} · TX{" "}
                {formatBytes(stats.network.txBytes)}
              </span>
            ) : null}
            <span>
              运行 {formatUptime(stats.uptimeSeconds)} · 更新{" "}
              {updatedAt ? new Date(updatedAt).toLocaleTimeString() : "—"}
              {auto ? "" : "（已暂停）"}
            </span>
          </div>
        </>
      )}
    </section>
  );
}
