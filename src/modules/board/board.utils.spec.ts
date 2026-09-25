import {
  boardHotScore,
  boardRangeStart,
  decodeOffsetCursor,
  encodeOffsetCursor,
  normalizeBoardTags,
  normalizeBoardUrl,
  slugifyBoardTag,
} from './board.utils';
import { gatedBoardTitle } from '../../common/dto/post.dto';

describe('board utils', () => {
  it('normalizes links for duplicate detection and strips tracking params', () => {
    const a = normalizeBoardUrl('https://www.Example.com/story/?utm_source=x&b=2&a=1#comments');
    const b = normalizeBoardUrl('example.com/story?a=1&b=2');
    expect(a?.domain).toBe('example.com');
    expect(a?.normalized).toBe('example.com/story?a=1&b=2');
    expect(b?.normalized).toBe(a?.normalized);
    expect(a?.url).not.toContain('utm_source');
  });

  it('rejects non-http links and bare words', () => {
    expect(normalizeBoardUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeBoardUrl('ftp://example.com/file')).toBeNull();
    expect(normalizeBoardUrl('notalink')).toBeNull();
    expect(normalizeBoardUrl('')).toBeNull();
  });

  it('slugifies tags and dedupes them', () => {
    expect(slugifyBoardTag('#Show HN')).toBe('show-hn');
    expect(slugifyBoardTag('a')).toBeNull();
    expect(normalizeBoardTags(['Ask', 'ask', '#hiring', '!!'])).toEqual(['ask', 'hiring']);
  });

  it('ranks like the HN front page: newer threads beat older ones with the same points', () => {
    const now = new Date('2026-09-25T12:00:00Z');
    const fresh = boardHotScore(10, new Date('2026-09-25T11:00:00Z'), now);
    const old = boardHotScore(10, new Date('2026-09-24T12:00:00Z'), now);
    const popularOld = boardHotScore(1000, new Date('2026-09-24T12:00:00Z'), now);
    expect(fresh).toBeGreaterThan(old);
    expect(popularOld).toBeGreaterThan(fresh);
    expect(boardHotScore(0, now, now)).toBe(0);
  });

  it('computes ranged Top windows and round-trips offset cursors', () => {
    const now = new Date('2026-09-25T12:00:00Z');
    expect(boardRangeStart('day', now)?.toISOString()).toBe('2026-09-24T12:00:00.000Z');
    expect(boardRangeStart('all', now)).toBeNull();
    expect(decodeOffsetCursor(encodeOffsetCursor(60))).toBe(60);
    expect(decodeOffsetCursor('garbage')).toBe(0);
  });

  it('trims gated titles at a word boundary', () => {
    const title = 'Show: I built a tiny app to track my kids chores and it changed our whole house';
    const gated = gatedBoardTitle(title);
    expect(gated.length).toBeLessThanOrEqual(61);
    expect(gated.endsWith('…')).toBe(true);
    expect(gatedBoardTitle('Short title')).toBe('Short title');
  });
});
