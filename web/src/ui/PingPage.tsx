import { useEffect, useMemo, useState } from "react";
import { apiFetch } from "./api";

type Monitor = { id: number; target: string; intervalSec: number; enabled: number; latencyMs?: number | null };
type Sample = { id: number; at: number; latencyMs: number | null; error: string | null };

function Chart({ samples }: { samples: Sample[] }) {
  const w = 760, h = 260, p = 28;
  const vals = samples.flatMap((s) => s.latencyMs == null ? [] : [s.latencyMs]);
  const max = Math.max(10, ...vals, 1);
  const pts = samples.map((s, i) => `${p + i / Math.max(1, samples.length - 1) * (w - p * 2)},${s.latencyMs == null ? h - p : h - p - s.latencyMs / max * (h - p * 2)}`);
  return <svg viewBox={`0 0 ${w} ${h}`} className="h-64 w-full" aria-label="Ping latency chart">{[0, .5, 1].map((r) => <line key={r} x1={p} x2={w - p} y1={h - p - r * (h - p * 2)} y2={h - p - r * (h - p * 2)} stroke="rgba(255,255,255,.1)" />)}{pts.length > 1 && <polyline fill="none" stroke="#38bdf8" strokeWidth="3" points={pts.join(" ")} />}{samples.map((s, i) => s.latencyMs == null ? null : <circle key={s.id} cx={pts[i].split(",")[0]} cy={pts[i].split(",")[1]} r="3" fill="#67e8f9" />)}<text x={p} y="18" fill="rgba(255,255,255,.55)" fontSize="12">{max.toFixed(0)} ms</text></svg>;
}

export function PingPage() {
  const [monitors, setMonitors] = useState<Monitor[]>([]), [selected, setSelected] = useState<number | null>(null), [target, setTarget] = useState(""), [samples, setSamples] = useState<Sample[]>([]), [error, setError] = useState<string | null>(null);
  const monitor = monitors.find((m) => m.id === selected);
  const load = () => apiFetch<{ monitors: Monitor[] }>("/api/ping/monitors").then((r) => { setMonitors(r.monitors); if (selected == null && r.monitors[0]) setSelected(r.monitors[0].id); }).catch(() => {});
  useEffect(() => { void load(); const t = window.setInterval(load, 5000); return () => window.clearInterval(t); }, [selected]);
  useEffect(() => { if (!selected) return; const read = () => apiFetch<{ samples: Sample[] }>(`/api/ping/monitors/${selected}/samples?limit=360`).then((r) => setSamples(r.samples)).catch(() => {}); void read(); const t = window.setInterval(read, 5000); return () => window.clearInterval(t); }, [selected]);
  const availability = useMemo(() => samples.length ? Math.round(samples.filter((s) => s.latencyMs != null).length / samples.length * 100) : 0, [samples]);
  async function add() { setError(null); try { const r = await apiFetch<{ monitor: Monitor }>("/api/ping/monitors", { method: "POST", body: JSON.stringify({ target, intervalSec: 5 }) }); setTarget(""); await load(); setSelected(r.monitor.id); } catch (e: any) { setError(e?.message ?? "添加失败"); } }
  async function patch(enabled: boolean) { if (!monitor) return; await apiFetch(`/api/ping/monitors/${monitor.id}`, { method: "PATCH", body: JSON.stringify({ enabled }) }); await load(); }
  async function remove() { if (!monitor) return; await apiFetch(`/api/ping/monitors/${monitor.id}`, { method: "DELETE" }); setSelected(null); await load(); }
  return <div className="space-y-4"><div className="yaws-card p-5"><div className="text-xl font-extrabold">网络延迟监控</div><div className="mt-1 text-sm text-white/45">后端持续探测，离开页面后仍保留最近 24 小时样本。</div><div className="mt-4 flex gap-2"><input className="yaws-input flex-1" value={target} onChange={(e) => setTarget(e.target.value)} placeholder="1.1.1.1 或 example.com" autoComplete="off" spellCheck={false} /><button className="yaws-btn-primary" disabled={!target.trim()} onClick={() => void add()}>添加监控</button></div>{error && <div className="yaws-alert-error mt-3">{error}</div>}</div><div className="grid gap-4 lg:grid-cols-[260px_1fr]"><div className="yaws-card p-3"><div className="mb-2 px-2 text-xs text-white/40">监控目标（{monitors.length}/16）</div>{monitors.map((m) => <button key={m.id} className={`mb-1 w-full rounded-lg px-3 py-2 text-left text-sm ${m.id === selected ? "bg-sky-400/15" : "hover:bg-white/[.06]"}`} onClick={() => setSelected(m.id)}>{m.target}<span className="float-right">{m.latencyMs != null ? `${m.latencyMs.toFixed(1)}ms` : "离线"}</span></button>)}</div><div className="yaws-card p-4">{monitor ? <><div className="mb-3 flex items-center gap-2"><div className="flex-1"><div className="text-lg font-bold">{monitor.target}</div><div className="text-xs text-white/40">每 {monitor.intervalSec} 秒 · {samples.length} 个样本</div></div><button className="yaws-btn" onClick={() => void patch(!monitor.enabled)}>{monitor.enabled ? "暂停" : "恢复"}</button><button className="yaws-btn" onClick={() => void remove()}>删除</button></div><div className="mb-3 flex gap-5 text-sm">当前：<b className="text-cyan-300">{monitor.latencyMs != null ? `${monitor.latencyMs.toFixed(1)} ms` : "—"}</b><span>可用率：<b>{availability}%</b></span></div><Chart samples={samples} /></> : <div className="p-12 text-center text-white/35">选择或添加监控目标</div>}</div></div></div>;
}
