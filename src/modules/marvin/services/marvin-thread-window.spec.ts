import { windowThreadAroundFocal } from './marvin-thread-window';

describe('windowThreadAroundFocal', () => {
  const rows = ['root', 'a', 'b', 'focal', 'c', 'd'].map((id) => ({ id }));

  it('returns the full list when it already fits', () => {
    expect(windowThreadAroundFocal(rows, 'focal', 10, 'root').map((r) => r.id)).toEqual(
      rows.map((r) => r.id),
    );
  });

  it('keeps history before the focal post first (root stays when it already fits)', () => {
    expect(windowThreadAroundFocal(rows, 'focal', 4, 'root').map((r) => r.id)).toEqual([
      'root',
      'a',
      'b',
      'focal',
    ]);
  });

  it('fills remaining slots with later replies once history is included', () => {
    const shortHistory = ['root', 'focal', 'c', 'd', 'e'].map((id) => ({ id }));
    expect(windowThreadAroundFocal(shortHistory, 'focal', 4, 'root').map((r) => r.id)).toEqual([
      'root',
      'focal',
      'c',
      'd',
    ]);
  });

  it('pins the root when the window would drop it', () => {
    expect(windowThreadAroundFocal(rows, 'focal', 3, 'root').map((r) => r.id)).toEqual([
      'root',
      'b',
      'focal',
    ]);
  });
});
