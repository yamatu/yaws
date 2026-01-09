import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { apiFetch } from "./api";

function defaultAgentWsUrl() {
  try {
    const u = new URL(window.location.origin);
    const wsProto = u.protocol === "https:" ? "wss:" : "ws:";
    return `${wsProto}//${u.host}/ws/agent`;
  } catch {
    return "ws://<主控IP>:3001/ws/agent";
  }
}

export function MachineNewPage() {
  const nav = useNavigate();
  const [name, setName] = useState("");
  const [groupName, setGroupName] = useState("");
  const [notes, setNotes] = useState("");
  const [intervalSec, setIntervalSec] = useState(5);
  const [agentWsUrl, setAgentWsUrl] = useState(defaultAgentWsUrl());
  const [expiresDate, setExpiresDate] = useState<string>("");
  const [purchaseAmount, setPurchaseAmount] = useState<number>(0);
  const [billingCycle, setBillingCycle] = useState<"month" | "quarter" | "half_year" | "year" | "two_year" | "three_year">("month");
  const [autoRenew, setAutoRenew] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = useMemo(() => name.trim().length > 0, [name]);

  return (
    <div className="rounded-2xl border border-white/15 bg-white/10 p-4 backdrop-blur">
      <div className="mb-4">
        <div className="text-lg font-extrabold">新增机器</div>
        <div className="text-xs text-white/60">通讯方式目前固定为 WS（探针连接 `/ws/agent`）</div>
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <div>
          <div className="mb-1 text-xs text-white/60">名称</div>
          <input
            className="w-full rounded-xl border border-white/15 bg-white/10 px-3 py-2 outline-none focus:border-white/30"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="例如：prod-01"
          />
        </div>

        <div>
          <div className="mb-1 text-xs text-white/60">分组（可选）</div>
          <input
            className="w-full rounded-xl border border-white/15 bg-white/10 px-3 py-2 outline-none focus:border-white/30"
            value={groupName}
            onChange={(e) => setGroupName(e.target.value)}
            placeholder="例如：香港 / 东京 / AWS"
          />
        </div>

        <div>
          <div className="mb-1 text-xs text-white/60">上报间隔（秒）</div>
          <input
            className="w-full rounded-xl border border-white/15 bg-white/10 px-3 py-2 outline-none focus:border-white/30"
            type="number"
            min={2}
            max={3600}
            value={intervalSec}
            onChange={(e) => setIntervalSec(Number(e.target.value))}
          />
        </div>

        <div className="md:col-span-2">
          <div className="mb-1 text-xs text-white/60">探针连接地址（agent 使用）</div>
          <input
            className="w-full rounded-xl border border-white/15 bg-white/10 px-3 py-2 outline-none focus:border-white/30"
            value={agentWsUrl}
            onChange={(e) => setAgentWsUrl(e.target.value)}
            placeholder="ws://<主控IP>:3001/ws/agent"
          />
          <div className="mt-1 text-xs text-white/50">注意：被控端需要能访问这个地址（通常填写主控公网 IP/域名）。</div>
        </div>

        <div>
          <div className="mb-1 text-xs text-white/60">到期日期</div>
          <input
            className="w-full rounded-xl border border-white/15 bg-white/10 px-3 py-2 outline-none focus:border-white/30"
            type="date"
            value={expiresDate}
            onChange={(e) => setExpiresDate(e.target.value)}
          />
        </div>

        <div>
          <div className="mb-1 text-xs text-white/60">购买金额（元）</div>
          <input
            className="w-full rounded-xl border border-white/15 bg-white/10 px-3 py-2 outline-none focus:border-white/30"
            type="number"
            min={0}
            step={0.01}
            value={purchaseAmount}
            onChange={(e) => setPurchaseAmount(Number(e.target.value))}
          />
        </div>

        <div>
          <div className="mb-1 text-xs text-white/60">计费周期</div>
          <select
            className="w-full rounded-xl border border-white/15 bg-white/10 px-3 py-2 text-white outline-none focus:border-white/30"
            value={billingCycle}
            onChange={(e) => setBillingCycle(e.target.value as any)}
          >
            <option value="month">月付</option>
            <option value="quarter">季付</option>
            <option value="half_year">半年付</option>
            <option value="year">年付</option>
            <option value="two_year">两年付</option>
            <option value="three_year">三年付</option>
          </select>
        </div>

        <div className="flex items-end gap-2">
          <label className="flex items-center gap-2 text-sm text-white/80">
            <input type="checkbox" checked={autoRenew} onChange={(e) => setAutoRenew(e.target.checked)} />
            自动续费（仅站内展示）
          </label>
        </div>

        <div className="md:col-span-2">
          <div className="mb-1 text-xs text-white/60">备注</div>
          <textarea
            className="w-full rounded-xl border border-white/15 bg-white/10 px-3 py-2 outline-none focus:border-white/30"
            style={{ minHeight: 90, resize: "vertical" }}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </div>
      </div>

      {error ? (
        <div className="mt-3 rounded-2xl border border-rose-400/40 bg-rose-500/10 p-3 text-sm">{error}</div>
      ) : null}

      <div className="mt-4 flex items-center gap-2">
        <div className="flex-1" />
        <button
          className="rounded-xl border border-white/15 bg-white/10 px-3 py-2 text-sm hover:bg-white/15"
          onClick={() => nav(-1)}
        >
          取消
        </button>
        <button
          className="rounded-xl border border-sky-400/40 bg-sky-400/15 px-3 py-2 text-sm font-semibold hover:bg-sky-400/20 disabled:opacity-60"
          disabled={!canSubmit || loading}
          onClick={async () => {
            setLoading(true);
            setError(null);
            try {
              const expiresAt = expiresDate ? new Date(`${expiresDate}T00:00:00`).getTime() : null;
              const res = await apiFetch<{ ok: true; id: number; agentKey: string }>("/api/machines", {
                method: "POST",
                body: JSON.stringify({
                  name,
                  groupName,
                  notes,
                  intervalSec,
                  agentWsUrl,
                  expiresAt,
                  purchaseAmount,
                  billingCycle,
                  autoRenew,
                }),
              });
              nav(`/app/machines/${res.id}`, { replace: true, state: { createdAgentKey: res.agentKey } as any });
            } catch (e: any) {
              setError(`创建失败：${e?.message ?? "unknown"}`);
            } finally {
              setLoading(false);
            }
          }}
        >
          {loading ? "创建中..." : "创建"}
        </button>
      </div>
    </div>
  );
}
