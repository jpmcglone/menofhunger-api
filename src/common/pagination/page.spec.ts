import { clampLimit, toPage } from './page';

describe('clampLimit', () => {
  it('uses the default for missing or invalid input and clamps to [1, max]', () => {
    expect(clampLimit(undefined, { default: 20, max: 50 })).toBe(20);
    expect(clampLimit(null, { default: 20, max: 50 })).toBe(20);
    expect(clampLimit(Number.NaN, { default: 20, max: 50 })).toBe(20);
    expect(clampLimit(0, { default: 20, max: 50 })).toBe(1);
    expect(clampLimit(999, { default: 20, max: 50 })).toBe(50);
    expect(clampLimit(7.9, { default: 20, max: 50 })).toBe(7);
  });
});

describe('toPage', () => {
  const cursorOf = (r: { id: string }) => r.id;
  it('drops the extra row and returns the last kept row as cursor', () => {
    const page = toPage([{ id: 'a' }, { id: 'b' }, { id: 'c' }], 2, cursorOf);
    expect(page.items.map((r) => r.id)).toEqual(['a', 'b']);
    expect(page.nextCursor).toBe('b');
  });
  it('returns a null cursor on the last page', () => {
    expect(toPage([{ id: 'a' }], 2, cursorOf)).toEqual({ items: [{ id: 'a' }], nextCursor: null });
    expect(toPage([], 2, cursorOf)).toEqual({ items: [], nextCursor: null });
  });
});
