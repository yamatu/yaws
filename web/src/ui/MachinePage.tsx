import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { apiFetch, apiFetchText, type Machine, type Metric } from "./api";
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
  const [setup, setSetup] = useState<{ wsUrl: string; agentKey: string | null; downloadConfigUrl: string } | null>(null);
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
        }
        const ms = await apiFetch<{ metrics: Metric[] }>(`/api/machines/${machineId}/metrics?limit=300`, {
          signal: ac.signal,
        });
        if (!alive) return;
        setMetrics(ms.metrics);
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
                const m: Metric = {
                  at: ev.metric.at,
                  cpuUsage: ev.metric.cpu.usage,
                  memUsed: ev.metric.mem.used,
                  memTotal: ev.metric.mem.total,
                  diskUsed: ev.metric.disk.used,
                  diskTotal: ev.metric.disk.total,
                  netRxBytes: ev.metric.net?.rxBytes ?? 0,
                  netTxBytes: ev.metric.net?.txBytes ?? 0,
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
  }, [machineId]);

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
          <span className="rounded-full border border-white/15 bg-white/5 px-2 py-1">
            到期：{machine.expiresAt ? new Date(machine.expiresAt).toLocaleDateString() : "—"}
            {left != null ? `（${left} 天）` : ""}
          </span>
          <span className="rounded-full border border-white/15 bg-white/5 px-2 py-1">
            {cycleLabel(machine.billingCycle)} · {formatMoneyCents(machine.purchaseAmountCents)}
            {machine.autoRenew ? " · 自动续费" : ""}
          </span>
        </div>

        {machine.notes ? <div className="mt-3 whitespace-pre-wrap text-sm text-white/70">{machine.notes}</div> : null}
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <div className="rounded-2xl border border-white/15 bg-white/10 p-4 backdrop-blur">
          <div className="mb-1 text-xs text-white/60">CPU</div>
          <div className="mb-2 flex items-end gap-2">
            <div className="text-3xl font-black">{cpu == null ? "—" : `${Math.round(cpu * 100)}%`}</div>
            <div className="flex-1" />
            <div className="text-xs text-white/60">{last ? new Date(last.at).toLocaleTimeString() : "—"}</div>
          </div>
          <div className="h-2 overflow-hidden rounded-full border border-white/15 bg-white/5">
            <div
              className="h-full bg-gradient-to-r from-sky-400/90 to-emerald-400/90"
              style={{ width: `${Math.round((cpu ?? 0) * 100)}%` }}
            />
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
          <div className="h-2 overflow-hidden rounded-full border border-white/15 bg-white/5">
            <div
              className="h-full bg-gradient-to-r from-sky-400/90 to-emerald-400/90"
              style={{ width: `${Math.round((memP ?? 0) * 100)}%` }}
            />
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
          <div className="h-2 overflow-hidden rounded-full border border-white/15 bg-white/5">
            <div
              className="h-full bg-gradient-to-r from-sky-400/90 to-emerald-400/90"
              style={{ width: `${Math.round((diskP ?? 0) * 100)}%` }}
            />
          </div>
        </div>

        <div className="rounded-2xl border border-white/15 bg-white/10 p-4 backdrop-blur">
          <div className="mb-1 text-xs text-white/60">流量（累计）</div>
          <div className="text-sm text-white/80">
            RX: {last ? formatBytes(last.netRxBytes) : "—"} · TX: {last ? formatBytes(last.netTxBytes) : "—"}
          </div>
          <div className="mt-1 text-sm text-white/80">
            速度：RX {formatBps(rxBps)} · TX {formatBps(txBps)}
          </div>
          <div className="mt-2 text-xs text-white/50">来自 `/proc/net/dev` 汇总（排除 lo）。</div>
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
                    className="w-full rounded-xl border border-white/15 bg-white/10 px-3 py-2 text-white outline-none focus:border-white/30"
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
                              expiresAt,
                              purchaseAmountCents: Math.round(editPurchaseAmount * 100),
                              billingCycle: editBillingCycle,
                              autoRenew: editAutoRenew ? 1 : 0,
                            }
                          : prev
                      );
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
