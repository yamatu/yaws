import { useEffect, useState } from "react";
import { apiFetch } from "./api";
import { fmtTime, daysLeft } from "./format";

type Cert = { id:number; certPath:string; keyPath:string; domains:string[]; expiresAt:number|null; issuer:string; lastScanAt:number; lastRenewAt:number|null; status:string; lastError:string };
type ScanInfo = { user?:string; uid?:string; openssl?:string; nginx?:string; sudo?:string; nginxConfig?:string; candidates?:string; certificates?:string; skipped?:string };
type Machine = { id:number; name:string; sshHost:string; sshPort:number; sshUser:string; sshAuthType:string; sshTrusted:number; credentials?:"ok"|"missing"|"undecryptable" };
type MachineStat = { machineId:number; certificates:number; expired:number; expiring:number; nextExpiry:number|null };
type Config = { email:string; cfTokenMasked:string; cfAccountId:string; autoRenew:boolean; autoRenewDays:number; configured:boolean };
type ScanResult = { found:number; added:number; updated:number; pruned:number; warning?:string; info?:ScanInfo };
type Notice = { kind:"ok"|"err"; text:string };
type CertFilter = "all"|"ok"|"expiring"|"expired"|"error";

const EXPIRING_DAYS = 15;

// Map named backend error codes (with optional ":detail" tails) to plain
// Chinese guidance; unknown codes fall through unchanged.
function friendlyError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const code = raw.split(":")[0];
  const detail = raw.length > code.length ? raw.slice(code.length + 1).trim() : "";
  const texts: Record<string, string> = {
    ssh_credentials_invalid: "SSH 凭据解密失败：服务端加密密钥（AGENT_KEY_SECRET / JWT_SECRET）可能已变更，请到机器详情重新保存 SSH 密码或私钥",
    ssh_password_missing: "这台机器没有保存 SSH 密码，请到机器详情补充",
    ssh_key_missing: "这台机器没有保存 SSH 私钥，请到机器详情补充",
    ssh_key_invalid: "SSH 私钥无法解密：服务端加密密钥可能已变更，请到机器详情重新粘贴私钥",
    ssh_auth_failed: "SSH 认证失败：用户名、密码或私钥不正确（也可能该账户被禁止登录）",
    ssh_exec_failed: "服务器拒绝了命令执行：请确认该账户允许远程命令（exec），未被限制为仅 SFTP",
    ssh_exec_timeout: "远程命令执行超时，请稍后重试",
    certificate_scan_failed: "远程扫描命令执行失败",
    certificate_scan_timeout: "扫描超过 150 秒被中止：请检查服务器负载，或确认证书目录没有挂载卡死的网络盘",
    certificate_scan_failed_detail: "扫描命令在服务器上执行失败",
    certificate_scan_internal: "扫描结果处理失败，请把括号内的详细信息反馈给开发者",
    certificate_internal_error: "证书功能出现未预期的服务端错误，请把括号内的详细信息反馈给开发者",
    ssh_host_untrusted: "尚未信任该服务器的 SSH 指纹，请先到机器详情完成信任",
    ssh_host_key_changed: "SSH 主机密钥已变化，请核实服务器身份后重新信任指纹",
    ssh_not_configured: "这台机器还没有配置 SSH",
    machine_not_found: "机器不存在或已删除",
    ssh_closed: "SSH 连接被关闭，请检查网络与端口",
    ssh_connect_failed: "SSH 连接失败，请检查主机、端口与防火墙",
    "ssh_client-authentication": "SSH 认证失败，请检查用户名、密码或私钥",
    "ssh_client-timeout": "SSH 连接超时，请检查网络与端口",
    ssh_timeout: "SSH 连接超时",
    cloudflare_not_configured: "请先在上方配置 Cloudflare API Token 和 Account ID",
    certificate_key_not_found: "没有找到匹配的私钥文件，无法续期",
    certificate_renew_failed: "证书续期失败",
    certificate_issue_failed: "证书签发失败",
    acme_issue_failed: "acme.sh 申请证书失败：常见原因是域名未解析、Cloudflare Token 没有该域名的 DNS:Edit 权限，或 Let's Encrypt 速率限制",
    acme_install_failed: "acme.sh 已申请成功但安装证书失败：请确认 SSH 账户可用 root 或免密 sudo 写入证书路径",
    "acme.sh_not_found": "服务器上未安装 acme.sh，请先在服务器执行 curl https://get.acme.sh | sh -s email=你的邮箱",
    nginx_config_test_failed: "nginx -t 配置检查失败：已回滚到原证书，请先修复 Nginx 配置",
    nginx_reload_failed: "Nginx 重载失败：请检查 systemctl 权限，或在服务器上手动重载",
    cert_dir_failed: "无法创建证书目录：SSH 账户需要 root 或免密 sudo 权限",
    backup_failed: "备份原证书失败，已中止以免破坏现有证书",
    bad_domain: "域名格式不正确",
    bad_cert_path: "证书路径必须是绝对路径（以 / 开头）",
    bad_key_path: "私钥路径必须是绝对路径（以 / 开头）",
    cert_and_key_same_path: "证书路径与私钥路径不能相同",
    too_many_domains: "一次最多申请 30 个域名",
    certificate_not_found: "证书记录不存在，请重新扫描",
    forbidden: "仅管理员可用",
    bad_request: "请求参数错误",
    cancelled: "操作已取消",
  };
  const text = texts[code] ?? raw;
  return detail ? `${text}（${detail.slice(-260)}）` : text;
}

