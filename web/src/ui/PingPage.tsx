import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  Activity,
  ArrowRight,
  Check,
  ChevronDown,
  Clock3,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Search,
  Server,
  Trash2,
  X,
} from "lucide-react";
import { apiFetch } from "./api";
import { LatencyChart, latency, type LatencySeries } from "./LatencyChart";
import "./ping.css";

type Source = {
  id: number;
  name: string;
  groupName: string;
  hostname: string;
  address: string;
  lastSeenAt: number | null;
  capability: "ready" | "offline" | "upgrade_required";
};
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
const errors: Record<string, string> = {
  agent_offline: "被控端离线",
  agent_upgrade_required: "Agent 需升级至 v0.2.0 或更高版本",
  agent_timeout: "被控端响应超时",
  ping_unavailable: "被控端未安装 ping",
  timeout_or_unreachable: "目标超时或不可达",
  monitor_exists: "该机器已监控此目标",
  monitor_limit: "最多可创建 16 项监控",
  bad_target: "请输入有效的目标 IP 或域名",
  machine_not_found: "来源机器已被删除",
  bad_range: "无效的时间范围",
};
const message = (e: unknown) =>
  e instanceof Error ? (errors[e.message] ?? e.message) : "加载失败，请重试";
const stateName = (s: Source) =>
  s.capability === "ready"
    ? "可监控"
    : s.capability === "offline"
      ? "离线"
      : "需升级 Agent";
const ranges = [
  { min: 5, label: "5 分钟" },
  { min: 15, label: "15 分钟" },
  { min: 60, label: "1 小时" },
  { min: 360, label: "6 小时" },
  { min: 1440, label: "24 小时" },
];

