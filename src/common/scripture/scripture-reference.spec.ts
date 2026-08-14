import { parseScriptureRefs, parseScriptureRefsFromBody } from './scripture-reference';

describe('parseScriptureRefs', () => {
  // ── Basic matches ──────────────────────────────────────────────────────────

  it('matches a canonical full name', () => {
    const [ref] = parseScriptureRefs('John 3:16 is well known');
    expect(ref.reference).toBe('John 3:16');
    expect(ref.bookId).toBe('JHN');
    expect(ref.chapter).toBe(3);
    expect(ref.verseStart).toBe(16);
    expect(ref.verseEnd).toBeNull();
  });

  it('matches a common abbreviation', () => {
    const [ref] = parseScriptureRefs('Jn 3:16');
    expect(ref.reference).toBe('John 3:16');
    expect(ref.bookId).toBe('JHN');
  });

  it('matches a numbered book with space', () => {
    const [ref] = parseScriptureRefs('1 Cor 13:4');
    expect(ref.reference).toBe('1 Corinthians 13:4');
    expect(ref.bookId).toBe('1CO');
  });

  it('matches a compact numbered abbreviation', () => {
    const [ref] = parseScriptureRefs('2Ti 3:16');
    expect(ref.reference).toBe('2 Timothy 3:16');
    expect(ref.bookId).toBe('2TI');
  });

  it('matches a verse range', () => {
    const [ref] = parseScriptureRefs('John 3:16-18 says...');
    expect(ref.reference).toBe('John 3:16-18');
    expect(ref.verseStart).toBe(16);
    expect(ref.verseEnd).toBe(18);
  });

  it('matches comma-separated verses in one chapter', () => {
    const [ref] = parseScriptureRefs('Eph 2:1,8');
    expect(ref.reference).toBe('Ephesians 2:1,8');
    expect(ref.verseStart).toBe(1);
    expect(ref.verseEnd).toBeNull();
    expect(ref.extraVerses).toEqual([{ start: 8, end: null }]);
  });

  it('matches chapter-only abbreviations like Rom 9', () => {
    const [ref] = parseScriptureRefs('see Rom 9 for election');
    expect(ref.reference).toBe('Romans 9');
    expect(ref.chapter).toBe(9);
    expect(ref.verseStart).toBeNull();
  });

  it('matches chapter-only inside a citation list', () => {
    const refs = parseScriptureRefs('(Eph 2:1,8; John 6:44; Acts 13:48; Rom 9)');
    expect(refs.map((r) => r.reference)).toEqual([
      'Ephesians 2:1,8',
      'John 6:44',
      'Acts 13:48',
      'Romans 9',
    ]);
  });

  it('matches Psalm 23 as a whole-psalm citation', () => {
    const [ref] = parseScriptureRefs('Pray Psalm 23');
    expect(ref.reference).toBe('Psalms 23');
    expect(ref.verseStart).toBeNull();
  });

  it('matches a period after the book abbreviation', () => {
    const [ref] = parseScriptureRefs('Rom. 8:28');
    expect(ref.reference).toBe('Romans 8:28');
  });

  it('matches multiple refs in one string', () => {
    const refs = parseScriptureRefs('Romans 8:28 and Phil 4:13 are great');
    expect(refs).toHaveLength(2);
    expect(refs[0].reference).toBe('Romans 8:28');
    expect(refs[1].reference).toBe('Philippians 4:13');
  });

  it('matches Psalms abbreviation', () => {
    const [ref] = parseScriptureRefs('Ps 23:1');
    expect(ref.reference).toBe('Psalms 23:1');
    expect(ref.bookId).toBe('PSA');
  });

  it('matches Song of Solomon', () => {
    const [ref] = parseScriptureRefs('Song of Solomon 2:4');
    expect(ref.reference).toBe('Song of Solomon 2:4');
    expect(ref.bookId).toBe('SNG');
  });

  it('matches Genesis full name', () => {
    const [ref] = parseScriptureRefs('In the beginning — Genesis 1:1 says it all.');
    expect(ref.reference).toBe('Genesis 1:1');
  });

  it('canonicalizes the reference regardless of input case', () => {
    const [ref] = parseScriptureRefs('JOHN 3:16');
    expect(ref.reference).toBe('John 3:16');
    expect(ref.bookId).toBe('JHN');
  });

  it('canonicalizes abbreviated input', () => {
    const [ref] = parseScriptureRefs('rom 8:28');
    expect(ref.reference).toBe('Romans 8:28');
  });

  it('matches Revelation abbreviation', () => {
    const [ref] = parseScriptureRefs('Rev 22:13');
    expect(ref.reference).toBe('Revelation 22:13');
    expect(ref.bookId).toBe('REV');
  });

  it('matches Philippians via phil alias', () => {
    const [ref] = parseScriptureRefs('Phil 4:6-7');
    expect(ref.reference).toBe('Philippians 4:6-7');
  });

  it('matches Philemon via philem alias', () => {
    const [ref] = parseScriptureRefs('Philem 1:10');
    expect(ref.reference).toBe('Philemon 1:10');
    expect(ref.bookId).toBe('PHM');
  });

  it('matches Hebrews 11:1', () => {
    const [ref] = parseScriptureRefs('Heb 11:1');
    expect(ref.reference).toBe('Hebrews 11:1');
  });

  // ── Non-matches (false positive prevention) ────────────────────────────────

  it('matches unambiguous full-name chapter-only refs', () => {
    const [ref] = parseScriptureRefs('Genesis 1');
    expect(ref.reference).toBe('Genesis 1');
    expect(ref.verseStart).toBeNull();
  });

  it('does NOT match ambiguous name + number in running prose', () => {
    expect(parseScriptureRefs('Job 1')).toHaveLength(0);
    expect(parseScriptureRefs('John 3 is coming over')).toHaveLength(0);
  });

  it('does match ambiguous names when they sit in a citation list', () => {
    const refs = parseScriptureRefs('(Job 1; John 3)');
    expect(refs.map((r) => r.reference)).toEqual(['Job 1', 'John 3']);
  });

  it('does NOT match a bare time', () => {
    expect(parseScriptureRefs('The meeting is at 3:16 pm')).toHaveLength(0);
  });

  it('does NOT match a misspelled book', () => {
    expect(parseScriptureRefs('Room 3:16')).toHaveLength(0);
  });

  it('does NOT match "John" inside a longer word like "Johnson"', () => {
    // "Johnson 3:16" — John is followed by "son", not whitespace+chapter
    expect(parseScriptureRefs('Johnson 3:16')).toHaveLength(0);
  });

  it('does NOT match when book immediately follows another word character', () => {
    // "aJohn 3:16" — "J" is preceded by "a"
    expect(parseScriptureRefs('aJohn 3:16')).toHaveLength(0);
  });

  it('does NOT match Amos via the "am" alias in ordinary prose', () => {
    expect(parseScriptureRefs('I am 1 year in')).toHaveLength(0);
  });

  it('does NOT match a URL fragment that looks like a ref', () => {
    expect(parseScriptureRefs('https://example.com/gen/3:16')).toHaveLength(0);
  });

  it('does NOT match a verse range with a trailing non-digit after hyphen', () => {
    // Confirm no partial-match confusion e.g. "John 3:16 - but not that"
    const refs = parseScriptureRefs('John 3:16 - see above');
    expect(refs).toHaveLength(1);
    expect(refs[0].verseEnd).toBeNull();
  });
});

describe('parseScriptureRefsFromBody', () => {
  it('deduplicates identical refs', () => {
    const refs = parseScriptureRefsFromBody('John 3:16 and again John 3:16');
    expect(refs).toEqual(['John 3:16']);
  });

  it('returns canonical strings', () => {
    const refs = parseScriptureRefsFromBody('rom 8:28 and JN 3:16');
    expect(refs).toContain('Romans 8:28');
    expect(refs).toContain('John 3:16');
  });
});
