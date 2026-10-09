import { decodeJsonCursor, encodeJsonCursor } from './json-cursor';

describe('json cursor', () => {
  it('round-trips an object payload', () => {
    expect(decodeJsonCursor(encodeJsonCursor({ id: 'p1', n: 3 }))).toEqual({ id: 'p1', n: 3 });
  });

  it('decodes cursors issued with standard base64', () => {
    const legacy = Buffer.from(JSON.stringify({ tag: 'a??b', usageCount: 2 })).toString('base64');
    expect(decodeJsonCursor(legacy)).toEqual({ tag: 'a??b', usageCount: 2 });
  });

  it('returns null for empty, malformed, or non-object input', () => {
    expect(decodeJsonCursor(undefined)).toBeNull();
    expect(decodeJsonCursor('   ')).toBeNull();
    expect(decodeJsonCursor('%%%')).toBeNull();
    expect(decodeJsonCursor(Buffer.from('[1]').toString('base64url'))).toBeNull();
    expect(decodeJsonCursor(Buffer.from('7').toString('base64url'))).toBeNull();
  });
});
