/**
 * Cashtag contract (X-style):
 * - token: $ + symbol
 * - symbol: 1–6 letters only (A-Z); digits/underscores are NOT valid (to avoid $100, $5B)
 * - stored and compared UPPERCASE without the '$'
 * - display parsing: '$' must not be preceded by a word char or '$' itself
 * - validation against the Ticker table happens in TickerService, not here
 */
export const CASHTAG_SYMBOL_RE_SOURCE = '[A-Za-z]{1,6}';
export const CASHTAG_IN_TEXT_DISPLAY_RE = new RegExp(
  `(?<![A-Za-z0-9_$])\\$(${CASHTAG_SYMBOL_RE_SOURCE})(?![A-Za-z0-9_])`,
  'g',
);

/**
 * Parse all $SYMBOL candidates from text, returning deduped UPPERCASE symbols.
 * Does NOT validate against the ticker universe — the caller must filter with TickerService.
 */
export function parseCashtagCandidatesFromText(text: string): string[] {
  const value = (text ?? '').toString();
  if (!value) return [];
  const out = new Set<string>();
  const re = new RegExp(CASHTAG_IN_TEXT_DISPLAY_RE.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(value))) {
    const sym = (m[1] ?? '').trim().toUpperCase();
    if (sym) out.add(sym);
  }
  return [...out];
}
