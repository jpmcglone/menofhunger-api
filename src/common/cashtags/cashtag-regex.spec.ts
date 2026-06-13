import { parseCashtagCandidatesFromText } from './cashtag-regex';

describe('parseCashtagCandidatesFromText', () => {
  it('parses simple cashtags', () => {
    expect(parseCashtagCandidatesFromText('Check out $SPY today')).toEqual(['SPY']);
    expect(parseCashtagCandidatesFromText('$AAPL and $MSFT are up')).toEqual(['AAPL', 'MSFT']);
  });

  it('normalizes to uppercase', () => {
    expect(parseCashtagCandidatesFromText('$spy is cool')).toEqual(['SPY']);
    expect(parseCashtagCandidatesFromText('$Aapl')).toEqual(['AAPL']);
  });

  it('deduplicates repeated symbols', () => {
    expect(parseCashtagCandidatesFromText('$SPY and then $spy again')).toEqual(['SPY']);
  });

  it('ignores $NUMBER tokens', () => {
    expect(parseCashtagCandidatesFromText('$100 is cheap')).toEqual([]);
    expect(parseCashtagCandidatesFromText('costs $5B total')).toEqual([]);
    expect(parseCashtagCandidatesFromText('worth $50')).toEqual([]);
  });

  it('ignores mid-word $ (like a$x)', () => {
    expect(parseCashtagCandidatesFromText('a$SPY is not a cashtag')).toEqual([]);
  });

  it('ignores consecutive $ (like $$SPY)', () => {
    expect(parseCashtagCandidatesFromText('$$SPY should not match')).toEqual([]);
  });

  it('ignores symbols longer than 6 letters', () => {
    expect(parseCashtagCandidatesFromText('$TOOLONG is invalid')).toEqual([]);
  });

  it('accepts 1-6 letter symbols', () => {
    expect(parseCashtagCandidatesFromText('$A and $ABCDEF')).toEqual(['A', 'ABCDEF']);
  });

  it('ignores cashtag followed by alphanumeric (mid-word)', () => {
    // $SPY123 → not a valid standalone cashtag
    expect(parseCashtagCandidatesFromText('$SPY123')).toEqual([]);
  });

  it('handles cashtag at end of string', () => {
    expect(parseCashtagCandidatesFromText('buying $TSLA')).toEqual(['TSLA']);
  });

  it('handles cashtag followed by punctuation', () => {
    expect(parseCashtagCandidatesFromText('$NVDA, $AMD.')).toEqual(['NVDA', 'AMD']);
  });

  it('returns empty array for empty input', () => {
    expect(parseCashtagCandidatesFromText('')).toEqual([]);
    expect(parseCashtagCandidatesFromText('   ')).toEqual([]);
  });
});
