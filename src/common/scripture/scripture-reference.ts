/**
 * Scripture reference parsing and canonicalization.
 *
 * Matches:
 * - `Book Chapter:Verse` with optional range (`John 3:16`, `1 Cor 13:4-7`)
 * - comma lists in the same chapter (`Eph 2:1,8`)
 * - chapter-only refs (`Rom 9`, `Psalm 23`) when they look like citations,
 *   not prose (`Job 1`, `I am 1`)
 *
 * Book table kept in sync with:
 * - `menofhunger-www/utils/scripture-reference.ts`
 * - `menofhunger-ios/MenOfHunger/Domain/Shared/Text/ScriptureReferenceParser.swift`
 */

export type ScriptureVerseSpan = {
  start: number;
  end: number | null;
};

export type ScriptureRef = {
  /** Canonical display form, e.g. "John 3:16", "Ephesians 2:1,8", or "Romans 9". */
  reference: string;
  /** bible.helloao.org book ID, e.g. "JHN". */
  bookId: string;
  /** Canonical book name, e.g. "John". */
  book: string;
  chapter: number;
  /** null = entire chapter */
  verseStart: number | null;
  verseEnd: number | null;
  extraVerses: ScriptureVerseSpan[];
};

type BookEntry = {
  name: string;
  /** Lowercase aliases (no regex metacharacters). */
  aliases: string[];
  /** bible.helloao.org book ID. */
  apiId: string;
};

