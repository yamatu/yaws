import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { apiFetch, apiFetchText, type Machine, type Metric, type UptimeSummary } from "./api";
import { connectUiWs } from "./ws";
import { cycleLabel, daysLeft, fmtTime, formatBps, formatBytes, formatMoneyCents, pct } from "./format";
import { getToken } from "./auth";

export function MachinePage() {
  const { id } = useParams();
  const machineId = Number(id);
  const nav = useNavigate();
  const loc = useLocation() as any;
  const [machine, setMachine] = useState<Machine | null>(null);
  const [metrics, setMetrics] = useState<Metric[]>([]);
  const [monthRows, setMonthRows] = useState<Array<{ month: string; rxBytes: number; txBytes: number; updatedAt: number }>>(
    []
  );
  const [setup, setSetup] = useState<{ wsUrl: string; agentKey: string | null; downloadConfigUrl: string } | null>(null);
  const [uptime, setUptime] = useState<UptimeSummary | null>(null);
  const [uptimeHours, setUptimeHours] = useState(24);
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState("");
  const [editGroupName, setEditGroupName] = useState("");
  const [editExpiresDate, setEditExpiresDate] = useState<string>("");
  const [editPurchaseAmount, setEditPurchaseAmount] = useState<number>(0);
  const [editBillingCycle, setEditBillingCycle] = useState<
    "month" | "quarter" | "half_year" | "year" | "two_year" | "three_year"
  >("month");
  const [editAutoRenew, setEditAutoRenew] = useState(false);
  const [editAgentWsUrl, setEditAgentWsUrl] = useState("");
  const [editSshHost, setEditSshHost] = useState("");
  const [editSshPort, setEditSshPort] = useState<number>(22);
  const [editSshUser, setEditSshUser] = useState("");
  const [editSshAuthType, setEditSshAuthType] = useState<"password" | "key">("password");
  const [editSshPassword, setEditSshPassword] = useState("");
  const [editSshPrivateKey, setEditSshPrivateKey] = useState("");
  const [clearSshPassword, setClearSshPassword] = useState(false);
  const [clearSshKey, setClearSshKey] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [installScript, setInstallScript] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (!Number.isInteger(machineId) || machineId <= 0) return;
    let alive = true;
    const ac = new AbortController();
    (async () => {
      try {
        const res = await apiFetch<{ machines: Machine[] }>("/api/machines", { signal: ac.signal });
        if (!alive) return;
        const m = res.machines.find((x) => x.id === machineId) ?? null;
        setMachine(m);
        if (m) {
          setEditName(m.name);
          setEditGroupName(m.groupName ?? "");
          setEditAgentWsUrl(m.agentWsUrl ?? "");
          setEditBillingCycle(m.billingCycle);
          setEditAutoRenew(!!m.autoRenew);
          setEditPurchaseAmount((m.purchaseAmountCents ?? 0) / 100);
          setEditExpiresDate(m.expiresAt ? new Date(m.expiresAt).toISOString().slice(0, 10) : "");

          setEditSshHost((m.sshHost ?? "").trim());
          setEditSshPort(Number(m.sshPort ?? 22));
          setEditSshUser((m.sshUser ?? "").trim());
          setEditSshAuthType((m.sshAuthType ?? "password") as any);
          setEditSshPassword("");
          setEditSshPrivateKey("");
          setClearSshPassword(false);
          setClearSshKey(false);
        }
        const ms = await apiFetch<{ metrics: Metric[] }>(`/api/machines/${machineId}/metrics?limit=300`, {
          signal: ac.signal,
        });
        if (!alive) return;
        setMetrics(ms.metrics);

        try {
          const up = await apiFetch<UptimeSummary>(`/api/machines/${machineId}/uptime?hours=${uptimeHours}&bucketMin=5`, {
            signal: ac.signal,
          });
          if (!alive) return;
          setUptime(up);
        } catch {
          // ignore
        }

        try {
          const tr = await apiFetch<{ rows: Array<{ month: string; rxBytes: number; txBytes: number; updatedAt: number }> }>(
            `/api/machines/${machineId}/traffic-monthly?limit=12`,
            { signal: ac.signal }
          );
          if (!alive) return;
          setMonthRows(tr.rows);
        } catch {
          // ignore
        }
        try {
          const s = await apiFetch<{
            machineId: number;
            wsUrl: string;
            agentKey: string | null;
            downloadConfigUrl: string;
          }>(`/api/machines/${machineId}/setup`, { signal: ac.signal });
          if (!alive) return;
          setSetup({ wsUrl: s.wsUrl, agentKey: s.agentKey, downloadConfigUrl: s.downloadConfigUrl });
        } catch {
          // ignore
        }

        try {
          wsRef.current?.close();
          const ws = connectUiWs({
            onEvent: (ev) => {
              if (ev.type === "machine_status" && ev.machineId === machineId) {
                setMachine((prev) =>
                  prev ? { ...prev, online: ev.online ? 1 : 0, lastSeenAt: ev.lastSeenAt } : prev
                );
              }
              if (ev.type === "metrics" && ev.machineId === machineId) {
                if (ev.monthTraffic) {
                  setMachine((prev) =>
                    prev
                      ? {
                          ...prev,
                          monthTraffic: { month: ev.monthTraffic!.month, rxBytes: ev.monthTraffic!.rxBytes, txBytes: ev.monthTraffic!.txBytes },
                        }
                      : prev
                  );
                  setMonthRows((prev) => {
                    const i = prev.findIndex((r) => r.month === ev.monthTraffic!.month);
                    const row = {
                      month: ev.monthTraffic!.month,
                      rxBytes: ev.monthTraffic!.rxBytes,
                      txBytes: ev.monthTraffic!.txBytes,
                      updatedAt: ev.monthTraffic!.updatedAt ?? Date.now(),
                    };
                    if (i >= 0) {
                      const next = prev.slice();
                      next[i] = row;
                      return next;
                    }
                    return [row, ...prev].slice(0, 12);
                  });
                }
                const m: Metric = {
                  at: ev.metric.at,
                  cpuUsage: ev.metric.cpu.usage,
                  memUsed: ev.metric.mem.used,
                  memTotal: ev.metric.mem.total,
                  diskUsed: ev.metric.disk.used,
                  diskTotal: ev.metric.disk.total,
                  netRxBytes: ev.metric.net?.rxBytes ?? 0,
                  netTxBytes: ev.metric.net?.txBytes ?? 0,
                  tcpConn: ev.metric.conn?.tcp ?? 0,
                  udpConn: ev.metric.conn?.udp ?? 0,
                  load1: ev.metric.load?.l1 ?? 0,
                  load5: ev.metric.load?.l5 ?? 0,
                  load15: ev.metric.load?.l15 ?? 0,
                };
                setMetrics((prev) => [...prev.slice(-299), m]);
                setMachine((prev) => (prev ? { ...prev, lastSeenAt: m.at, online: 1 } : prev));
              }
            },
            onClose: () => {},
          });
          wsRef.current = ws;
          ws.onopen = () => ws.send(JSON.stringify({ type: "subscribe", machineIds: [machineId] }));
        } catch {
          // ignore
        }
      } catch {
        // ignore
      }
    })();
    return () => {
      alive = false;
      ac.abort();
      wsRef.current?.close();
    };
  }, [machineId, uptimeHours]);

  const last = metrics.length ? metrics[metrics.length - 1] : null;
  const prev = metrics.length >= 2 ? metrics[metrics.length - 2] : null;
  const cpu = last ? last.cpuUsage : null;
  const memP = last ? pct(last.memUsed, last.memTotal) : null;
  const diskP = last ? pct(last.diskUsed, last.diskTotal) : null;
  const dt = last && prev ? (last.at - prev.at) / 1000 : 0;
  const rxBps = last && prev && dt > 0 ? Math.max(0, (last.netRxBytes - prev.netRxBytes) / dt) : 0;
  const txBps = last && prev && dt > 0 ? Math.max(0, (last.netTxBytes - prev.netTxBytes) / dt) : 0;

  const agentCmd = useMemo(() => {
    if (!setup?.wsUrl || !setup.agentKey) return `./yaws-agent -url ws://<主控IP>:3001/ws/agent -id ${machineId} -key <agentKey>`;
    return `./yaws-agent -url ${setup.wsUrl} -id ${machineId} -key ${setup.agentKey}`;
  }, [machineId, setup?.agentKey, setup?.wsUrl]);

  const configCmd = useMemo(() => {
    return `./yaws-agent -config yaws-agent-${machineId}.json`;
  }, [machineId]);

  const sysRows = useMemo(() => {
    if (!machine) return [];
    const os = (machine.osVersion ? `${machine.osName ?? ""} ${machine.osVersion}` : machine.osName ?? "").trim();
    return [
      ["主机名", (machine.hostname ?? "").trim() || "—"],
      ["系统", os || "—"],
      ["内核", (machine.kernelVersion ?? "").trim() || "—"],
      ["架构", (machine.arch ?? "").trim() || "—"],
      ["CPU 型号", (machine.cpuModel ?? "").trim() || "—"],
      ["核心数", machine.cpuCores ? String(machine.cpuCores) : "—"],
    ] as Array<[string, string]>;
  }, [machine]);

  if (!Number.isInteger(machineId) || machineId <= 0) {
    return <div className="rounded-2xl border border-white/15 bg-white/10 p-4 backdrop-blur">bad machine id</div>;
  }

  if (!machine) {
    return (
      <div className="rounded-2xl border border-white/15 bg-white/10 p-4 backdrop-blur">
        <div className="mb-2 font-extrabold">机器不存在</div>
        <Link className="inline-flex rounded-xl border border-white/15 bg-white/10 px-3 py-2 text-sm hover:bg-white/15" to="/app">
          返回
        </Link>
      </div>
    );
  }

  const left = daysLeft(machine.expiresAt);
  const sshOk = !!(
    (machine.sshHost ?? "").trim() &&
    (machine.sshUser ?? "").trim() &&
    ((machine.sshAuthType ?? "password") === "key" ? !!machine.sshHasKey : !!machine.sshHasPassword)
  );

  return (
    <div className="grid gap-3">
      <div className="rounded-2xl border border-white/15 bg-white/10 p-4 backdrop-blur">
        <div className="mb-2 flex items-start gap-3">
          <div className="flex-1">
            <div className="text-lg font-extrabold">{machine.name}</div>
            <div className="text-xs text-white/60">
              ID: {machine.id} · Last seen: {fmtTime(machine.lastSeenAt)}
            </div>
          </div>
          <span className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/5 px-2 py-1 text-xs text-white/70">
            <span className={`h-2 w-2 rounded-full ${machine.online ? "bg-emerald-400" : "bg-white/25"}`} />
            {machine.online ? "在线" : "离线"}
          </span>
          {sshOk ? (
            <Link
              className="rounded-xl border border-white/15 bg-white/10 px-3 py-2 text-sm hover:bg-white/15"
              to="ssh"
              title="WebSSH"
              aria-label="WebSSH"
            >
              <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className="h-5 w-5">
                <path d="M4 6h16v12H4V6Z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
                <path d="M7 10l3 2-3 2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M12 14h5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
            </Link>
          ) : (
            <button
              className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-white/40"
              title="未配置 SSH"
              aria-label="SSH 未配置"
              disabled
            >
              <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className="h-5 w-5">
                <path d="M4 6h16v12H4V6Z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
                <path d="M7 10l3 2-3 2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M12 14h5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
            </button>
          )}
          <button
            className="rounded-xl border border-white/15 bg-white/10 px-3 py-2 text-sm hover:bg-white/15"
            onClick={async () => {
              if (!confirm("确认删除该机器及其指标数据？")) return;
              await apiFetch(`/api/machines/${machine.id}`, { method: "DELETE" });
              nav("/app", { replace: true });
            }}
          >
            删除
          </button>
        </div>

        <div className="flex flex-wrap gap-2 text-xs text-white/70">
          <span className="rounded-full border border-amber-400/30 bg-amber-500/10 px-2 py-1 text-amber-200">
            到期：{machine.expiresAt ? new Date(machine.expiresAt).toLocaleDateString() : "—"}
            {left != null ? (
              <span className={`ml-1 ${left <= 10 ? "text-rose-300" : "text-amber-100"}`}>（{left} 天）</span>
            ) : (
              ""
            )}
          </span>
          <span className="rounded-full border border-emerald-400/30 bg-emerald-500/10 px-2 py-1 text-emerald-200">
            {cycleLabel(machine.billingCycle)} · {formatMoneyCents(machine.purchaseAmountCents)}
            {machine.autoRenew ? " · 自动续费" : ""}
          </span>
          <span className="rounded-full border border-teal-400/30 bg-teal-500/10 px-2 py-1 text-teal-200">
            账期流量：RX {formatBytes(machine.monthTraffic?.rxBytes ?? 0)} · TX {formatBytes(machine.monthTraffic?.txBytes ?? 0)}
          </span>
        </div>

        {machine.notes ? <div className="mt-3 whitespace-pre-wrap text-sm text-white/70">{machine.notes}</div> : null}

        <div className="mt-3 grid grid-cols-1 gap-2 text-sm md:grid-cols-2">
          {sysRows.map(([k, v]) => (
            <div
              key={k}
              className="flex items-center justify-between rounded-xl border border-white/10 bg-black/20 px-3 py-2"
            >
              <div className="text-white/60">{k}</div>
              <div className="ml-3 text-right text-white/90">{v}</div>
            </div>
          ))}
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

        {monthRows.length ? (
          <div className="mt-3 rounded-2xl border border-white/10 bg-black/20 p-3">
            <div className="mb-2 text-sm font-semibold">账期流量（按到期日重置）</div>
            <div className="grid grid-cols-1 gap-2 text-sm md:grid-cols-2">
              {monthRows.map((r) => (
                <div
                  key={r.month}
                  className="flex items-center justify-between rounded-xl border border-white/10 bg-white/5 px-3 py-2"
                >
                  <div className="text-white/60">{r.month}</div>
                  <div className="ml-3 text-right text-white/90">
                    RX {formatBytes(r.rxBytes)} · TX {formatBytes(r.txBytes)}
                  </div>
                </div>
              ))}
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
            <div className="h-full" style={{ width: `${Math.round((cpu ?? 0) * 100)}%` }} />
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
            <div className="h-full" style={{ width: `${Math.round((memP ?? 0) * 100)}%` }} />
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
            <div className="h-full" style={{ width: `${Math.round((diskP ?? 0) * 100)}%` }} />
          </div>
        </div>

        <div className="rounded-2xl border border-white/15 bg-white/10 p-4 backdrop-blur">
          <div className="mb-1 text-xs text-white/60">流量（累计）</div>
          <div className="text-sm text-white/80">
            <span className="text-cyan-200/90">RX: {last ? formatBytes(last.netRxBytes) : "—"}</span> ·{" "}
            <span className="text-cyan-200/90">TX: {last ? formatBytes(last.netTxBytes) : "—"}</span>
          </div>
          <div className="mt-1 text-sm text-white/80">
            <span className="text-violet-200/90">速度：RX {formatBps(rxBps)} · TX {formatBps(txBps)}</span>
          </div>
          <div className="mt-2 text-xs text-white/50">来自 `/proc/net/dev` 汇总（排除 lo）。</div>
        </div>

        <div className="rounded-2xl border border-white/15 bg-white/10 p-4 backdrop-blur">
          <div className="mb-1 text-xs text-white/60">连接数</div>
          <div className="text-sm text-white/80">
            <span className="text-sky-200/90">TCP: {last ? String(last.tcpConn ?? 0) : "—"}</span> ·{" "}
            <span className="text-amber-200/90">UDP: {last ? String(last.udpConn ?? 0) : "—"}</span>
          </div>
          <div className="mt-2 text-xs text-white/50">来自 `/proc/net/tcp*` + `/proc/net/udp*` 的条目数量。</div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <div className="rounded-2xl border border-white/15 bg-white/10 p-4 backdrop-blur">
          <div className="mb-2 flex items-center gap-2">
            <div className="flex-1 font-extrabold">探针配置</div>
            <button
              className="rounded-xl border border-white/15 bg-white/10 px-3 py-2 text-sm hover:bg-white/15"
              onClick={async () => {
                if (!setup?.downloadConfigUrl) return;
                const token = getToken();
                if (!token) return;
                const res = await fetch(setup.downloadConfigUrl, { headers: { authorization: `Bearer ${token}` } });
                if (!res.ok) return;
                const blob = await res.blob();
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url;
                a.download = `yaws-agent-${machineId}.json`;
                document.body.appendChild(a);
                a.click();
                a.remove();
                URL.revokeObjectURL(url);
              }}
            >
              下载 config
            </button>
            <button
              className="rounded-xl border border-white/15 bg-white/10 px-3 py-2 text-sm hover:bg-white/15"
              onClick={async () => {
                if (!confirm("重置 agentKey 会导致旧探针断连，继续？")) return;
                const r = await apiFetch<{ ok: true; agentKey: string }>(`/api/machines/${machineId}/reset-key`, {
                  method: "POST",
                });
                setSetup((prev) => (prev ? { ...prev, agentKey: r.agentKey } : prev));
                setInstallScript(null);
              }}
            >
              重置 key
            </button>
            <button
              className="rounded-xl border border-white/15 bg-white/10 px-3 py-2 text-sm hover:bg-white/15"
              onClick={async () => {
                try {
                  const s = await apiFetchText(`/api/machines/${machineId}/install-script`);
                  setInstallScript(s);
                } catch (e: any) {
                  alert(`生成脚本失败：${e?.message ?? "unknown"}`);
                }
              }}
            >
              生成一键安装脚本
            </button>
          </div>

          {setup?.agentKey ? (
            <div className="grid gap-2">
              <div className="text-xs text-white/60">推荐：下载配置文件后直接运行（无需复制 agentKey）</div>
              <pre className="overflow-auto rounded-2xl border border-white/10 bg-black/25 p-3 text-xs">
                <code>{configCmd}</code>
              </pre>
              <div className="text-xs text-white/60">或直接命令行（已自动填充 agentKey）</div>
              <pre className="overflow-auto rounded-2xl border border-white/10 bg-black/25 p-3 text-xs">
                <code>{agentCmd}</code>
              </pre>

              {installScript ? (
                <div className="grid gap-2">
                  <div className="flex items-center gap-2">
                    <div className="flex-1 text-xs text-white/60">复制到被控端 root 执行（会从 GitHub Releases 下载对应架构）</div>
                    <button
                      className="rounded-xl border border-white/15 bg-white/10 px-3 py-2 text-xs hover:bg-white/15"
                      onClick={async () => {
                        await navigator.clipboard.writeText(installScript);
                        alert("已复制");
                      }}
                    >
                      复制脚本
                    </button>
                  </div>
                  <pre className="overflow-auto rounded-2xl border border-white/10 bg-black/25 p-3 text-xs">
                    <code>{installScript}</code>
                  </pre>
                </div>
              ) : null}
            </div>
          ) : (
            <div className="text-sm text-white/70">
              当前机器没有可导出的 agentKey（可能是旧数据）。点击“重置 key”生成新的。
            </div>
          )}
        </div>

        <div className="rounded-2xl border border-white/15 bg-white/10 p-4 backdrop-blur">
          <div className="mb-2 flex items-center gap-2">
            <div className="flex-1 font-extrabold">到期/续费（站内展示）</div>
            <button
              className="rounded-xl border border-white/15 bg-white/10 px-3 py-2 text-sm hover:bg-white/15"
              onClick={() => {
                setEditing((v) => !v);
                setSaveError(null);
              }}
            >
              {editing ? "关闭编辑" : "编辑"}
            </button>
            <button
              className="rounded-xl border border-sky-400/40 bg-sky-400/15 px-3 py-2 text-sm font-semibold hover:bg-sky-400/20"
              onClick={async () => {
                const r = await apiFetch<{ ok: true; expiresAt: number }>(`/api/machines/${machineId}/renew`, {
                  method: "POST",
                  body: JSON.stringify({ cycle: machine.billingCycle, count: 1 }),
                });
                setMachine((prev) => (prev ? { ...prev, expiresAt: r.expiresAt } : prev));
                setEditExpiresDate(new Date(r.expiresAt).toISOString().slice(0, 10));
              }}
            >
              按周期续费 1 次
            </button>
          </div>

          {saveError ? (
            <div className="mb-2 rounded-2xl border border-rose-400/40 bg-rose-500/10 p-3 text-sm">{saveError}</div>
          ) : null}

          {!editing ? (
            <div className="grid gap-2 text-sm text-white/80">
              <div>到期：{machine.expiresAt ? new Date(machine.expiresAt).toLocaleString() : "—"} {left != null ? `（${left} 天）` : ""}</div>
              <div>购买金额：{formatMoneyCents(machine.purchaseAmountCents)}</div>
              <div>计费周期：{cycleLabel(machine.billingCycle)}</div>
              <div>自动续费：{machine.autoRenew ? "开启" : "关闭"}</div>
              <div>
                SSH：
                {(machine.sshHost ?? "").trim() && (machine.sshUser ?? "").trim()
                  ? `${machine.sshUser}@${machine.sshHost}:${machine.sshPort ?? 22} · ${(machine.sshAuthType ?? "password") === "key" ? "Key" : "Password"}`
                  : "未配置"}
                {sshOk ? (
                  <Link className="ml-2 text-sky-200/90 hover:underline" to="ssh">
                    打开 WebSSH
                  </Link>
                ) : null}
              </div>
            </div>
          ) : (
            <div className="grid gap-3">
              <div>
                <div className="mb-1 text-xs text-white/60">名称</div>
                <input
                  className="w-full rounded-xl border border-white/15 bg-white/10 px-3 py-2 outline-none focus:border-white/30"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                />
              </div>
              <div>
                <div className="mb-1 text-xs text-white/60">分组（可选）</div>
                <input
                  className="w-full rounded-xl border border-white/15 bg-white/10 px-3 py-2 outline-none focus:border-white/30"
                  value={editGroupName}
                  onChange={(e) => setEditGroupName(e.target.value)}
                  placeholder="例如：香港 / 东京 / AWS"
                />
              </div>
              <div>
                <div className="mb-1 text-xs text-white/60">探针连接地址</div>
                <input
                  className="w-full rounded-xl border border-white/15 bg-white/10 px-3 py-2 outline-none focus:border-white/30"
                  value={editAgentWsUrl}
                  onChange={(e) => setEditAgentWsUrl(e.target.value)}
                />
              </div>

              <div className="rounded-2xl border border-white/10 bg-black/20 p-3">
                <div className="mb-2 text-sm font-semibold">SSH（Web）</div>
                <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                  <div>
                    <div className="mb-1 text-xs text-white/60">Host</div>
                    <input
                      className="w-full rounded-xl border border-white/15 bg-white/10 px-3 py-2 outline-none focus:border-white/30"
                      value={editSshHost}
                      onChange={(e) => setEditSshHost(e.target.value)}
                      placeholder="例如：1.2.3.4 或 example.com"
                    />
                  </div>
                  <div>
                    <div className="mb-1 text-xs text-white/60">Port</div>
                    <input
                      className="w-full rounded-xl border border-white/15 bg-white/10 px-3 py-2 outline-none focus:border-white/30"
                      type="number"
                      min={1}
                      max={65535}
                      value={editSshPort}
                      onChange={(e) => setEditSshPort(Number(e.target.value))}
                    />
                  </div>
                  <div>
                    <div className="mb-1 text-xs text-white/60">用户名</div>
                    <input
                      className="w-full rounded-xl border border-white/15 bg-white/10 px-3 py-2 outline-none focus:border-white/30"
                      value={editSshUser}
                      onChange={(e) => setEditSshUser(e.target.value)}
                      placeholder="例如：root"
                    />
                  </div>
                  <div>
                    <div className="mb-1 text-xs text-white/60">认证方式</div>
                    <select
                      className="yaws-select w-full text-sm"
                      value={editSshAuthType}
                      onChange={(e) => setEditSshAuthType(e.target.value as any)}
                    >
                      <option value="password">密码</option>
                      <option value="key">私钥</option>
                    </select>
                  </div>
                </div>

                {editSshAuthType === "password" ? (
                  <div className="mt-3">
                    <div className="mb-1 flex items-center gap-2 text-xs text-white/60">
                      <div className="flex-1">密码（不会回显，留空表示不修改）</div>
                      <div className="text-white/50">{machine.sshHasPassword ? "已设置" : "未设置"}</div>
                    </div>
                    <input
                      className="w-full rounded-xl border border-white/15 bg-white/10 px-3 py-2 outline-none focus:border-white/30"
                      type="password"
                      value={editSshPassword}
                      onChange={(e) => {
                        setEditSshPassword(e.target.value);
                        setClearSshPassword(false);
                      }}
                      placeholder={machine.sshHasPassword ? "********" : "请输入密码"}
                    />
                    <label className="mt-2 flex items-center gap-2 text-xs text-white/70">
                      <input
                        type="checkbox"
                        checked={clearSshPassword}
                        onChange={(e) => {
                          setClearSshPassword(e.target.checked);
                          if (e.target.checked) setEditSshPassword("");
                        }}
                      />
                      清空已保存的密码
                    </label>
                  </div>
                ) : (
                  <div className="mt-3">
                    <div className="mb-1 flex items-center gap-2 text-xs text-white/60">
                      <div className="flex-1">私钥（PEM，留空表示不修改）</div>
                      <div className="text-white/50">{machine.sshHasKey ? "已设置" : "未设置"}</div>
                    </div>
                    <textarea
                      className="w-full rounded-xl border border-white/15 bg-white/10 px-3 py-2 font-mono text-xs outline-none focus:border-white/30"
                      style={{ minHeight: 120, resize: "vertical" }}
                      value={editSshPrivateKey}
                      onChange={(e) => {
                        setEditSshPrivateKey(e.target.value);
                        setClearSshKey(false);
                      }}
                      placeholder={machine.sshHasKey ? "(已保存，粘贴新私钥以更新)" : "粘贴私钥内容"}
                    />
                    <label className="mt-2 flex items-center gap-2 text-xs text-white/70">
                      <input
                        type="checkbox"
                        checked={clearSshKey}
                        onChange={(e) => {
                          setClearSshKey(e.target.checked);
                          if (e.target.checked) setEditSshPrivateKey("");
                        }}
                      />
                      清空已保存的私钥
                    </label>
                  </div>
                )}

                <div className="mt-2 text-xs text-white/50">提示：SSH 连接由主控发起，请确保主控能访问该 Host:Port。</div>
              </div>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <div>
                  <div className="mb-1 text-xs text-white/60">到期日期</div>
                  <input
                    className="w-full rounded-xl border border-white/15 bg-white/10 px-3 py-2 outline-none focus:border-white/30"
                    type="date"
                    value={editExpiresDate}
                    onChange={(e) => setEditExpiresDate(e.target.value)}
                  />
                </div>
                <div>
                  <div className="mb-1 text-xs text-white/60">购买金额（元）</div>
                  <input
                    className="w-full rounded-xl border border-white/15 bg-white/10 px-3 py-2 outline-none focus:border-white/30"
                    type="number"
                    min={0}
                    step={0.01}
                    value={editPurchaseAmount}
                    onChange={(e) => setEditPurchaseAmount(Number(e.target.value))}
                  />
                </div>
                <div>
                  <div className="mb-1 text-xs text-white/60">计费周期</div>
                  <select
                    className="yaws-select w-full text-sm"
                    value={editBillingCycle}
                    onChange={(e) => setEditBillingCycle(e.target.value as any)}
                  >
                    <option value="month">月付</option>
                    <option value="quarter">季付</option>
                    <option value="half_year">半年付</option>
                    <option value="year">年付</option>
                    <option value="two_year">两年付</option>
                    <option value="three_year">三年付</option>
                  </select>
                </div>
                <div className="flex items-end">
                  <label className="flex items-center gap-2 text-sm text-white/80">
                    <input type="checkbox" checked={editAutoRenew} onChange={(e) => setEditAutoRenew(e.target.checked)} />
                    自动续费（仅站内展示）
                  </label>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <div className="flex-1" />
                <button
                  className="rounded-xl border border-sky-400/40 bg-sky-400/15 px-3 py-2 text-sm font-semibold hover:bg-sky-400/20"
                  onClick={async () => {
                    setSaveError(null);
                    try {
                      const expiresAt = editExpiresDate ? new Date(`${editExpiresDate}T00:00:00`).getTime() : null;
                      await apiFetch(`/api/machines/${machineId}`, {
                        method: "PUT",
                        body: JSON.stringify({
                          name: editName,
                          groupName: editGroupName,
                          agentWsUrl: editAgentWsUrl,
                          sshHost: editSshHost,
                          sshPort: editSshPort,
                          sshUser: editSshUser,
                          sshAuthType: editSshAuthType,
                          ...(clearSshPassword ? { sshPassword: "" } : editSshPassword ? { sshPassword: editSshPassword } : {}),
                          ...(clearSshKey ? { sshPrivateKey: "" } : editSshPrivateKey ? { sshPrivateKey: editSshPrivateKey } : {}),
                          expiresAt,
                          purchaseAmount: editPurchaseAmount,
                          billingCycle: editBillingCycle,
                          autoRenew: editAutoRenew,
                        }),
                      });
                      setMachine((prev) =>
                        prev
                          ? {
                              ...prev,
                              name: editName,
                              groupName: editGroupName,
                              agentWsUrl: editAgentWsUrl,
                              sshHost: editSshHost,
                              sshPort: editSshPort,
                              sshUser: editSshUser,
                              sshAuthType: editSshAuthType,
                              sshHasPassword: clearSshPassword ? false : editSshPassword ? true : !!prev.sshHasPassword,
                              sshHasKey: clearSshKey ? false : editSshPrivateKey ? true : !!prev.sshHasKey,
                              expiresAt,
                              purchaseAmountCents: Math.round(editPurchaseAmount * 100),
                              billingCycle: editBillingCycle,
                              autoRenew: editAutoRenew ? 1 : 0,
                            }
                          : prev
                      );
                      setEditSshPassword("");
                      setEditSshPrivateKey("");
                      setClearSshPassword(false);
                      setClearSshKey(false);
                      setEditing(false);
                    } catch (e: any) {
                      setSaveError(e?.message ?? "保存失败");
                    }
                  }}
                >
                  保存
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="rounded-2xl border border-white/15 bg-white/10 p-4 backdrop-blur">
        <div className="mb-2 flex items-end gap-2">
          <div className="flex-1">
            <div className="font-extrabold">最近指标</div>
            <div className="text-xs text-white/60">最近 {metrics.length} 条</div>
          </div>
        </div>
        <div className="overflow-auto">
          <table className="w-full border-collapse text-xs">
            <thead>
              <tr className="text-white/70">
                <th className="px-2 py-2 text-left">时间</th>
                <th className="px-2 py-2 text-right">CPU</th>
                <th className="px-2 py-2 text-right">内存</th>
                <th className="px-2 py-2 text-right">磁盘</th>
                <th className="px-2 py-2 text-right">RX</th>
                <th className="px-2 py-2 text-right">TX</th>
                <th className="px-2 py-2 text-right">RX/s</th>
                <th className="px-2 py-2 text-right">TX/s</th>
                <th className="px-2 py-2 text-right">load(1m)</th>
              </tr>
            </thead>
            <tbody>
              {metrics
                .slice()
                .reverse()
                .slice(0, 80)
                .map((m, idx, arr) => {
                  const next = idx + 1 < arr.length ? arr[idx + 1] : null; // older sample
                  const dt = next ? (m.at - next.at) / 1000 : 0;
                  const rx = next && dt > 0 ? Math.max(0, (m.netRxBytes - next.netRxBytes) / dt) : 0;
                  const tx = next && dt > 0 ? Math.max(0, (m.netTxBytes - next.netTxBytes) / dt) : 0;
                  return (
                    <tr key={m.at} className="border-t border-white/10">
                    <td className="px-2 py-2">{new Date(m.at).toLocaleString()}</td>
                    <td className="px-2 py-2 text-right">{Math.round(m.cpuUsage * 100)}%</td>
                    <td className="px-2 py-2 text-right">
                      {formatBytes(m.memUsed)} / {formatBytes(m.memTotal)}
                    </td>
                    <td className="px-2 py-2 text-right">
                      {formatBytes(m.diskUsed)} / {formatBytes(m.diskTotal)}
                    </td>
                    <td className="px-2 py-2 text-right">{formatBytes(m.netRxBytes)}</td>
                    <td className="px-2 py-2 text-right">{formatBytes(m.netTxBytes)}</td>
                    <td className="px-2 py-2 text-right">{formatBps(rx)}</td>
                    <td className="px-2 py-2 text-right">{formatBps(tx)}</td>
                    <td className="px-2 py-2 text-right">{m.load1.toFixed(2)}</td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </div>
        {loc?.state?.createdAgentKey ? (
          <div className="mt-3 rounded-2xl border border-emerald-400/30 bg-emerald-500/10 p-3 text-sm text-white/80">
            已创建 agentKey：<code className="text-white">{String(loc.state.createdAgentKey)}</code>（建议立刻下载 config 保存）
          </div>
        ) : null}
      </div>
    </div>
  );
}
