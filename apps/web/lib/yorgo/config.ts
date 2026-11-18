// Yorgo configuration: model names and prices are settings, not code (docs/yorgo/PLAN.md).
//   YORGO_MODEL_DEFAULT  everyday model (default claude-haiku-5-5)
//   YORGO_MODEL_HEAVY    photo reading and bulk clean-up only (default claude-sonnet-5-5)
//   YORGO_PRICES         optional JSON {"<model>": {"in":…, "out":…, "cacheRead":…, "cacheWrite":…}} in USD per million tokens,
//                        to follow a price change without a release. Defaults are the list prices checked on 2026-11-18.
export type Price = { in: number; out: number; cacheRead: number; cacheWrite: number };
export type Usage = { input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_tokens: number };

const DEFAULT_PRICES: Record<string, Price> = {
  'claude-haiku-5-5': { in: 0.10, out: 0.50, cacheRead: 0.01, cacheWrite: 0.125 },
  'claude-sonnet-5-5': { in: 2, out: 10, cacheRead: 0.10, cacheWrite: 2.5 },
};

export type YorgoConfig = { modelDefault: string; modelHeavy: string; prices: Record<string, Price>; maxTokens: number; maxToolRounds: number; maxMessageChars: number };

export function yorgoConfig(env: Record<string, string | undefined> = process.env): YorgoConfig {
  let extra: Record<string, Price> = {};
  try { extra = env.YORGO_PRICES ? JSON.parse(env.YORGO_PRICES) : {}; } catch { extra = {}; }
  return {
    modelDefault: env.YORGO_MODEL_DEFAULT || 'claude-haiku-5-5',
    modelHeavy: env.YORGO_MODEL_HEAVY || 'claude-sonnet-5-5',
    prices: { ...DEFAULT_PRICES, ...extra },
    maxTokens: 1024,          // an answer is a few lines or a draft, never an essay
    maxToolRounds: 4,         // model → tools → model …, then it must answer
    maxMessageChars: 2000,
  };
}

/** Cost estimate in USD. A model without a price is charged at the dearest known one: the caps must never under-count. */
export function costOf(model: string, u: Usage, prices: Record<string, Price>): number {
  const p = prices[model] ?? Object.values(prices).reduce((a, b) => (b.out > a.out ? b : a));
  const usd = (u.input_tokens * p.in + u.output_tokens * p.out + u.cache_read_tokens * p.cacheRead + u.cache_write_tokens * p.cacheWrite) / 1_000_000;
  return Math.round(usd * 1e6) / 1e6;
}