/* eslint-disable @typescript-eslint/no-unused-vars */
export const BOOKS: BookEntry[] = [
  // ── Old Testament ──────────────────────────────────────────────────────────
  { name: 'Genesis',          aliases: ['gen', 'ge'],                                  apiId: 'GEN' },
  { name: 'Exodus',           aliases: ['exod', 'exo', 'ex'],                          apiId: 'EXO' },
  { name: 'Leviticus',        aliases: ['lev', 'le'],                                  apiId: 'LEV' },
  { name: 'Numbers',          aliases: ['num', 'nu', 'nm'],                            apiId: 'NUM' },
  { name: 'Deuteronomy',      aliases: ['deut', 'deu', 'dt'],                          apiId: 'DEU' },
  { name: 'Joshua',           aliases: ['josh', 'jos'],                                apiId: 'JOS' },
  { name: 'Judges',           aliases: ['judg', 'jdg'],                                apiId: 'JDG' },
  { name: 'Ruth',             aliases: ['ru'],                                         apiId: 'RUT' },
  { name: '1 Samuel',         aliases: ['1 sam', '1sam', '1sa'],                       apiId: '1SA' },
  { name: '2 Samuel',         aliases: ['2 sam', '2sam', '2sa'],                       apiId: '2SA' },
  { name: '1 Kings',          aliases: ['1 kgs', '1kgs', '1ki'],                       apiId: '1KI' },
  { name: '2 Kings',          aliases: ['2 kgs', '2kgs', '2ki'],                       apiId: '2KI' },
  { name: '1 Chronicles',     aliases: ['1 chron', '1chron', '1 chr', '1chr', '1ch'], apiId: '1CH' },
  { name: '2 Chronicles',     aliases: ['2 chron', '2chron', '2 chr', '2chr', '2ch'], apiId: '2CH' },
  { name: 'Ezra',             aliases: ['ezr'],                                        apiId: 'EZR' },
  { name: 'Nehemiah',         aliases: ['neh', 'ne'],                                  apiId: 'NEH' },
  { name: 'Esther',           aliases: ['esth', 'est'],                                apiId: 'EST' },
  { name: 'Job',              aliases: [],                                             apiId: 'JOB' },
  { name: 'Psalms',           aliases: ['psalm', 'psa', 'ps'],                         apiId: 'PSA' },
  { name: 'Proverbs',         aliases: ['prov', 'pro', 'pr'],                          apiId: 'PRO' },
  { name: 'Ecclesiastes',     aliases: ['eccl', 'ecc', 'qoh'],                         apiId: 'ECC' },
  { name: 'Song of Solomon',  aliases: ['song', 'sos', 'ss', 'cant'],                  apiId: 'SNG' },
  { name: 'Isaiah',           aliases: ['isa'],                                        apiId: 'ISA' },
  { name: 'Jeremiah',         aliases: ['jer', 'je'],                                  apiId: 'JER' },
  { name: 'Lamentations',     aliases: ['lam', 'la'],                                  apiId: 'LAM' },
  { name: 'Ezekiel',          aliases: ['ezek', 'eze'],                                apiId: 'EZK' },
  { name: 'Daniel',           aliases: ['dan', 'da'],                                  apiId: 'DAN' },
  { name: 'Hosea',            aliases: ['hos', 'ho'],                                  apiId: 'HOS' },
  { name: 'Joel',             aliases: [],                                             apiId: 'JOL' },
  { name: 'Amos',             aliases: ['am'],                                         apiId: 'AMO' },
  { name: 'Obadiah',          aliases: ['obad', 'ob'],                                 apiId: 'OBA' },
  { name: 'Jonah',            aliases: ['jon'],                                        apiId: 'JON' },
  { name: 'Micah',            aliases: ['mic', 'mi'],                                  apiId: 'MIC' },
  { name: 'Nahum',            aliases: ['nah', 'na'],                                  apiId: 'NAM' },
  { name: 'Habakkuk',         aliases: ['hab'],                                        apiId: 'HAB' },
  { name: 'Zephaniah',        aliases: ['zeph', 'zep'],                                apiId: 'ZEP' },
  { name: 'Haggai',           aliases: ['hag'],                                        apiId: 'HAG' },
  { name: 'Zechariah',        aliases: ['zech', 'zec'],                                apiId: 'ZEC' },
  { name: 'Malachi',          aliases: ['mal'],                                        apiId: 'MAL' },
  // ── New Testament ──────────────────────────────────────────────────────────
  { name: 'Matthew',          aliases: ['matt', 'mt'],                                 apiId: 'MAT' },
  { name: 'Mark',             aliases: ['mk', 'mc'],                                   apiId: 'MRK' },
  { name: 'Luke',             aliases: ['lk'],                                         apiId: 'LUK' },
  { name: 'John',             aliases: ['jn', 'jhn'],                                  apiId: 'JHN' },
  { name: 'Acts',             aliases: ['ac'],                                          apiId: 'ACT' },
  { name: 'Romans',           aliases: ['rom', 'ro', 'rm'],                            apiId: 'ROM' },
  { name: '1 Corinthians',    aliases: ['1 cor', '1cor', '1co'],                       apiId: '1CO' },
  { name: '2 Corinthians',    aliases: ['2 cor', '2cor', '2co'],                       apiId: '2CO' },
  { name: 'Galatians',        aliases: ['gal', 'ga'],                                  apiId: 'GAL' },
  { name: 'Ephesians',        aliases: ['eph'],                                        apiId: 'EPH' },
  { name: 'Philippians',      aliases: ['phil', 'php', 'pp'],                          apiId: 'PHP' },
  { name: 'Colossians',       aliases: ['col'],                                        apiId: 'COL' },
  { name: '1 Thessalonians',  aliases: ['1 thess', '1thess', '1th'],                   apiId: '1TH' },
  { name: '2 Thessalonians',  aliases: ['2 thess', '2thess', '2th'],                   apiId: '2TH' },
  { name: '1 Timothy',        aliases: ['1 tim', '1tim', '1ti'],                       apiId: '1TI' },
  { name: '2 Timothy',        aliases: ['2 tim', '2tim', '2ti'],                       apiId: '2TI' },
  { name: 'Titus',            aliases: ['tit'],                                        apiId: 'TIT' },
  { name: 'Philemon',         aliases: ['philem', 'phlm', 'phm'],                      apiId: 'PHM' },
  { name: 'Hebrews',          aliases: ['heb'],                                        apiId: 'HEB' },
  { name: 'James',            aliases: ['jas', 'jm'],                                  apiId: 'JAS' },
  { name: '1 Peter',          aliases: ['1 pet', '1pet', '1pe'],                       apiId: '1PE' },
  { name: '2 Peter',          aliases: ['2 pet', '2pet', '2pe'],                       apiId: '2PE' },
  { name: '1 John',           aliases: ['1 john', '1john', '1jn', '1jo'],              apiId: '1JN' },
  { name: '2 John',           aliases: ['2 john', '2john', '2jn', '2jo'],              apiId: '2JN' },
  { name: '3 John',           aliases: ['3 john', '3john', '3jn', '3jo'],              apiId: '3JN' },
  { name: 'Jude',             aliases: ['jud'],                                        apiId: 'JUD' },
  { name: 'Revelation',       aliases: ['rev', 're'],                                  apiId: 'REV' },
];
/* eslint-enable @typescript-eslint/no-unused-vars */

// ─── Lookup map ──────────────────────────────────────────────────────────────

const _bookLookup = new Map<string, BookEntry>();
for (const book of BOOKS) {
  _bookLookup.set(book.name.toLowerCase(), book);
  for (const alias of book.aliases) {
    _bookLookup.set(alias.toLowerCase(), book);
  }
}

