/**
 * Canonical OpenAI model names for M.A.R.V.
 *
 * This is the single source of truth for model identifiers. Import from here
 * instead of hardcoding strings so that a model rename is a one-line change.
 *
 * These are the fallback defaults used when the corresponding
 * OPENAI_MARV_*_MODEL environment variable is not set.
 */
export const MARV_DEFAULT_FAST_MODEL = 'gpt-5.4-nano';
export const MARV_DEFAULT_REGULAR_MODEL = 'gpt-5.4-mini';
export const MARV_DEFAULT_SMART_MODEL = 'gpt-5.5';

/** All three defaults as a tuple — useful for iterating or building rate maps. */
export const MARV_DEFAULT_MODELS = [
  MARV_DEFAULT_FAST_MODEL,
  MARV_DEFAULT_REGULAR_MODEL,
  MARV_DEFAULT_SMART_MODEL,
] as const;
