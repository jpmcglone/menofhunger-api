export type HashtagResultDto = {
  /** Canonical lowercase tag value (no '#'). */
  value: string;
  /** Display label (most common casing). */
  label: string;
  /** Recent usage count (within the trending window) or overall usage count (for autocomplete). */
  usageCount: number;
};