/** Escape a string for use as a literal in a regex. */
function regexEsc(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildBookPattern(): string {
  const parts: string[] = [];
  for (const book of BOOKS) {
    parts.push(regexEsc(book.name));
    for (const alias of book.aliases) {
      parts.push(regexEsc(alias));
    }
  }
  // Longest-first prevents short aliases from shadowing longer canonical names.
  parts.sort((a, b) => b.length - a.length || a.localeCompare(b));
  return parts.join('|');
}

const BOOK_ALT = buildBookPattern();

/**
 * Matches a scripture reference in running text.
 *
 * Capture groups:
 *   1 — book name or abbreviation as written
 *   2 — chapter number (1–3 digits)
 *   3 — optional verse spec (`16`, `16-18`, `1,8`, `1-3,8`)
 */
export const SCRIPTURE_IN_TEXT_RE = new RegExp(
  `(?<![A-Za-z0-9])(${BOOK_ALT})\\.?\\s+(\\d{1,3})(?::(\\d{1,3}(?:\\s*-\\s*\\d{1,3})?(?:\\s*,\\s*\\d{1,3}(?:\\s*-\\s*\\d{1,3})?)*))?(?![A-Za-z0-9:])`,
  'gi',
);

/** Full names that are also common English words/names — chapter-only only in citation context. */
const AMBIGUOUS_CHAPTER_ONLY = new Set([
  'job',
  'mark',
  'john',
  'luke',
  'james',
  'ruth',
  'amos',
  'jude',
  'numbers',
  'song',
  'song of solomon',
]);

export function parseVerseSpec(spec: string | undefined): ScriptureVerseSpan[] | null {
  if (!spec) return null;
  const spans: ScriptureVerseSpan[] = [];
  for (const part of spec.split(/\s*,\s*/)) {
    const bits = part.split(/\s*-\s*/);
    const start = parseInt(bits[0] ?? '', 10);
    if (!Number.isFinite(start)) continue;
    const endRaw = bits[1] !== undefined ? parseInt(bits[1], 10) : null;
    spans.push({ start, end: endRaw !== null && Number.isFinite(endRaw) ? endRaw : null });
  }
  return spans.length ? spans : null;
}

export function formatScriptureReference(
  book: string,
  chapter: number,
  spans: ScriptureVerseSpan[] | null,
): string {
  if (!spans?.length) return `${book} ${chapter}`;
  const body = spans.map((s) => (s.end != null ? `${s.start}-${s.end}` : String(s.start))).join(',');
  return `${book} ${chapter}:${body}`;
}

export function isCitationContext(text: string, start: number, end: number): boolean {
  const before = text.slice(0, start).trimEnd();
  const prev = before.charAt(before.length - 1);
  if (prev === '(' || prev === ';' || prev === '[' || prev === ',') return true;
  const after = text.slice(end).trimStart();
  const next = after.charAt(0);
  return next === ')' || next === ';' || next === ']' || next === ',' || next === '.';
}

export function acceptChapterOnly(
  bookToken: string,
  canonicalName: string,
  text: string,
  start: number,
  end: number,
): boolean {
  if (isCitationContext(text, start, end)) return true;
  const token = bookToken.trim().toLowerCase();
  const compact = token.replace(/\s+/g, '');
  if (token === 'ps' || token === 'psa' || token === 'psalm' || token === 'psalms') return true;
  if (AMBIGUOUS_CHAPTER_ONLY.has(token) || AMBIGUOUS_CHAPTER_ONLY.has(canonicalName.toLowerCase())) {
    return false;
  }
  const isAlias = token !== canonicalName.toLowerCase();
  if (isAlias && compact.length >= 3) return true;
  return !isAlias;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/** Look up a book entry by any case-insensitive name or abbreviation. */
export function lookupBook(bookStr: string): BookEntry | undefined {
  return _bookLookup.get(bookStr.trim().toLowerCase());
}

/** Parse all scripture references in a string. */
export function parseScriptureRefs(text: string): ScriptureRef[] {
  if (!text) return [];
  const re = new RegExp(SCRIPTURE_IN_TEXT_RE.source, SCRIPTURE_IN_TEXT_RE.flags);
  const refs: ScriptureRef[] = [];
  for (const m of text.matchAll(re)) {
    const entry = lookupBook(m[1]);
    if (!entry) continue;
    const raw = m[0];
    const start = m.index ?? 0;
    const spans = parseVerseSpec(m[3]);
    if (!spans && !acceptChapterOnly(m[1], entry.name, text, start, start + raw.length)) {
      continue;
    }
    const chapter = parseInt(m[2], 10);
    const first = spans?.[0];
    refs.push({
      reference: formatScriptureReference(entry.name, chapter, spans),
      bookId: entry.apiId,
      book: entry.name,
      chapter,
      verseStart: first?.start ?? null,
      verseEnd: first?.end ?? null,
      extraVerses: spans?.slice(1) ?? [],
    });
  }
  return refs;
}

/** Parse unique canonical reference strings from a body. */
export function parseScriptureRefsFromBody(body: string): string[] {
  return [...new Set(parseScriptureRefs(body).map((r) => r.reference))];
}
