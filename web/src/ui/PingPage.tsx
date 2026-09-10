import { useEffect, useMemo, useState } from "react";
import { Pause, Play, Plus, Trash2, RefreshCw } from "lucide-react";
import { apiFetch, type Machine } from "./api";

type Monitor = {
  id: number;
  machineId: number | null;
  machineName: string | null;
  target: string;
  intervalSec: number;
  enabled: number;
  lastAt: number | null;
  latencyMs: number | null;
  error: string | null;
};
type Sample = {
  id: number;
  at: number;
  latencyMs: number | null;
  error: string | null;
};
const errors: Record<string, string> = {
  agent_offline: "被控端离线",
  agent_upgrade_required: "请升级被控端",
  agent_timeout: "被控端超时",
  ping_unavailable: "被控端未安装 ping",
  timeout_or_unreachable: "超时或不可达",
  machine_required: "需重新选择机器",
  monitor_exists: "该机器已监控此目标",
  bad_target: "目标 IP 或域名无效",
};
const message = (error: unknown) =>
  error instanceof Error
    ? (errors[error.message] ?? error.message)
    : "请求失败";

function Chart({ samples }: { samples: Sample[] }) {
  const w = 900,
    h = 280,
    p = 38;
  const max = Math.max(10, ...samples.map((s) => s.latencyMs ?? 0));
  const start = samples[0]?.at ?? 0,
    end = samples.at(-1)?.at ?? start + 1;
  let connected = false;
  const path = samples
    .map((s) => {
      if (s.latencyMs == null) {
        connected = false;
        return "";
      }
      const x = p + ((s.at - start) / Math.max(1, end - start)) * (w - 2 * p);
      const y = h - p - (s.latencyMs / max) * (h - 2 * p);
      const segment = `${connected ? "L" : "M"}${x},${y}`;
      connected = true;
      return segment;
    })
    .join(" ");
  return (
    <div className="latency-chart">
      <svg
        viewBox={`0 0 ${w} ${h}`}
        role="img"
        aria-label="被控端到目标的延迟折线图"
      >
        {[0, 0.5, 1].map((r) => (
          <g key={r}>
            <line
              x1={p}
              x2={w - p}
              y1={h - p - r * (h - 2 * p)}
              y2={h - p - r * (h - 2 * p)}
              stroke="#394047"
            />
            <text
              x="2"
              y={h - p - r * (h - 2 * p) + 4}
              fill="#a9b2bc"
              fontSize="12"
            >
              {(max * r).toFixed(0)}
            </text>
          </g>
        ))}
        <path d={path} fill="none" stroke="#38bdf8" strokeWidth="2" />
        {samples.map((s) => (
          <circle
            key={s.id}
            cx={p + ((s.at - start) / Math.max(1, end - start)) * (w - 2 * p)}
            cy={
              s.latencyMs == null
                ? h - p
                : h - p - (s.latencyMs / max) * (h - 2 * p)
            }
            r={s.latencyMs == null ? 3 : 2}
            fill={s.latencyMs == null ? "#fb7185" : "#38bdf8"}
          >
            <title>
              {new Date(s.at).toLocaleString()} |{" "}
              {s.latencyMs == null
                ? (errors[s.error ?? ""] ?? "丢包")
                : `${s.latencyMs} ms`}
            </title>
          </circle>
        ))}
        <text x={p} y={h - 8} fill="#a9b2bc" fontSize="12">
          {start ? new Date(start).toLocaleTimeString() : ""}
        </text>
        <text x={w - p} y={h - 8} textAnchor="end" fill="#a9b2bc" fontSize="12">
          {samples.length ? new Date(end).toLocaleTimeString() : ""}
        </text>
        <text x={p} y="18" fill="#a9b2bc" fontSize="12">
          ms
        </text>
      </svg>
    </div>
  );
}

