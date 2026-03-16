export const APP_FEATURE_TOGGLES = [] as const;

export type AppFeatureToggle = (typeof APP_FEATURE_TOGGLES)[number];

export function sanitizeFeatureToggles(input: readonly string[] | null | undefined): AppFeatureToggle[] {
  if (!Array.isArray(input) || input.length === 0) return [];
  const allowed = new Set<AppFeatureToggle>(APP_FEATURE_TOGGLES);
  const out: AppFeatureToggle[] = [];
  for (const raw of input) {
    const value = String(raw ?? '').trim() as AppFeatureToggle;
    if (!value || !allowed.has(value) || out.includes(value)) continue;
    out.push(value);
  }
  return out;
}
