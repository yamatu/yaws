import assert from "node:assert/strict";
import test from "node:test";

import { cacheStats } from "../src/ui/aiUsage.ts";

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
