import { stableJsonHash } from './redis-keys';

describe('stable cache-key hashing', () => {
  it('normalizes nested object key order while preserving array order', () => {
    expect(stableJsonHash({ b: [{ z: 1, a: 2 }], a: true }))
      .toBe(stableJsonHash({ a: true, b: [{ a: 2, z: 1 }] }));
    expect(stableJsonHash([1, 2])).not.toBe(stableJsonHash([2, 1]));
  });

  it('handles nulls and circular references without throwing', () => {
    const value: { child?: unknown; label: string } = { label: 'cycle' };
    value.child = value;
    expect(stableJsonHash(value)).toBe(stableJsonHash({ label: 'cycle', child: '[Circular]' }));
    expect(stableJsonHash(null)).toHaveLength(20);
  });
});