export function PingPage() {
  const [params] = useSearchParams();
  const [machines, setMachines] = useState<Source[]>([]);
  const [machinesLoaded, setMachinesLoaded] = useState(false);
  const [machineError, setMachineError] = useState("");
  const [machineId, setMachineId] = useState<number | null>(
    () => Number(params.get("machineId")) || null,
  );
  const [machineQuery, setMachineQuery] = useState("");
  const [picker, setPicker] = useState(false);
  const [formOpen, setFormOpen] = useState(!!params.get("machineId"));
  const [target, setTarget] = useState("google.com");
  const [intervalSec, setIntervalSec] = useState(5);
  const [monitors, setMonitors] = useState<Monitor[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [monitorLoaded, setMonitorLoaded] = useState(false);
  const [series, setSeries] = useState<LatencySeries | null>(null);
  const [seriesLoading, setSeriesLoading] = useState(false);
  const [rangeMin, setRangeMin] = useState(15);
  const [error, setError] = useState("");
  const [chartError, setChartError] = useState("");
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const machine = machines.find((m) => m.id === machineId);
  const monitor = monitors.find((m) => m.id === selected);
  const source = machines.find((m) => m.id === monitor?.machineId);

  useEffect(() => {
    const ac = new AbortController();
    let loading = false;
    const load = async () => {
      if (loading || document.hidden) return;
      loading = true;
      try {
        const r = await apiFetch<{ machines: Source[] }>("/api/ping/machines", {
          signal: ac.signal,
        });
        if (ac.signal.aborted) return;
        setMachines(r.machines);
        setMachinesLoaded(true);
        setMachineError("");
        setMachineId(
          (id) =>
            id ??
            r.machines.find((m) => m.capability === "ready")?.id ??
            r.machines[0]?.id ??
            null,
        );
      } catch (e) {
        if (!ac.signal.aborted) {
          setMachineError(message(e));
          setMachinesLoaded(true);
        }
      } finally {
        loading = false;
      }
    };
    void load();
    const timer = window.setInterval(load, 10000);
    document.addEventListener("visibilitychange", load);
    return () => {
      ac.abort();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", load);
    };
  }, [refresh]);
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
        setMonitorLoaded(true);
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
    setSeries(null);
    setChartError("");
    if (!selected) return;
    const ac = new AbortController();
    let loading = false;
    const load = async () => {
      if (loading || document.hidden) return;
      loading = true;
      setSeriesLoading(true);
      try {
        const r = await apiFetch<LatencySeries>(
          `/api/ping/monitors/${selected}/series?rangeMin=${rangeMin}`,
          { signal: ac.signal },
        );
        if (!ac.signal.aborted) {
          setSeries(r);
          setChartError("");
        }
      } catch (e) {
        if (!ac.signal.aborted) setChartError(message(e));
      } finally {
        loading = false;
        if (!ac.signal.aborted) setSeriesLoading(false);
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
  }, [selected, rangeMin, refresh]);

  async function create() {
    if (!machine) return;
    setBusy(true);
    setError("");
    try {
      const r = await apiFetch<{ monitor: Monitor }>("/api/ping/monitors", {
        method: "POST",
        body: JSON.stringify({ machineId: machine.id, target, intervalSec }),
      });
      setMonitors((list) => [
        ...list,
        {
          ...r.monitor,
          machineName: machine.name,
          lastAt: null,
          latencyMs: null,
          error: null,
        },
      ]);
      setSelected(r.monitor.id);
      setFormOpen(false);
      setPicker(false);
      setRefresh((v) => v + 1);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  async function change(method: "PATCH" | "DELETE") {
    if (!monitor) return;
    if (method === "DELETE" && !window.confirm("删除此监控及历史样本？"))
      return;
    setBusy(true);
    setError("");
    try {
      await apiFetch(`/api/ping/monitors/${monitor.id}`, {
        method,
        ...(method === "PATCH"
          ? { body: JSON.stringify({ enabled: !monitor.enabled }) }
          : {}),
      });
      setRefresh((v) => v + 1);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  const visibleMachines = machines.filter((m) =>
    `${m.name} ${m.address} ${m.hostname} ${m.groupName} ${m.id}`
      .toLowerCase()
      .includes(machineQuery.trim().toLowerCase()),
  );
  const stats = series?.summary;
  const current =
    monitor?.enabled &&
    source?.capability === "ready" &&
    monitor.lastAt &&
    Date.now() - monitor.lastAt < Math.max(20000, monitor.intervalSec * 3000)
      ? monitor.latencyMs
      : null;
  return (
    <div className="eg-page">
      <header className="eg-page-header">
        <div>
          <span className="eg-eyebrow">NETWORK OBSERVABILITY</span>
          <h1>机器出口延迟</h1>
          <p>从已接入的服务器出发，持续观察到目标的网络质量。</p>
        </div>
        <button
          className="yaws-btn-primary tool-text"
          onClick={() => setFormOpen((v) => !v)}
        >
          <Plus size={16} />
          新建监控
        </button>
      </header>
      {(formOpen || (monitorLoaded && !monitors.length)) && (
        <form
          className="eg-create"
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          <div className="eg-form-title">
            <strong>选择已有服务器</strong>
            <span>使用服务器上已接入的 Agent，无需配置 SSH</span>
            {monitors.length > 0 && (
              <button
                type="button"
                className="icon-btn"
                aria-label="关闭新建监控"
                onClick={() => setFormOpen(false)}
              >
                <X size={16} />
              </button>
            )}
          </div>
          <div className="eg-form-grid">
            <div
              className="eg-source-field"
              onKeyDown={(e) => {
                if (e.key === "Escape") setPicker(false);
              }}
              onBlur={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget))
                  setPicker(false);
              }}
            >
              <label id="eg-source-label">来源机器</label>
              <button
                type="button"
                className="eg-source-trigger"
                aria-labelledby="eg-source-label"
                aria-expanded={picker}
                onClick={() => setPicker((v) => !v)}
              >
                <Server size={18} />
                <span>
                  {machine
                    ? machine.name
                    : machinesLoaded
                      ? "选择已有服务器"
                      : "加载服务器…"}
                  <small>
                    {machine
                      ? `${machine.address || machine.hostname || "未配置 SSH"} · ID ${machine.id}`
                      : ""}
                  </small>
                </span>
                <ChevronDown size={16} />
              </button>
              {picker && (
                <div className="eg-source-picker">
                  <div className="eg-search">
                    <Search size={15} />
                    <input
                      aria-label="搜索已有服务器"
                      autoFocus
                      value={machineQuery}
                      placeholder="搜索名称、IP、分组或 ID"
                      onChange={(e) => setMachineQuery(e.target.value)}
                    />
                  </div>
                  <div
                    className="eg-source-options"
                    role="listbox"
                    aria-label="已有服务器"
                  >
                    {visibleMachines.map((m) => (
                      <button
                        type="button"
                        role="option"
                        aria-selected={m.id === machineId}
                        key={m.id}
                        onClick={() => {
                          setMachineId(m.id);
                          setPicker(false);
                          setMachineQuery("");
                        }}
                      >
                        <span
                          className={`eg-dot ${m.capability === "ready" ? "good" : "warn"}`}
                        />
                        <span className="eg-source-name">
                          <strong>{m.name}</strong>
                          <small>
                            {m.address || m.hostname || `机器 ID ${m.id}`}
                            {m.groupName ? ` · ${m.groupName}` : ""}
                          </small>
                        </span>
                        <span className="eg-source-state">{stateName(m)}</span>
                        {m.id === machineId && <Check size={15} />}
                      </button>
                    ))}
                    {!visibleMachines.length && (
                      <p className="eg-picker-empty">
                        {machines.length
                          ? "没有匹配的服务器"
                          : "暂无已接入服务器"}
                      </p>
                    )}
                  </div>
                </div>
              )}
              {machine && (
                <span
                  className={`eg-source-hint ${machine.capability === "ready" ? "" : "warn"}`}
                >
                  {machine.capability === "ready"
                    ? "Agent 已连接，可以开始采样"
                    : machine.capability === "offline"
                      ? "服务器离线，创建后将在重新连接时开始采样"
                      : "请升级此机器的 Agent 至 v0.2.0 或更高版本"}
                </span>
              )}
              {machineError && (
                <div className="eg-inline-error" role="alert">
                  {machineError}
                  <button
                    type="button"
                    onClick={() => setRefresh((v) => v + 1)}
                  >
                    重试加载
                  </button>
                </div>
              )}
              {machinesLoaded && !machines.length && !machineError && (
                <Link to="/app/machines/new">添加服务器</Link>
              )}
            </div>
            <label>
              目标 IP / 域名
              <input
                required
                className="yaws-input"
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                autoComplete="off"
                placeholder="google.com 或 8.8.8.8"
              />
              <span className="eg-presets">
                {["google.com", "1.1.1.1", "8.8.8.8"].map((t) => (
                  <button key={t} type="button" onClick={() => setTarget(t)}>
                    {t}
                  </button>
                ))}
              </span>
            </label>
            <label>
              采样间隔
              <select
                className="yaws-select"
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
              className="yaws-btn-primary tool-text eg-start"
              disabled={busy || !machine || !!machineError}
            >
              {busy ? "创建中…" : "添加监控"}
              <ArrowRight size={15} />
            </button>
          </div>
        </form>
      )}
      {error && (
        <div role="alert" className="yaws-alert-error">
          {error}
        </div>
      )}
      {monitorLoaded && monitors.length > 0 && (
        <div className="eg-workbench">
          <aside className="eg-monitors">
            <div className="eg-side-title">
              监控目标 <span>{monitors.length}</span>
            </div>
            {monitors.map((m) => (
              <button
                key={m.id}
                className={m.id === selected ? "selected" : ""}
                onClick={() => setSelected(m.id)}
              >
                <span
                  className={`eg-dot ${m.enabled && !m.error && m.latencyMs != null ? "good" : "warn"}`}
                />
                <div>
                  <strong>{m.machineName ?? "旧监控：未绑定机器"}</strong>
                  <span>{m.target}</span>
                  <small>
                    {!m.machineId
                      ? "请重新选择机器创建"
                      : !m.enabled
                        ? "已暂停"
                        : m.error
                          ? (errors[m.error] ?? m.error)
                          : m.latencyMs == null
                            ? "等待采样"
                            : `${latency(m.latencyMs)} ms`}
                  </small>
                </div>
              </button>
            ))}
          </aside>
          <section className="eg-detail">
            {monitor && (
              <>
                <div className="eg-detail-header">
                  <div>
                    <span className="eg-eyebrow">出口链路</span>
                    <h2>
                      {monitor.machineName ?? "未绑定机器"}
                      <ArrowRight size={18} />
                      {monitor.target}
                    </h2>
                    <p>
                      <Clock3 size={13} />每 {monitor.intervalSec} 秒 ·{" "}
                      {monitor.enabled ? "持续采样" : "已暂停"}
                      {source ? ` · ${stateName(source)}` : ""}
                    </p>
                  </div>
                  <div className="eg-actions">
                    <button
                      className="icon-btn"
                      aria-label={monitor.enabled ? "暂停" : "恢复"}
                      title={monitor.enabled ? "暂停" : "恢复"}
                      disabled={busy || !monitor.machineId}
                      onClick={() => void change("PATCH")}
                    >
                      {monitor.enabled ? (
                        <Pause size={16} />
                      ) : (
                        <Play size={16} />
                      )}
                    </button>
                    <button
                      className="icon-btn"
                      aria-label="刷新"
                      title="刷新"
                      onClick={() => setRefresh((v) => v + 1)}
                    >
                      <RefreshCw
                        size={16}
                        className={seriesLoading ? "eg-spinning" : ""}
                      />
                    </button>
                    <button
                      className="icon-btn"
                      aria-label="删除监控"
                      title="删除监控"
                      disabled={busy}
                      onClick={() => void change("DELETE")}
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                </div>
                <div className="eg-stats latency-stats">
                  {[
                    { label: "当前延迟", value: current, unit: "ms" },
                    { label: "平均延迟", value: stats?.avgMs, unit: "ms" },
                    { label: "峰值延迟", value: stats?.maxMs, unit: "ms" },
                    { label: "延迟抖动", value: stats?.jitterMs, unit: "ms" },
                    { label: "丢包率", value: stats?.lossPct, unit: "%" },
                  ].map((s) => (
                    <div key={s.label}>
                      <span>{s.label}</span>
                      <strong>
                        {latency(s.value)}
                        <small>{s.unit}</small>
                      </strong>
                    </div>
                  ))}
                </div>
                <div className="eg-chart-card">
                  <div className="eg-chart-toolbar">
                    <h3>
                      <Activity size={16} />
                      延迟趋势
                    </h3>
                    <div className="eg-ranges" aria-label="时间范围">
                      {ranges.map((r) => (
                        <button
                          key={r.min}
                          aria-pressed={rangeMin === r.min}
                          onClick={() => setRangeMin(r.min)}
                        >
                          {r.label}
                        </button>
                      ))}
                    </div>
                  </div>
                  {chartError ? (
                    <div role="alert" className="eg-chart-empty">
                      <strong>{chartError}</strong>
                      <button
                        className="yaws-btn"
                        onClick={() => setRefresh((v) => v + 1)}
                      >
                        重新加载图表
                      </button>
                    </div>
                  ) : (
                    <LatencyChart series={series} loading={seriesLoading} />
                  )}
                  <div className="eg-chart-legend">
                    <span>
                      <i className="line" />
                      延迟均值 / 峰值区间
                    </span>
                    <span>
                      <i className="loss" />
                      丢包
                    </span>
                    <span>
                      <i className="missing" />
                      未探测
                    </span>
                    <span className="eg-legend-tail">
                      {stats?.count ?? 0} 个样本 ·{" "}
                      {series ? Math.round(series.bucketMs / 1000) : "—"} 秒 /
                      点
                    </span>
                  </div>
                </div>
                <footer className="eg-footer">
                  <span>
                    探测来源：
                    {source?.address ||
                      source?.hostname ||
                      `机器 ID ${monitor.machineId ?? "—"}`}
                  </span>
                  <span>
                    {stats?.unavailable
                      ? `${stats.unavailable} 次未探测，不计入丢包率 · `
                      : ""}
                    {series
                      ? `更新于 ${new Date(series.endAt).toLocaleTimeString()}`
                      : ""}
                  </span>
                </footer>
              </>
            )}
          </section>
        </div>
      )}
      {!monitorLoaded && <div className="eg-chart-empty">加载监控…</div>}
      {monitorLoaded && !monitors.length && (
        <div className="eg-welcome">
          <Activity size={30} />
          <strong>从一台已有服务器开始</strong>
          <span>选择来源机器和目标，创建后这里将展示实时网络质量。</span>
        </div>
      )}
    </div>
  );
}
