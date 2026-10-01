import assert from "node:assert/strict";
import test from "node:test";

import { cacheStats, formatTokens } from "../src/ui/aiUsage.ts";

const usage = (extra = {}) => ({
  promptTokens: 100,
  completionTokens: 20,
  totalTokens: 120,
  ...extra,
});

test("a reported cache yields the hit rate of the prompt", () => {
  assert.deepEqual(cacheStats(usage({ cachedTokens: 25 })), {
    cached: 25,
    prompt: 100,
    rate: 25,
  });
  // Chat and responses providers report cached tokens as a plain number.
  assert.equal(cacheStats(usage({ cachedTokens: 100 })).rate, 100);
  assert.equal(cacheStats(usage({ cachedTokens: 1 })).rate, 1);
});

test("the rate is rounded to whole percent", () => {
  assert.equal(cacheStats(usage({ cachedTokens: 12 })).rate, 12);
  assert.equal(cacheStats(usage({ promptTokens: 21, cachedTokens: 12 })).rate, 57);
  assert.equal(cacheStats(usage({ promptTokens: 3, cachedTokens: 1 })).rate, 33);
});

test("a cold cache is shown as zero, not hidden", () => {
  // Reporting 0 is a real answer from the provider, so it must survive the
  // null/undefined gate and render as 0%.
  assert.deepEqual(cacheStats(usage({ cachedTokens: 0 })), {
    cached: 0,
    prompt: 100,
    rate: 0,
  });
});

test("a provider that never reports caching is hidden", () => {
  assert.equal(cacheStats(usage()), null);
  assert.equal(cacheStats(usage({ cachedTokens: null })), null);
  assert.equal(cacheStats(usage({ cachedTokens: undefined })), null);
  assert.equal(cacheStats(null), null);
  assert.equal(cacheStats(undefined), null);
});

test("nothing is shown without a prompt to measure against", () => {
  assert.equal(cacheStats(usage({ promptTokens: 0, cachedTokens: 12 })), null);
  assert.equal(cacheStats({ totalTokens: 9, cachedTokens: 4 }), null);
});

test("garbage counts do not produce a rate", () => {
  assert.equal(cacheStats(usage({ cachedTokens: -1 })), null);
  assert.equal(cacheStats(usage({ cachedTokens: Number.NaN })), null);
  assert.equal(cacheStats(usage({ cachedTokens: "many" })), null);
});

test("running totals stay short enough for one line", () => {
  assert.equal(formatTokens(0), "0");
  assert.equal(formatTokens(29), "29");
  assert.equal(formatTokens(999), "999");
  assert.equal(formatTokens(1000), "1.0k");
  assert.equal(formatTokens(1500), "1.5k");
  assert.equal(formatTokens(9999), "10.0k");
  assert.equal(formatTokens(10000), "10k");
  assert.equal(formatTokens(150000), "150k");
  assert.equal(formatTokens(1500000), "1.5M");
  assert.equal(formatTokens(15000000), "15M");
  // A missing count reads as zero rather than as NaN on the page.
  assert.equal(formatTokens(Number.NaN), "0");
  assert.equal(formatTokens(undefined), "0");
});
