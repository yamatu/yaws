/** Token usage of one answer, as reported by the model provider. */
export type Usage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Cached share of the prompt; null/undefined when the provider stays quiet. */
  cachedTokens?: number | null;
};

export type CacheStats = {
  /** Prompt tokens the provider served from its cache. */
  cached: number;
  /** Prompt tokens this turn was billed for. */
  prompt: number;
  /** Whole percent of the prompt that came from the cache. */
  rate: number;
};

/**
 * A counted total, short enough for one line: exact below a thousand, then one
 * decimal of `k`, then whole thousands, then millions. A conversation that has
 * been going for a while reaches hundreds of thousands, which is unreadable
 * spelled out.
 */
export function formatTokens(count: number): string {
  const value = Number(count) || 0;
  if (value < 1000) return String(value);
  if (value < 10000) return `${(value / 1000).toFixed(1)}k`;
  if (value < 1000000) return `${Math.round(value / 1000)}k`;
  if (value < 10000000) return `${(value / 1000000).toFixed(1)}M`;
  return `${Math.round(value / 1000000)}M`;
}

/**
 * The cache hit rate of a turn, or null when there is nothing honest to show:
 * either the provider never reports caching (so a 0 would be a lie), or it
 * reports a cached count without the prompt size to measure it against.
 */
export function cacheStats(usage: Usage | null | undefined): CacheStats | null {
  if (!usage) return null;
  const { cachedTokens } = usage;
  if (cachedTokens === null || cachedTokens === undefined) return null;
  const cached = Number(cachedTokens);
  const prompt = Number(usage.promptTokens) || 0;
  if (!Number.isFinite(cached) || cached < 0 || prompt <= 0) return null;
  return { cached, prompt, rate: Math.round((cached / prompt) * 100) };
}
