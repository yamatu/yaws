import test from "node:test";
import assert from "node:assert/strict";
import { formatUptime, fractionLevel, meterValue, usageLevel } from "../src/ui/serverStats.js";

test("uptime is rendered in chinese units", () => {
  assert.equal(formatUptime(86400.5), "1 天 0 小时");
  assert.equal(formatUptime(90061), "1 天 1 小时");
  assert.equal(formatUptime(3660), "1 小时 1 分");
  assert.equal(formatUptime(300), "5 分");
  assert.equal(formatUptime(42), "42 秒");
  assert.equal(formatUptime(0), "0 秒");
  assert.equal(formatUptime(null), "—");
  assert.equal(formatUptime(undefined), "—");
  assert.equal(formatUptime(Number.NaN), "—");
  assert.equal(formatUptime(-5), "—");
});

test("usage levels flag full and nearly full resources", () => {
  assert.equal(usageLevel(0), "ok");
  assert.equal(usageLevel(74.9), "ok");
  assert.equal(usageLevel(75), "warn");
  assert.equal(usageLevel(89.9), "warn");
  assert.equal(usageLevel(90), "high");
  assert.equal(usageLevel(100), "high");
  assert.equal(usageLevel(null), "unknown");
  assert.equal(usageLevel(undefined), "unknown");
  assert.equal(usageLevel(Number.NaN), "unknown");
});

test("meter values turn 0..1 fractions into percentages", () => {
  assert.equal(meterValue(0), 0);
  assert.equal(meterValue(0.3333), 33);
  assert.equal(meterValue(0.335), 34);
  assert.equal(meterValue(0.69), 69);
  assert.equal(meterValue(1), 100);
  // Out-of-range fractions are clamped, never rendered as a >100% bar.
  assert.equal(meterValue(1.4), 100);
  assert.equal(meterValue(-0.2), 0);
  assert.equal(meterValue(null), null);
  assert.equal(meterValue(undefined), null);
  assert.equal(meterValue(Number.NaN), null);
});

test("meter levels use the same thresholds as percentage meters", () => {
  // The level follows the *displayed* percentage, so the number and the colour
  // never disagree (74.6% renders as 75% and therefore turns yellow).
  assert.equal(fractionLevel(0.1), "ok");
  assert.equal(fractionLevel(0.74), "ok");
  assert.equal(fractionLevel(0.746), "warn");
  assert.equal(fractionLevel(0.75), "warn");
  assert.equal(fractionLevel(0.89), "warn");
  assert.equal(fractionLevel(0.896), "high");
  assert.equal(fractionLevel(0.9), "high");
  assert.equal(fractionLevel(1), "high");
  assert.equal(fractionLevel(null), "unknown");
  assert.equal(fractionLevel(undefined), "unknown");
  assert.equal(fractionLevel(Number.NaN), "unknown");
});
