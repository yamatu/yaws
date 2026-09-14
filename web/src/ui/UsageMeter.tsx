import type { UsageLevel } from "./serverStats";

/**
 * Usage bar shared by the home page, the machine pages and the public pages.
 *
 * The colour comes from the level (green = low, yellow from 75%, red from 90%,
 * grey = unknown) instead of a fixed gradient, and the fill is drawn as frosted
 * glass (see `.yaws-meter` in styles.css). The level is passed in because the
 * caller renders the same percentage next to the bar and must agree with it.
 */
export function UsageMeter({
  percent,
  level,
  label,
}: {
  percent: number | null;
  level: UsageLevel;
  label: string;
}) {
  return (
    <div
      className={`yaws-meter level-${level}`}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent ?? 0}
      aria-valuetext={percent == null ? "暂无数据" : `${percent}%`}
    >
      <div style={{ width: `${percent ?? 0}%` }} />
    </div>
  );
}
