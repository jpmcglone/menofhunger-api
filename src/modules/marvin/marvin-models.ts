/**
 * Canonical OpenAI model names for M.A.R.V.
 *
 * This is the single source of truth for model identifiers. Import from here
 * instead of hardcoding strings so that a model rename is a one-line change.
 *
 * These are the fallback defaults used when the corresponding
 * OPENAI_MARV_*_MODEL environment variable is not set.
 *
 * GPT-5.6 family (OpenAI, 2026): Luna ≈ former nano, Terra ≈ former mini,
 * Sol ≈ former unsuffixed / GPT-5.5. All three share a 1.05M context window
 * and 128K max output; Marv still caps `max_output_tokens` in config.
 */
export const MARV_DEFAULT_FAST_MODEL = 'gpt-5.6-luna';
export const MARV_DEFAULT_REGULAR_MODEL = 'gpt-5.6-terra';
export const MARV_DEFAULT_SMART_MODEL = 'gpt-5.6-sol';

/** All three defaults as a tuple — useful for iterating or building rate maps. */
export const MARV_DEFAULT_MODELS = [
  MARV_DEFAULT_FAST_MODEL,
  MARV_DEFAULT_REGULAR_MODEL,
  MARV_DEFAULT_SMART_MODEL,
] as const;

/**
 * Per-1M-token USD rates for cost estimation (OpenAI standard short-context,
 * verified against developers.openai.com/api/docs/models/gpt-5.6-* in Sep 2026).
 * Sol's $4/$20 is promotional through at least 2026-11-21.
 *
 * Legacy 5.4/5.5 rows stay so a deploy that still overrides the env vars
 * continues to estimate spend instead of writing null.
 */
export const MARV_MODEL_RATES_USD_PER_M_TOKENS: Record<
  string,
  { input: number; output: number; cached?: number }
> = {
  [MARV_DEFAULT_FAST_MODEL]: { input: 0.2, output: 1.2, cached: 0.02 },
  [MARV_DEFAULT_REGULAR_MODEL]: { input: 2, output: 12, cached: 0.2 },
  [MARV_DEFAULT_SMART_MODEL]: { input: 4, output: 20, cached: 0.4 },
  'gpt-5.4-nano': { input: 0.05, output: 0.4, cached: 0.005 },
  'gpt-5.4-mini': { input: 1.25, output: 10, cached: 0.125 },
  'gpt-5.5': { input: 5, output: 30, cached: 0.5 },
};