function certState(c: Cert): { key:CertFilter; label:string; cls:string } {
  if (c.status === "renewing") return { key:"error", label:"续期中", cls:"text-sky-300 border-sky-400/30" };
  // Time-based buckets win over status=error: a cert expiring in days whose
  // renewal failed is exactly what the 即将到期/已到期 filters must surface.
  const d = daysLeft(c.expiresAt);
  if (d !== null && d <= 0) return { key:"expired", label:"已到期", cls:"text-rose-300 border-rose-400/30" };
  if (d !== null && d <= EXPIRING_DAYS) return { key:"expiring", label:`剩 ${d} 天`, cls:"text-amber-300 border-amber-400/30" };
  if (c.status === "error") return { key:"error", label:"异常", cls:"text-rose-300 border-rose-400/30" };
  return { key:"ok", label:"正常", cls:"text-emerald-300 border-emerald-400/30" };
}

const FILTERS: Array<{ key:CertFilter; label:string }> = [
  { key:"all", label:"全部" }, { key:"ok", label:"正常" }, { key:"expiring", label:"即将到期" },
  { key:"expired", label:"已到期" }, { key:"error", label:"异常/续期中" },
];

const DOMAIN_SPLIT = /[\s,;，、]+/;

// Accepts a pasted list as well as full URLs / bare hosts, so a copied
// "https://a.com/x, www.b.com" works without hand-editing.
type IssueResult = { ok:boolean; text:string };

