import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { apiFetch, type Machine } from "./api";
import { useDocumentTitle } from "./documentTitle";
type Session = { id: string; machineName: string; operator: string; destination: string; startedAt: number; status: string };

export function BastionPage() {
  useDocumentTitle("堡垒机");
  const [machines, setMachines] = useState<Machine[]>([]);
  const [query, setQuery] = useState("");
  const [sessions, setSessions] = useState<Session[]>([]);
  useEffect(() => { apiFetch<{ machines: Machine[] }>("/api/machines").then((r) => setMachines(r.machines)).catch(() => {}); }, []);
  useEffect(() => { const load = () => apiFetch<{ sessions: Session[] }>("/api/ssh/sessions").then((r) => setSessions(r.sessions.filter((s) => !["closed", "error"].includes(s.status)))).catch(() => {}); void load(); const t = window.setInterval(load, 5000); return () => window.clearInterval(t); }, []);
  const filtered = machines.filter((m) => `${m.name} ${m.groupName} ${m.sshHost}`.toLowerCase().includes(query.toLowerCase()));
  // Sessions only carry the machine name, so a name shared by two machines is
  // left unlabelled rather than guessing the wrong relay.
  const relayOf = (name: string) => {
    const matches = machines.filter((m) => m.name === name);
    return matches.length === 1 ? matches[0].viaName ?? "" : "";
  };
  return <div className="space-y-4">
    <div className="yaws-card p-5"><div className="text-xl font-extrabold">堡垒机</div><div className="mt-1 text-sm text-white/45">统一入口访问已授权主机，SSH 凭据只在服务端解密并建立临时会话。标记「内网」的主机会先连到中转服务器再转发到目标主机。</div><input className="yaws-input mt-4" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索主机名称、分组或地址" autoComplete="off" /></div>
    <div className="grid gap-3 md:grid-cols-2">{filtered.map((m) => { const ready = !!m.sshHost && !!m.sshUser && (m.sshAuthType === "key" ? !!m.sshHasKey : !!m.sshHasPassword); return <div key={m.id} className="yaws-card flex items-center gap-4 p-4"><span className={m.online ? "yaws-dot-online" : "yaws-dot-offline"} /><div className="min-w-0 flex-1"><div className="truncate font-semibold">{m.name}{m.viaName ? <span className="ml-2 rounded-full border border-sky-400/20 bg-sky-500/8 px-2 py-0.5 text-xs font-normal text-sky-300/80">内网 · 经由 {m.viaName}</span> : null}</div><div className="truncate text-xs text-white/40">{m.sshUser || "—"}@{m.sshHost || "未配置"}:{m.sshPort ?? 22}</div></div>{ready ? <Link className="yaws-btn-primary" to={`/app/machines/${m.id}/ssh`}>进入终端</Link> : <span className="text-xs text-white/35">未配置 SSH</span>}</div>; })}</div>
    <div className="yaws-card p-4"><div className="mb-3 font-semibold">活动会话</div>{sessions.length ? sessions.map((s) => <div key={s.id} className="flex items-center gap-3 border-t border-white/[.06] py-2 text-sm"><div className="flex-1"><div>{s.machineName}{relayOf(s.machineName) ? `（经由 ${relayOf(s.machineName)}）` : ""} · {s.destination}</div><div className="text-xs text-white/40">{s.operator} · {new Date(s.startedAt).toLocaleString()}</div></div><button className="yaws-btn" onClick={async () => { await apiFetch(`/api/ssh/sessions/${s.id}`, { method: "DELETE" }); setSessions((v) => v.filter((x) => x.id !== s.id)); }}>断开</button></div>) : <div className="text-sm text-white/35">当前没有活动会话</div>}</div>
    {!filtered.length ? <div className="yaws-card p-8 text-center text-white/40">暂无匹配主机</div> : null}
  </div>;
}
