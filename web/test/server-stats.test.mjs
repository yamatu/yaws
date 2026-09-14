import test from "node:test";
import assert from "node:assert/strict";
import { formatUptime, usageLevel } from "../src/ui/serverStats.js";

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