export function PingPage() {
  const [machines, setMachines] = useState<Machine[]>([]);
  const [monitors, setMonitors] = useState<Monitor[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [machineId, setMachineId] = useState("");
  const [machineQuery, setMachineQuery] = useState("");
  const [target, setTarget] = useState("google.com");
  const [intervalSec, setIntervalSec] = useState(5);
  const [samples, setSamples] = useState<Sample[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const monitor = monitors.find((m) => m.id === selected);
  useEffect(() => {
    const ac = new AbortController();
    apiFetch<{ machines: Machine[] }>("/api/machines", { signal: ac.signal })
      .then((r) => setMachines(r.machines))
      .catch((e: unknown) => {
        if (!ac.signal.aborted) setError(message(e));
      });
    return () => ac.abort();
  }, []);
  useEffect(() => {
    const ac = new AbortController();
    let loading = false;
    const load = async () => {
      if (loading || document.hidden) return;
      loading = true;
      try {
        const r = await apiFetch<{ monitors: Monitor[] }>(
          "/api/ping/monitors",
          { signal: ac.signal },
        );
        if (ac.signal.aborted) return;
        setMonitors(r.monitors);
        setSelected((id) =>
          r.monitors.some((m) => m.id === id)
            ? id
            : (r.monitors[0]?.id ?? null),
        );
      } catch (e) {
        if (!ac.signal.aborted) setError(message(e));
      } finally {
        loading = false;
      }
    };
    void load();
    const timer = window.setInterval(load, 5000);
    document.addEventListener("visibilitychange", load);
    return () => {
      ac.abort();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", load);
    };
  }, [refresh]);
  useEffect(() => {
    setSamples([]);
    if (!selected) return;
    const ac = new AbortController();
    let loading = false;
    const load = async () => {
      if (loading || document.hidden) return;
      loading = true;
      try {
        const r = await apiFetch<{ samples: Sample[] }>(
          `/api/ping/monitors/${selected}/samples?limit=720`,
          { signal: ac.signal },
        );
        if (!ac.signal.aborted) setSamples(r.samples);
      } catch (e) {
        if (!ac.signal.aborted) setError(message(e));
      } finally {
        loading = false;
      }
    };
    void load();
    const timer = window.setInterval(load, 5000);
    document.addEventListener("visibilitychange", load);
    return () => {
      ac.abort();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", load);
    };
  }, [selected]);
  const stats = useMemo(() => {
    const values = samples.flatMap((s) =>
      s.latencyMs == null ? [] : [s.latencyMs],
    );
    const deltas = samples
      .slice(1)
      .flatMap((s, i) =>
        s.latencyMs != null && samples[i].latencyMs != null
          ? [Math.abs(s.latencyMs - samples[i].latencyMs!)]
          : [],
      );
    return {
      avg: values.length
        ? values.reduce((a, b) => a + b, 0) / values.length
        : null,
      max: values.length ? Math.max(...values) : null,
      jitter: deltas.length
        ? deltas.reduce((a, b) => a + b, 0) / deltas.length
        : null,
      loss: samples.length
        ? ((samples.length - values.length) / samples.length) * 100
        : null,
    };
  }, [samples]);
  async function mutate(path: string, method: string, body?: unknown) {
    setBusy(true);
    setError("");
    try {
      await apiFetch(path, {
        method,
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      setRefresh((v) => v + 1);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="monitor-page">
      <h1 className="text-xl font-bold mb-4">机器出口延迟</h1>
      <form
        className="monitor-form"
        onSubmit={(e) => {
          e.preventDefault();
          void mutate("/api/ping/monitors", "POST", {
            machineId: Number(machineId),
            target,
            intervalSec,
          });
        }}
      >
        <div className="grid gap-1.5">
          <label htmlFor="monitor-machine">来源机器</label>
          <input className="yaws-input" aria-label="按服务器 IP 筛选" placeholder="输入服务器 IP / 名称" value={machineQuery} onChange={(e) => {
            const value = e.target.value; setMachineQuery(value);
            const found = machines.filter((m) => m.sshHost === value.trim() || m.name === value.trim());
            if (found.length === 1) setMachineId(String(found[0].id));
          }} />
          <select
            id="monitor-machine"
            className="yaws-select w-full"
            required
            value={machineId}
            onChange={(e) => setMachineId(e.target.value)}
          >
            <option value="">选择机器 / IP</option>
            {machines.filter((m) => String(m.id) === machineId || `${m.name} ${m.sshHost ?? ""} ${m.hostname ?? ""}`.toLowerCase().includes(machineQuery.toLowerCase())).map((m) => (
              <option key={m.id} value={m.id}>
                {m.name} · {m.sshHost || m.hostname || `ID ${m.id}`}
              </option>
            ))}
          </select>
        </div>
        <label>
          目标 IP / 域名
          <input
            className="yaws-input"
            required
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            autoComplete="off"
          />
        </label>
        <label>
          间隔
          <select
            className="yaws-select w-full"
            value={intervalSec}
            onChange={(e) => setIntervalSec(Number(e.target.value))}
          >
            {[5, 10, 30, 60, 300].map((s) => (
              <option key={s} value={s}>
                {s} 秒
              </option>
            ))}
          </select>
        </label>
        <button
          className="yaws-btn-primary tool-text"
          disabled={busy || !machineId}
        >
          <Plus size={16} />
          添加监控
        </button>
      </form>
      {error && (
        <div role="alert" className="yaws-alert-error my-3">
          {error}
        </div>
      )}
      <div className="monitor-content">
        <aside className="monitor-list">
          {monitors.map((m) => (
            <button
              key={m.id}
              className={selected === m.id ? "selected" : ""}
              onClick={() => setSelected(m.id)}
            >
              <strong>{m.machineName ?? "旧监控：未绑定机器"}</strong>
              <span>{m.target}</span>
              <small>
                {!m.machineId
                  ? "请删除后重新添加"
                  : !m.enabled
                    ? "已暂停"
                    : m.error
                      ? (errors[m.error] ?? m.error)
                      : m.latencyMs == null
                        ? "等待采样"
                        : `${m.latencyMs.toFixed(1)} ms`}
              </small>
            </button>
          ))}
          {!monitors.length && <p className="text-white/40 p-4">暂无监控</p>}
        </aside>
        <section className="min-w-0">
          {monitor ? (
            <>
              <div className="workspace-toolbar">
                <h2 className="flex-1 min-w-0 break-all">
                  {monitor.machineName ?? "未绑定机器"} → {monitor.target}
                </h2>
                <button
                  className="icon-btn"
                  title={monitor.enabled ? "暂停" : "恢复"}
                  aria-label={monitor.enabled ? "暂停" : "恢复"}
                  disabled={busy || !monitor.machineId}
                  onClick={() =>
                    void mutate(`/api/ping/monitors/${monitor.id}`, "PATCH", {
                      enabled: !monitor.enabled,
                    })
                  }
                >
                  {monitor.enabled ? <Pause size={17} /> : <Play size={17} />}
                </button>
                <button
                  className="icon-btn"
                  title="删除监控"
                  aria-label="删除监控"
                  disabled={busy}
                  onClick={() => {
                    if (window.confirm("删除该监控及历史样本？"))
                      void mutate(`/api/ping/monitors/${monitor.id}`, "DELETE");
                  }}
                >
                  <Trash2 size={17} />
                </button>
                <button
                  className="icon-btn"
                  title="刷新"
                  aria-label="刷新"
                  onClick={() => setRefresh((v) => v + 1)}
                >
                  <RefreshCw size={17} />
                </button>
              </div>
              <div className="latency-stats">
                {[
                  ["当前", monitor.latencyMs],
                  ["平均", stats.avg],
                  ["峰值", stats.max],
                  ["抖动", stats.jitter],
                  ["丢包率", stats.loss],
                ].map(([label, value]) => (
                  <div key={label}>
                    <span>{label}</span>
                    <strong>
                      {typeof value === "number" ? value.toFixed(1) : "--"}{" "}
                      <small>{label === "丢包率" ? "%" : "ms"}</small>
                    </strong>
                  </div>
                ))}
              </div>
              <Chart samples={samples} />
              <div className="text-xs text-white/50 py-2">
                {samples.length} 个采样点 · 来源机器 ID{" "}
                {monitor.machineId ?? "--"} ·{" "}
                {monitor.error ? (errors[monitor.error] ?? monitor.error) : ""}
              </div>
            </>
          ) : (
            <div className="p-10 text-white/40">选择一个监控目标</div>
          )}
        </section>
      </div>
    </div>
  );
}
