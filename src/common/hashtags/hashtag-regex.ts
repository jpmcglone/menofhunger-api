/**
 * Hashtag contract (intentionally simple, X-like):
 * - token: # + tag
 * - tag: starts with a letter, then letters/numbers/underscore
 * - stored lowercase without the '#'
 * - display parsing: '#' must not be preceded by a word char (avoid matching mid-word)
 */
export const HASHTAG_TAG_RE_SOURCE = '[A-Za-z][A-Za-z0-9_]{0,49}';
export const HASHTAG_IN_TEXT_RE = new RegExp(`#(${HASHTAG_TAG_RE_SOURCE})`, 'g');
export const HASHTAG_IN_TEXT_DISPLAY_RE = new RegExp(`(?<![a-zA-Z0-9_])#(${HASHTAG_TAG_RE_SOURCE})`, 'g');

export type HashtagToken = { tag: string; variant: string };

export function parseHashtagsFromText(text: string): string[] {
  const value = (text ?? '').toString();
  if (!value) return [];
  const out = new Set<string>();
  // Display-safe parsing: '#' must not be preceded by a word char.
  const re = new RegExp(HASHTAG_IN_TEXT_DISPLAY_RE.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(value))) {
    const tag = (m[1] ?? '').trim().toLowerCase();
    if (tag) out.add(tag);
  }
  return [...out];
}

/**
 * Parse hashtag tokens with casing variants.
 * Returns one entry per unique lowercase tag, choosing the most frequent casing variant in the text.
 */
export function parseHashtagTokensFromText(text: string): HashtagToken[] {
  const value = (text ?? '').toString();
  if (!value) return [];

  const byLower = new Map<string, Map<string, number>>();
  const firstSeen = new Map<string, string>();

  const re = new RegExp(HASHTAG_IN_TEXT_DISPLAY_RE.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(value))) {
    const raw = (m[1] ?? '').trim();
    if (!raw) continue;
    const lower = raw.toLowerCase();
    if (!firstSeen.has(lower)) firstSeen.set(lower, raw);
    let variants = byLower.get(lower);
    if (!variants) {
      variants = new Map<string, number>();
      byLower.set(lower, variants);
    }
    variants.set(raw, (variants.get(raw) ?? 0) + 1);
  }

  const out: HashtagToken[] = [];
  for (const [lower, variants] of byLower) {
    let best = firstSeen.get(lower) ?? lower;
    let bestCount = -1;
    for (const [variant, count] of variants) {
      if (count > bestCount) {
        best = variant;
        bestCount = count;
      }
    }
    out.push({ tag: lower, variant: best });
  }
  return out;
}

