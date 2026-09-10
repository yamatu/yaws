import { useEffect, useId, useMemo, useRef, useState } from "react";

export type LatencyPoint = {
  at: number;
  endAt: number;
  count: number;
  received: number;
  lost: number;
  unavailable: number;
  latencyMs: number | null;
  minMs: number | null;
  maxMs: number | null;
};
export type LatencySeries = {
  startAt: number;
  endAt: number;
  bucketMs: number;
  points: LatencyPoint[];
  summary: {
    count: number;
    received: number;
    lost: number;
    unavailable: number;
    minMs: number | null;
    maxMs: number | null;
    avgMs: number | null;
    jitterMs: number | null;
    lossPct: number | null;
  };
};
const time = (at: number) =>
  new Date(at).toLocaleTimeString("zh-CN", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  });
export const latency = (value: number | null | undefined) =>
  value == null ? "—" : value.toFixed(1);

export function LatencyChart({
  series,
  loading,
}: {
  series: LatencySeries | null;
  loading: boolean;
}) {
  const gradient = useId().replace(/:/g, "");
  const [hover, setHover] = useState<number | null>(null);
  const [mouseX, setMouseX] = useState(50);
  const container = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(900);
  const hasPoints = !!series?.points.length;
  useEffect(() => {
    if (!container.current) return;
    const observer = new ResizeObserver(([entry]) =>
      setWidth(Math.max(300, Math.floor(entry.contentRect.width))),
    );
    observer.observe(container.current);
    return () => observer.disconnect();
  }, [hasPoints]);
  const chart = useMemo(() => {
    if (!series) return null;
    const left = width < 500 ? 40 : 54,
      right = width - 24,
      top = 26,
      bottom = 256;
    const peak = Math.max(1, ...series.points.map((p) => p.maxMs ?? 0));
    const magnitude = 10 ** Math.floor(Math.log10((peak * 1.18) / 4));
    const tick = Math.ceil((peak * 1.18) / 4 / magnitude) * magnitude;
    const ceiling = tick * 4;
    const x = (at: number) =>
      left +
      ((at - series.startAt) / (series.endAt - series.startAt)) *
        (right - left);
    const y = (ms: number) => bottom - (ms / ceiling) * (bottom - top);
    const segments: LatencyPoint[][] = [];
    let segment: LatencyPoint[] = [];
    const finish = () => {
      if (segment.length) segments.push(segment);
      segment = [];
    };
    for (const point of series.points) {
      if (point.latencyMs == null) {
        finish();
        continue;
      }
      if (
        segment.length &&
        point.at - segment[segment.length - 1].endAt > series.bucketMs * 2
      )
        finish();
      segment.push(point);
      if (point.lost || point.unavailable) finish();
    }
    finish();
    const line = (
      points: LatencyPoint[],
      field: "latencyMs" | "minMs" | "maxMs",
    ) =>
      points
        .map((p, i) => `${i ? "L" : "M"}${x(p.at)},${y(p[field]!)}`)
        .join(" ");
    return { x, y, left, right, top, bottom, ceiling, segments, line };
  }, [series, width]);
  const point = hover == null ? null : series?.points[hover];
  if (!series || !chart || !series.points.length)
    return (
      <div className="eg-chart-empty" role="status">
        <span className="eg-empty-signal">···</span>
        <strong>{loading ? "正在加载延迟曲线" : "此时间段暂无采样"}</strong>
        <span>
          {loading ? "" : "在线机器开始监控后，采样会自动出现在这里。"}
        </span>
      </div>
    );
  const select = (index: number) => {
    const clamped = Math.max(0, Math.min(series.points.length - 1, index));
    setHover(clamped);
    setMouseX((chart.x(series.points[clamped].at) / width) * 100);
  };
  return (
    <div
      ref={container}
      className="eg-chart"
      onPointerLeave={() => setHover(null)}
    >
      <svg
        viewBox={`0 0 ${width} 330`}
        role="img"
        tabIndex={0}
        aria-label="出口延迟图，使用左右方向键查看采样详情"
        onKeyDown={(e) => {
          if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) {
            e.preventDefault();
            select(
              e.key === "Home"
                ? 0
                : e.key === "End"
                  ? series.points.length - 1
                  : (hover ?? series.points.length - 1) +
                    (e.key === "ArrowLeft" ? -1 : 1),
            );
          }
        }}
        onPointerMove={(e) => {
          const box = e.currentTarget.getBoundingClientRect();
          const x = ((e.clientX - box.left) / box.width) * width;
          let nearest = 0;
          for (let i = 1; i < series.points.length; i++)
            if (
              Math.abs(chart.x(series.points[i].at) - x) <
              Math.abs(chart.x(series.points[nearest].at) - x)
            )
              nearest = i;
          select(nearest);
        }}
      >
        <defs>
          <linearGradient id={gradient} x1="0" x2="0" y1="0" y2="1">
            <stop stopColor="#38bdf8" stopOpacity=".2" />
            <stop offset="1" stopColor="#38bdf8" stopOpacity=".015" />
          </linearGradient>
        </defs>
        {[0, 1, 2, 3, 4].map((i) => (
          <g key={i}>
            <line
              x1={chart.left}
              x2={chart.right}
              y1={chart.y((chart.ceiling * i) / 4)}
              y2={chart.y((chart.ceiling * i) / 4)}
              stroke="#253345"
              strokeDasharray="3 5"
            />
            <text
              x={chart.left - 12}
              y={chart.y((chart.ceiling * i) / 4) + 4}
              textAnchor="end"
              fill="#8394aa"
              fontSize="11"
            >
              {Number(((chart.ceiling * i) / 4).toFixed(1))}
            </text>
          </g>
        ))}
        <text x={chart.left} y="14" fill="#8394aa" fontSize="11">
          延迟 / ms
        </text>
        {(width < 500 ? [0, 2, 4] : [0, 1, 2, 3, 4]).map((i) => (
          <g key={i}>
            <text
              x={chart.left + ((chart.right - chart.left) * i) / 4}
              y="285"
              textAnchor={i === 0 ? "start" : i === 4 ? "end" : "middle"}
              fill="#8394aa"
              fontSize="11"
            >
              {time(series.startAt + ((series.endAt - series.startAt) * i) / 4)}
            </text>
          </g>
        ))}
        {series.summary.avgMs != null && (
          <g>
            <line
              x1={chart.left}
              x2={chart.right}
              y1={chart.y(series.summary.avgMs)}
              y2={chart.y(series.summary.avgMs)}
              stroke="#94a3b8"
              strokeOpacity=".5"
              strokeDasharray="6 5"
            />
            <text
              x={chart.right}
              y={Math.max(15, chart.y(series.summary.avgMs) - 7)}
              textAnchor="end"
              fill="#a8b8ca"
              fontSize="11"
            >
              平均 {latency(series.summary.avgMs)} ms
            </text>
          </g>
        )}
        {chart.segments.map((segment, i) => (
          <g key={i}>
            <path
              d={`${chart.line(segment, "latencyMs")} L${chart.x(segment.at(-1)!.at)},${chart.bottom} L${chart.x(segment[0].at)},${chart.bottom} Z`}
              fill={`url(#${gradient})`}
            />
            <path
              d={`${chart.line(segment, "maxMs")} ${chart.line([...segment].reverse(), "minMs").replace(/^M/, "L")} Z`}
              fill="#38bdf8"
              fillOpacity=".16"
            />
            <path
              d={chart.line(segment, "latencyMs")}
              fill="none"
              stroke="#58cbff"
              strokeWidth="2.2"
              strokeLinejoin="round"
              strokeLinecap="round"
            />
            {segment.length === 1 && (
              <circle
                cx={chart.x(segment[0].at)}
                cy={chart.y(segment[0].latencyMs!)}
                r="3"
                fill="#58cbff"
              />
            )}
          </g>
        ))}
        <text
          x={chart.left - 12}
          y="311"
          textAnchor="end"
          fill="#8394aa"
          fontSize="10"
        >
          状态
        </text>
        <rect
          x={chart.left}
          y="301"
          width={chart.right - chart.left}
          height="12"
          rx="3"
          fill="#202c3c"
        />
        {series.points.map((p, i) => (
          <rect
            key={i}
            x={chart.x(p.at)}
            y="301"
            width={Math.max(
              1,
              chart.x(
                Math.min(
                  series.endAt,
                  series.points[i + 1]?.at ?? series.endAt,
                  p.at + series.bucketMs,
                ),
              ) - chart.x(p.at),
            )}
            height="12"
            rx="1"
            fill={p.lost ? "#fb7185" : p.unavailable ? "#e7b35d" : "#34d399"}
            fillOpacity={p.lost || p.unavailable ? 0.9 : 0.38}
          />
        ))}
        {point && (
          <g>
            <line
              x1={chart.x(point.at)}
              x2={chart.x(point.at)}
              y1={chart.top}
              y2="315"
              stroke="#e2e8f0"
              strokeOpacity=".6"
              strokeDasharray="3 3"
            />
            {point.latencyMs != null && (
              <circle
                cx={chart.x(point.at)}
                cy={chart.y(point.latencyMs)}
                r="4"
                stroke="#e0f2fe"
                strokeWidth="2"
                fill="#0ea5e9"
              />
            )}
          </g>
        )}
      </svg>
      {point && (
        <div
          className="eg-tooltip"
          role="status"
          style={{
            left: `${Math.max(2, Math.min(((width - 207) / width) * 100, mouseX - 12))}%`,
          }}
        >
          <strong>
            {new Date(point.at).toLocaleTimeString("zh-CN", { hour12: false })}
            {point.endAt !== point.at ? ` — ${time(point.endAt)}` : ""}
          </strong>
          <span>
            延迟 <b>{latency(point.latencyMs)} ms</b>
          </span>
          <span>
            范围{" "}
            <b>
              {latency(point.minMs)} — {latency(point.maxMs)} ms
            </b>
          </span>
          <span>
            成功 {point.received} · 丢包 {point.lost} · 未探测{" "}
            {point.unavailable}
          </span>
        </div>
      )}
    </div>
  );
}