function parseDomainInput(text:string):string[] {
  const out:string[]=[];
  for (const raw of text.split(DOMAIN_SPLIT)) {
    let d=raw.trim().toLowerCase();
    if(!d) continue;
    d=d.replace(/^[a-z][a-z0-9+.-]*:\/\//,"").split("/")[0].split(":")[0].replace(/\.$/,"");
    if(d&&!out.includes(d)) out.push(d);
  }
  return out;
}

export function CertificatesPage() {
  const [config,setConfig]=useState<Config|null>(null); const [email,setEmail]=useState("yamatu@qq.com");
  const [token,setToken]=useState(""); const [account,setAccount]=useState(""); const [autoRenew,setAutoRenew]=useState(true); const [autoRenewDays,setAutoRenewDays]=useState(30);
  const [machines,setMachines]=useState<Machine[]>([]); const [stats,setStats]=useState<Record<number,MachineStat>>({});
  const [selected,setSelected]=useState<number>(0); const [certs,setCerts]=useState<Cert[]>([]); const [filter,setFilter]=useState<CertFilter>("all");
  const [scanInfoById,setScanInfoById]=useState<Record<number,ScanInfo>>({});
  const [busy,setBusy]=useState(false); const [scanningId,setScanningId]=useState<number>(0); const [notice,setNotice]=useState<Notice|null>(null);
  const [issueMachine,setIssueMachine]=useState<number>(0); const [issueDomains,setIssueDomains]=useState("");
  const [issueCertPath,setIssueCertPath]=useState(""); const [issueKeyPath,setIssueKeyPath]=useState("");
  const [issueForce,setIssueForce]=useState(true); const [issueReload,setIssueReload]=useState(true);
  const [issuing,setIssuing]=useState(false); const [issueResult,setIssueResult]=useState<IssueResult|null>(null);
  const loadConfig=()=>apiFetch<Config>("/api/certificates/config").then(c=>{setConfig(c);setEmail(c.email||"yamatu@qq.com");setAccount(c.cfAccountId||"");setAutoRenew(c.autoRenew);setAutoRenewDays(c.autoRenewDays||30);}).catch(e=>setNotice({kind:"err",text:`配置加载失败：${friendlyError(e)}`}));
  const loadSummary=()=>apiFetch<{summary:MachineStat[]}>("/api/certificates/summary").then(r=>setStats(Object.fromEntries(r.summary.map(s=>[s.machineId,s])))).catch(()=>{});
  const loadMachines=()=>apiFetch<{machines:Machine[]}>("/api/certificates/machines").then(r=>setMachines(r.machines));
  useEffect(()=>{ void Promise.all([loadConfig(),loadMachines(),loadSummary()]); },[]);
  const refreshCerts=(id:number)=>apiFetch<{certificates:Cert[]}>(`/api/certificates/machine/${id}`).then(r=>setCerts(r.certificates));
  useEffect(()=>{ if(selected) void refreshCerts(selected).catch(()=>setCerts([])); },[selected]);
  // Jump straight into the first configured machine instead of an empty table.
  useEffect(()=>{ if(!selected&&machines.length) setSelected(machines[0].id); },[machines,selected]);

  async function save(){setBusy(true);setNotice(null);try{await apiFetch("/api/certificates/config",{method:"PUT",body:JSON.stringify({email,cfToken:token||undefined,cfAccountId:account,autoRenew,autoRenewDays})});setToken("");await loadConfig();setNotice({kind:"ok",text:"Cloudflare 配置已保存"});}catch(e){setNotice({kind:"err",text:`保存失败：${friendlyError(e)}`});}finally{setBusy(false)}}

  // Runs one scan and refreshes everything it touches; throws so batch scanning
  // can collect per-machine failures. When silent, errors skip the notice area.
  async function scanFor(id:number, opts:{silent?:boolean}={}) {
    if (opts.silent) { setScanningId(id); } else { setBusy(true); setScanningId(id); setNotice(null); }
    setSelected(id);
    let r: ScanResult;
    try {
      r = await apiFetch<ScanResult>(`/api/certificates/machine/${id}/scan`,{method:"POST",body:"{}"});
    } catch(e:any) {
      if (!opts.silent) setNotice({kind:"err",text:`扫描失败：${friendlyError(e)}`});
      throw e;
    } finally { setScanningId(0); if (!opts.silent) setBusy(false); }
    if (r.info) setScanInfoById(p=>({...p,[id]:r.info!}));
    // The scan already stored its rows, so a failing follow-up refresh must not
    // be reported as "扫描失败" — that hides the fact the scan worked.
    let refreshError="";
    await Promise.all([refreshCerts(id).catch(e=>{refreshError=friendlyError(e)}),loadSummary()]);
    if (!opts.silent) setNotice(refreshError
      ? {kind:"err",text:`扫描已完成（发现 ${r.found} 个证书），但刷新列表失败：${refreshError}`}
      : {kind:"ok",text:r.warning??`扫描完成：发现 ${r.found} 个证书（新增 ${r.added} · 更新 ${r.updated}${r.pruned?` · 清理 ${r.pruned}`:""}）`});
    return r;
  }
  // A machine with unusable credentials would only fail server-side; say why.
  function credWarning(m:Machine){ return m.credentials==="undecryptable"?"SSH 密码/私钥无法解密（服务端加密密钥已变），请到机器详情重新保存":m.credentials==="missing"?"未保存 SSH 密码或私钥":""; }
  function canScan(m:Machine){ return !!m.sshTrusted && (!m.credentials||m.credentials==="ok"); }
  async function scan(m:Machine){ if(!canScan(m)||busy) return; try { await scanFor(m.id); } catch { /* already reported */ } }
  async function scanAll(){
    if (busy) return; setBusy(true); setNotice(null);
    const targets=machines.filter(canScan);
    if (!targets.length){ setNotice({kind:"err",text:"没有可扫描的服务器：请先信任 SSH 指纹，并确认已保存可用的 SSH 密码或私钥"}); setBusy(false); return; }
    let total=0; const failed:string[]=[];
    for (const m of targets) {
      try { const r=await scanFor(m.id,{silent:true}); total+=r.found; }
      catch(e){ failed.push(`${m.name}：${friendlyError(e)}`); }
    }
    setNotice({kind:failed.length?"err":"ok",text:`批量扫描完成：${targets.length-failed.length}/${targets.length} 台成功，共发现 ${total} 个证书${failed.length?`。失败：${failed.join("；")}`:""}`});
    setBusy(false);
  }
  async function renew(c:Cert){ if(!confirm(`确认申请并更新 ${c.domains.join(", ")}？将执行 acme.sh 续期、nginx -t 后重载 Nginx。`))return;setBusy(true);setNotice(null);try{await apiFetch(`/api/certificates/machine/${selected}/renew`,{method:"POST",body:JSON.stringify({id:c.id})});await Promise.all([refreshCerts(selected),loadSummary()]);setNotice({kind:"ok",text:"证书更新成功，Nginx 已重载"});}catch(e){setNotice({kind:"err",text:`更新失败：${friendlyError(e)}`});}finally{setBusy(false)}}

  useEffect(()=>{ if(!issueMachine&&selected) setIssueMachine(selected); },[selected,issueMachine]);
  // Only machines that can actually be reached are offered: issuance uses the
  // same SSH channel (and the same fingerprint trust) as scanning.
  const issuable=machines.filter(canScan);
  const issueTarget=machines.find(m=>m.id===(issueMachine||selected));
  const parsedDomains=parseDomainInput(issueDomains);

  async function issue(){
    const id=issueMachine||selected; const domains=parsedDomains;
    if(!id){ setIssueResult({ok:false,text:"请先选择一台可用的服务器"}); return; }
    if(!domains.length){ setIssueResult({ok:false,text:"请输入至少一个域名，例如 example.com www.example.com"}); return; }
    const target=machines.find(m=>m.id===id);
    if(!confirm(`向 Let's Encrypt 申请 ${domains.join(", ")} 的证书（在 ${target?target.name:id} 上执行）？\n\n将执行：acme.sh --issue --dns dns_cf\n${issueCertPath.trim()||"默认安装到 /etc/nginx/ssl/"+domains[0].replace(/^\*\./,"")+".pem"}${issueReload?"\n签发后执行 nginx -t 并重载 Nginx":""}`)) return;
    setIssuing(true); setIssueResult(null);
    try {
      const r=await apiFetch<{certPath:string;keyPath:string;domains:string[];expiresAt:number|null;reloaded:boolean}>(`/api/certificates/machine/${id}/issue`,{method:"POST",body:JSON.stringify({domains,certPath:issueCertPath.trim()||undefined,keyPath:issueKeyPath.trim()||undefined,force:issueForce,reload:issueReload})});
      setSelected(id);
      await Promise.all([refreshCerts(id),loadSummary()]);
      setIssueResult({ok:true,text:`证书已签发并安装\n域名：${r.domains.join(", ")}\n证书：${r.certPath}\n私钥：${r.keyPath}\n到期：${fmtTime(r.expiresAt)}\n${r.reloaded?"已执行 nginx -t 并重载 Nginx":"未重载 Nginx，请自行 reload"}\n\n提示：若 Nginx 站点尚未指向上面的路径，请先修改站点配置里的 ssl_certificate / ssl_certificate_key，否则线上仍在使用旧证书。`});
    } catch(e) { setIssueResult({ok:false,text:`申请失败：${friendlyError(e)}`}); }
    finally { setIssuing(false); }
  }

  const selectedMachine=machines.find(m=>m.id===selected);
  const visible=certs.filter(c=>{ if(filter==="all") return true; return certState(c).key===filter; });
  const lastScanAt=certs.length?Math.max(...certs.map(c=>c.lastScanAt||0)):0;

  return <div className="grid gap-4">
    <div className="yaws-card p-5"><div className="mb-1 text-lg font-extrabold">证书自动管理</div><div className="mb-4 text-xs text-white/45">通过已配置 SSH 扫描服务器上的证书，也可在下方手填域名直接申请；续期前会执行 nginx -t，失败不会重载。</div>
      <div className="grid gap-3 md:grid-cols-3"><div><div className="mb-1 text-xs text-white/50">注册邮箱</div><input className="yaws-input" value={email} onChange={e=>setEmail(e.target.value)} /></div><div><div className="mb-1 text-xs text-white/50">CF_Token {config?.cfTokenMasked?`(${config.cfTokenMasked})`:""}</div><input className="yaws-input" type="password" placeholder="留空表示不修改" value={token} onChange={e=>setToken(e.target.value)} /></div><div><div className="mb-1 text-xs text-white/50">CF_Account_ID</div><input className="yaws-input" value={account} onChange={e=>setAccount(e.target.value)} /></div></div>
      <div className="mt-3 flex flex-wrap items-center gap-4"><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={autoRenew} onChange={e=>setAutoRenew(e.target.checked)}/> 启用到期前自动续期</label><label className="text-xs text-white/50">提前 <input className="yaws-input inline-block w-20" type="number" min={1} max={90} value={autoRenewDays} onChange={e=>setAutoRenewDays(Number(e.target.value))}/> 天</label><button className="yaws-btn-primary" disabled={busy} onClick={save}>保存配置</button><span className={`text-xs ${config?.configured?"text-emerald-300":"text-amber-300"}`}>{config?.configured?"Cloudflare DNS 已配置":"尚未配置 CF_Token / CF_Account_ID"}</span></div>
    </div>

    <div className="yaws-card p-5">
      <div className="mb-3 flex items-center justify-between"><div className="font-extrabold">SSH 服务器</div><div className="flex items-center gap-3"><span className="text-xs text-white/40">共 {machines.length} 台已配置 SSH</span><button className="yaws-btn-primary text-xs" disabled={busy||!machines.some(canScan)} onClick={scanAll}>{busy?"扫描中…":"扫描全部"}</button></div></div>
      <div className="grid gap-3">{machines.length?machines.map(m=>{
        const stat=stats[m.id];
        return <div key={m.id} className={`rounded-xl border p-4 ${selected===m.id?"border-sky-400/50 bg-sky-400/[.08]":"border-white/[.08] bg-white/[.03]"}`}>
          <div className="flex flex-wrap items-center gap-3">
            <button className="flex-1 text-left" onClick={()=>setSelected(m.id)}>
              <div className="font-semibold">{m.name}</div>
              <div className="mt-1 text-xs text-white/50">{m.sshUser}@{m.sshHost}:{m.sshPort} · {m.sshAuthType==="key"?"私钥":"密码"}</div>
            </button>
            {stat?<span className="yaws-badge border-white/10 bg-white/[.04] text-xs text-white/70">{stat.certificates} 个证书{stat.expired?` · ${stat.expired} 已到期`:stat.expiring?` · ${stat.expiring} 即将到期`:""}</span>:null}
            <span className={`text-xs ${m.sshTrusted?"text-emerald-300":"text-amber-300"}`}>{m.sshTrusted?"SSH 指纹已信任":"需要先信任 SSH 指纹"}</span>
            {credWarning(m)?<span className="text-xs text-rose-300">{credWarning(m)}</span>:null}
            <button className="yaws-btn" disabled={!canScan(m)||busy} title={credWarning(m)||(!m.sshTrusted?"需要先信任 SSH 指纹":"")} onClick={()=>void scan(m)}>{scanningId===m.id?"扫描中…":"扫描证书"}</button>
            <button className="yaws-btn" disabled={busy} onClick={()=>setSelected(m.id)}>查看</button>
          </div>
          {selected===m.id&&scanInfoById[m.id]?<div className="mt-3 text-xs text-white/50">扫描身份：{scanInfoById[m.id].user||"—"}（uid {scanInfoById[m.id].uid||"—"}） · openssl：{scanInfoById[m.id].openssl||"未找到"} · nginx：{scanInfoById[m.id].nginx||"未找到"} · 配置：{scanInfoById[m.id].nginxConfig||"—"} · 候选文件：{scanInfoById[m.id].candidates||"0"} · 可解析证书：{scanInfoById[m.id].certificates||"0"} · 跳过 CA/信任库：{scanInfoById[m.id].skipped||"0"}</div>:null}
        </div>;
      }):<div className="rounded-lg border border-dashed border-white/10 p-5 text-sm text-white/40">没有配置 SSH 的服务器，请先到机器详情中配置 SSH。</div>}</div>
      {notice?<div className={notice.kind==="err"?"mt-3 yaws-alert-error":"mt-3 yaws-alert-success"}>{notice.text}</div>:null}
    </div>

    <div className="yaws-card p-5">
      <div className="mb-1 font-extrabold">手动申请证书</div>
      <div className="mb-4 text-xs text-white/45">输入想要签发证书的域名（每行一个，也可用空格/逗号分隔，支持 *.example.com 通配符）。系统会在所选服务器上通过 Cloudflare DNS 验证向 Let&apos;s Encrypt 申请，并把证书安装到指定路径。域名需已托管在同一个 Cloudflare 账号下。</div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="text-xs text-white/50">目标服务器：</span>
        {issuable.length?issuable.map(m=><button key={m.id} className={`yaws-tag ${(issueMachine||selected)===m.id?"yaws-tag-active":""}`} disabled={issuing} onClick={()=>setIssueMachine(m.id)}>{m.name}</button>)
          :<span className="text-xs text-amber-300">没有可用服务器：请先在下方列表中信任 SSH 指纹，并确认已保存可用的 SSH 密码或私钥</span>}
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <div className="md:col-span-2">
          <div className="mb-1 text-xs text-white/50">域名（必填）</div>
          <textarea className="yaws-input h-24 font-mono" placeholder={"example.com\nwww.example.com"} value={issueDomains} onChange={e=>setIssueDomains(e.target.value)} />
          {issueDomains.trim()?<div className="mt-1 text-xs text-white/40">将申请 {parsedDomains.length} 个域名：{parsedDomains.join(", ")||"（无法解析，请检查格式）"}</div>:null}
        </div>
        <div><div className="mb-1 text-xs text-white/50">证书路径（可选）</div><input className="yaws-input font-mono text-xs" placeholder={`默认 /etc/nginx/ssl/${parsedDomains[0]?.replace(/^\*\./,"")||"域名"}.pem`} value={issueCertPath} onChange={e=>setIssueCertPath(e.target.value)} /></div>
        <div><div className="mb-1 text-xs text-white/50">私钥路径（可选）</div><input className="yaws-input font-mono text-xs" placeholder={`默认 /etc/nginx/ssl/${parsedDomains[0]?.replace(/^\*\./,"")||"域名"}.key`} value={issueKeyPath} onChange={e=>setIssueKeyPath(e.target.value)} /></div>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-4">
        <label className="flex items-center gap-2 text-sm" title="acme.sh --force：即使证书未到期也重新签发"><input type="checkbox" checked={issueForce} onChange={e=>setIssueForce(e.target.checked)}/> 强制重新签发（--force）</label>
        <label className="flex items-center gap-2 text-sm" title="签发后执行 nginx -t 校验配置，失败会回滚证书；若服务器上没有 nginx 可取消勾选"><input type="checkbox" checked={issueReload} onChange={e=>setIssueReload(e.target.checked)}/> 校验 Nginx 配置并重载</label>
        <button className="yaws-btn-primary" disabled={issuing||!config?.configured||!issueTarget||!parsedDomains.length} title={!config?.configured?"请先在上方配置 Cloudflare":!issueTarget?"请先选择服务器":""} onClick={issue}>{issuing?"申请中…（DNS 验证约需 1-2 分钟）":"申请证书"}</button>
        <span className="text-xs text-white/40">同一域名重复申请会触发 Let&apos;s Encrypt 速率限制（每周 5 次），不需要时可取消强制签发</span>
      </div>
      {issueResult?<div className={`mt-3 whitespace-pre-line text-xs ${issueResult.ok?"yaws-alert-success":"yaws-alert-error"}`}>{issueResult.text}</div>:null}
    </div>

    <div className="yaws-card p-5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2"><div className="flex items-center gap-3"><div className="font-extrabold">证书清单{selectedMachine?` · ${selectedMachine.name}`:""}</div>{lastScanAt?<span className="text-xs text-white/40">上次扫描 {fmtTime(lastScanAt)}</span>:null}</div>
      <div className="flex flex-wrap gap-2">{FILTERS.map(f=><button key={f.key} className={`yaws-tag ${filter===f.key?"yaws-tag-active":""}`} onClick={()=>setFilter(f.key)}>{f.label}</button>)}</div></div>
      <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead className="text-xs text-white/40"><tr><th className="p-2">域名</th><th className="p-2">证书路径</th><th className="p-2">到期时间</th><th className="p-2">状态</th><th className="p-2">操作</th></tr></thead><tbody>{visible.map(c=>{
        const st=certState(c); const d=daysLeft(c.expiresAt);
        return <tr key={c.id} className="border-t border-white/[.06]">
          <td className="p-2 text-white/85">{c.domains.join(", ")}{c.issuer?<div className="mt-0.5 max-w-xs truncate text-xs text-white/35" title={c.issuer}>{c.issuer}</div>:null}</td>
          <td className="max-w-xs truncate p-2 font-mono text-xs text-white/50" title={c.certPath}>{c.certPath}</td>
          <td className="p-2">{fmtTime(c.expiresAt)}{d!==null&&d>0?<span className={`ml-2 text-xs ${d<=EXPIRING_DAYS?"text-amber-300":"text-white/40"}`}>剩 {d} 天</span>:null}</td>
          <td className="p-2"><span className={`yaws-badge ${st.cls}`}>{st.label}</span>{c.lastError?<div className="mt-1 max-w-xs truncate text-xs text-rose-300/80" title={c.lastError}>{c.lastError}</div>:null}</td>
          <td className="p-2"><button className="yaws-btn-primary text-xs" disabled={busy||!config?.configured||!c.keyPath} title={!c.keyPath?"未找到私钥文件，无法续期":!config?.configured?"请先配置 Cloudflare":""} onClick={()=>renew(c)}>申请/更新</button></td>
        </tr>;})}</tbody></table>
        {!certs.length?<div className="p-8 text-center text-sm text-white/40">{selectedMachine?"暂无记录，点击「扫描证书」开始扫描":"请先选择一台服务器"}</div>:null}
        {certs.length&&!visible.length?<div className="p-8 text-center text-sm text-white/40">当前筛选下没有证书</div>:null}</div>
    </div>
  </div>;
}
