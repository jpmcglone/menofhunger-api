import { collapseFeedByRoot } from './collapse-by-root';

type MinPost = { id: string; parentId?: string | null };

function p(id: string, parentId?: string | null): MinPost {
  return { id, parentId: parentId ?? null };
}

const opts = {
  getId: (item: MinPost) => item.id,
  getParentId: (item: MinPost) => item.parentId ?? null,
};

// ─── maxPerRoot=1 (backward compat) ───────────────────────────────────────────

describe('collapseFeedByRoot – maxPerRoot=1 (default)', () => {
  it('returns all items unchanged when collapseByRoot=false', () => {
    const items = [p('A'), p('B')];
    const { items: out, collapsedCountByKey, collapsedCountByItemId } = collapseFeedByRoot(items, {
      collapseByRoot: false,
      ...opts,
    });
    expect(out).toEqual(items);
    expect(collapsedCountByKey.size).toBe(0);
    expect(collapsedCountByItemId.size).toBe(0);
  });

  it('keeps one item per root when prefer=reply', () => {
    const root = p('root');
    const reply1 = p('r1', 'root');
    const reply2 = p('r2', 'root');
    const { items: out } = collapseFeedByRoot([root, reply1, reply2], {
      collapseByRoot: true,
      prefer: 'reply',
      ...opts,
    });
    expect(out).toHaveLength(1);
    // Should prefer a reply over root
    expect(out[0]!.id).not.toBe('root');
  });

  it('populates collapsedCountByKey for collapsed items', () => {
    const root = p('root');
    const r1 = p('r1', 'root');
    const r2 = p('r2', 'root');
    const { collapsedCountByKey } = collapseFeedByRoot([root, r1, r2], {
      collapseByRoot: true,
      ...opts,
    });
    // 3 items total, 1 kept → 2 collapsed
    const val = collapsedCountByKey.get('root');
    expect(val).toBe(2);
  });

  it('populates collapsedCountByItemId for the kept item', () => {
    const root = p('root');
    const r1 = p('r1', 'root');
    const r2 = p('r2', 'root');
    const { items: out, collapsedCountByItemId } = collapseFeedByRoot([root, r1, r2], {
      collapseByRoot: true,
      prefer: 'reply',
      ...opts,
    });
    // The kept item (a reply) should have an entry
    const keptId = out[0]!.id;
    expect(collapsedCountByItemId.get(keptId)).toBe(2);
  });

  it('does not set collapsedCountByItemId when nothing is collapsed', () => {
    const a = p('A');
    const b = p('B');
    const { collapsedCountByItemId } = collapseFeedByRoot([a, b], {
      collapseByRoot: true,
      ...opts,
    });
    // Each is its own root, no collapsing
    expect(collapsedCountByItemId.size).toBe(0);
  });
});

// ─── maxPerRoot=2 ─────────────────────────────────────────────────────────────

describe('collapseFeedByRoot – maxPerRoot=2', () => {
  it('keeps up to 2 items per root in sort order', () => {
    const root = p('root');
    const r1 = p('r1', 'root');
    const r2 = p('r2', 'root');
    const r3 = p('r3', 'root');
    const { items: out } = collapseFeedByRoot([root, r1, r2, r3], {
      collapseByRoot: true,
      maxPerRoot: 2,
      ...opts,
    });
    expect(out).toHaveLength(2);
    expect(out.map((i) => i.id)).toContain('root');
    expect(out.map((i) => i.id)).toContain('r1');
  });

  it('collapses the 3rd+ item and reports correct collapsedCount', () => {
    const root = p('root');
    const r1 = p('r1', 'root');
    const r2 = p('r2', 'root');
    const r3 = p('r3', 'root');
    const { collapsedCountByKey, collapsedCountByItemId, items: out } = collapseFeedByRoot(
      [root, r1, r2, r3],
      { collapseByRoot: true, maxPerRoot: 2, ...opts },
    );
    expect(collapsedCountByKey.get('root')).toBe(2); // r2 and r3 collapsed
    // Both kept items should have the collapsed count
    expect(collapsedCountByItemId.get(out[0]!.id)).toBe(2);
    expect(collapsedCountByItemId.get(out[1]!.id)).toBe(2);
  });

  it('does not set collapsedCount when exactly 2 items exist per root', () => {
    const root = p('root');
    const r1 = p('r1', 'root');
    const { collapsedCountByKey, collapsedCountByItemId } = collapseFeedByRoot(
      [root, r1],
      { collapseByRoot: true, maxPerRoot: 2, ...opts },
    );
    expect(collapsedCountByKey.has('root')).toBe(false);
    expect(collapsedCountByItemId.size).toBe(0);
  });

  it('handles multiple independent root threads correctly', () => {
    // Thread X: 3 items → keeps 2, collapses 1
    // Thread Y: 1 item  → keeps 1, collapses nothing
    const xRoot = p('X');
    const xR1 = p('xr1', 'X');
    const xR2 = p('xr2', 'X');
    const yRoot = p('Y');
    const { items: out, collapsedCountByKey, collapsedCountByItemId } = collapseFeedByRoot(
      [xRoot, xR1, xR2, yRoot],
      { collapseByRoot: true, maxPerRoot: 2, ...opts },
    );
    expect(out).toHaveLength(3); // 2 from X, 1 from Y
    expect(collapsedCountByKey.get('X')).toBe(1);
    expect(collapsedCountByKey.has('Y')).toBe(false);
    expect(collapsedCountByItemId.get('X')).toBe(1);
    expect(collapsedCountByItemId.get('xr1')).toBe(1);
    expect(collapsedCountByItemId.has('Y')).toBe(false);
  });

  it('preserves original feed ordering of first-seen root keys', () => {
    const a = p('A');
    const b = p('B');
    const aR = p('aR', 'A');
    // Feed order: a, b, aR — A's group gets a + aR; B is independent
    const { items: out } = collapseFeedByRoot([a, b, aR], {
      collapseByRoot: true,
      maxPerRoot: 2,
      ...opts,
    });
    // A group is first-seen, so its kept items come before B's items;
    // within group A the items appear in encounter order: [A, aR]
    expect(out.map((i) => i.id)).toEqual(['A', 'aR', 'B']);
  });

  it('handles nested chain: grandchild groups under great-grandparent root', () => {
    // Chain: root -> A -> B (all in feed)
    const root = p('root');
    const A = p('A', 'root');
    const B = p('B', 'A');
    // B's root in feed is 'root' (walks up byId to find it)
    const { items: out } = collapseFeedByRoot([root, A, B], {
      collapseByRoot: true,
      maxPerRoot: 2,
      ...opts,
    });
    // All 3 share root 'root', keep first 2
    expect(out).toHaveLength(2);
  });
});
