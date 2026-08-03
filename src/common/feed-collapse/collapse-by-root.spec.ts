import { collapseFeedByRoot } from './collapse-by-root';

type MinPost = { id: string; parentId?: string | null };

function p(id: string, parentId?: string | null): MinPost {
  return { id, parentId: parentId ?? null };
}

const opts = {
  getId: (item: MinPost) => item.id,
  getParentId: (item: MinPost) => item.parentId ?? null,
};

function collapsedIds(
  map: Map<string, { id: string }[]>,
  keptId: string,
): string[] {
  return (map.get(keptId) ?? []).map((item) => item.id);
}

// ─── maxPerRoot=1 (backward compat) ───────────────────────────────────────────

describe('collapseFeedByRoot – maxPerRoot=1 (default)', () => {
  it('returns all items unchanged when collapseByRoot=false', () => {
    const items = [p('A'), p('B')];
    const { items: out, collapsedItemsByItemId } = collapseFeedByRoot(items, {
      collapseByRoot: false,
      ...opts,
    });
    expect(out).toEqual(items);
    expect(collapsedItemsByItemId.size).toBe(0);
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

  it('reports the unreturned items for the kept item', () => {
    const root = p('root');
    const r1 = p('r1', 'root');
    const r2 = p('r2', 'root');
    const { items: out, collapsedItemsByItemId } = collapseFeedByRoot([root, r1, r2], {
      collapseByRoot: true,
      prefer: 'reply',
      ...opts,
    });
    expect(collapsedIds(collapsedItemsByItemId, out[0]!.id).sort()).toEqual(['r2', 'root']);
  });

  it('captures an author preview per collapsed item', () => {
    type Authored = MinPost & { authorId: string };
    const items: Authored[] = [
      { id: 'root', parentId: null, authorId: 'u1' },
      { id: 'r1', parentId: 'root', authorId: 'u2' },
      { id: 'r2', parentId: 'root', authorId: 'u3' },
    ];
    const { items: out, collapsedItemsByItemId } = collapseFeedByRoot(items, {
      collapseByRoot: true,
      prefer: 'reply',
      getId: (item) => item.id,
      getParentId: (item) => item.parentId ?? null,
      getAuthorPreview: (item) => ({ id: item.authorId }),
    });
    const collapsed = collapsedItemsByItemId.get(out[0]!.id) ?? [];
    expect(collapsed.map((item) => item.author?.id).sort()).toEqual(['u1', 'u3']);
  });

  it('records nothing when each item is its own root', () => {
    const { collapsedItemsByItemId } = collapseFeedByRoot([p('A'), p('B')], {
      collapseByRoot: true,
      ...opts,
    });
    expect(collapsedItemsByItemId.size).toBe(0);
  });
});

// ─── maxPerRoot=2 ─────────────────────────────────────────────────────────────

describe('collapseFeedByRoot – maxPerRoot=2', () => {
  it('keeps the deepest item plus its in-feed parent', () => {
    const root = p('root');
    const r1 = p('r1', 'root');
    const r2 = p('r2', 'root');
    const r3 = p('r3', 'root');
    const { items: out } = collapseFeedByRoot([root, r1, r2, r3], {
      collapseByRoot: true,
      maxPerRoot: 2,
      ...opts,
    });
    expect(out.map((i) => i.id)).toEqual(['root', 'r1']);
  });

  it('reports sibling branches that were not returned', () => {
    const root = p('root');
    const r1 = p('r1', 'root');
    const r2 = p('r2', 'root');
    const r3 = p('r3', 'root');
    const { collapsedItemsByItemId } = collapseFeedByRoot([root, r1, r2, r3], {
      collapseByRoot: true,
      maxPerRoot: 2,
      ...opts,
    });
    // Both kept rows carry the same unreturned set; the DTO stage filters it
    // down to what each row does not render.
    expect(collapsedIds(collapsedItemsByItemId, 'root')).toEqual(['r2', 'r3']);
    expect(collapsedIds(collapsedItemsByItemId, 'r1')).toEqual(['r2', 'r3']);
  });

  it('records nothing when a root has exactly 2 items', () => {
    const { collapsedItemsByItemId } = collapseFeedByRoot([p('root'), p('r1', 'root')], {
      collapseByRoot: true,
      maxPerRoot: 2,
      ...opts,
    });
    expect(collapsedItemsByItemId.size).toBe(0);
  });

  it('handles multiple independent root threads correctly', () => {
    // Thread X: 3 items → keeps 2, collapses 1
    // Thread Y: 1 item  → keeps 1, collapses nothing
    const { items: out, collapsedItemsByItemId } = collapseFeedByRoot(
      [p('X'), p('xr1', 'X'), p('xr2', 'X'), p('Y')],
      { collapseByRoot: true, maxPerRoot: 2, ...opts },
    );
    expect(out.map((i) => i.id)).toEqual(['X', 'xr1', 'Y']);
    expect(collapsedIds(collapsedItemsByItemId, 'X')).toEqual(['xr2']);
    expect(collapsedIds(collapsedItemsByItemId, 'xr1')).toEqual(['xr2']);
    expect(collapsedItemsByItemId.has('Y')).toBe(false);
  });

  it('preserves original feed ordering of first-seen root keys', () => {
    // Feed order: a, b, aR — A's group gets a + aR; B is independent
    const { items: out } = collapseFeedByRoot([p('A'), p('B'), p('aR', 'A')], {
      collapseByRoot: true,
      maxPerRoot: 2,
      ...opts,
    });
    expect(out.map((i) => i.id)).toEqual(['A', 'aR', 'B']);
  });

  it('spends its slots on the deepest chain, not on the first two rows', () => {
    // Chain root -> A -> B, all three in the feed. The client renders one row
    // anchored on B, so the two slots go to B and its parent A; root still
    // renders as B's hydrated ancestor.
    const { items: out, collapsedItemsByItemId } = collapseFeedByRoot(
      [p('root'), p('A', 'root'), p('B', 'A')],
      { collapseByRoot: true, maxPerRoot: 2, ...opts },
    );
    expect(out.map((i) => i.id)).toEqual(['A', 'B']);
    expect(collapsedIds(collapsedItemsByItemId, 'B')).toEqual(['root']);
  });

  it('does not spend a slot on a sibling branch that would render nowhere', () => {
    // `sibling` replies to root on its own branch. Keeping it would cost a DTO
    // and still render nothing, so the slot goes to `A` (an ancestor of the
    // anchor) and `sibling` is reported as unreturned instead.
    const { items: out, collapsedItemsByItemId } = collapseFeedByRoot(
      [p('sibling', 'root'), p('root'), p('A', 'root'), p('B', 'A')],
      { collapseByRoot: true, maxPerRoot: 2, ...opts },
    );
    expect(out.map((i) => i.id)).toEqual(['A', 'B']);
    expect(collapsedIds(collapsedItemsByItemId, 'B').sort()).toEqual(['root', 'sibling']);
  });
});

// ─── Realistic scenario: 40 comments, 4 of them in the "new" feed ────────────

describe('collapseFeedByRoot – realistic scenario: 40 comments, 4 in new feed', () => {
  it('keeps the deepest chain and reports the two sibling replies it dropped', () => {
    // John's post has 40 comments total but is not itself in the feed page.
    // Four of its replies are, as individual feed items.
    const nick = p('nick', 'john');
    const peter = p('peter', 'nick');
    const bob = p('bob', 'john');
    const alice = p('alice', 'john');

    const { items: out, collapsedItemsByItemId } = collapseFeedByRoot(
      [nick, peter, bob, alice],
      { collapseByRoot: true, maxPerRoot: 2, ...opts },
    );

    expect(out.map((i) => i.id)).toEqual(['nick', 'peter']);
    expect(collapsedIds(collapsedItemsByItemId, 'peter')).toEqual(['bob', 'alice']);
    expect(collapsedItemsByItemId.has('bob')).toBe(false);
    expect(collapsedItemsByItemId.has('alice')).toBe(false);
  });

  it('only 1 reply from a 40-comment thread → nothing collapsed', () => {
    const { items: out, collapsedItemsByItemId } = collapseFeedByRoot(
      [p('nick', 'john'), p('dave')],
      { collapseByRoot: true, maxPerRoot: 2, ...opts },
    );

    expect(out.map((i) => i.id)).toEqual(['nick', 'dave']);
    expect(collapsedItemsByItemId.size).toBe(0);
  });

  it('exactly 2 replies from one chain → both kept, nothing collapsed', () => {
    const { items: out, collapsedItemsByItemId } = collapseFeedByRoot(
      [p('nick', 'john'), p('peter', 'nick')],
      { collapseByRoot: true, maxPerRoot: 2, ...opts },
    );

    expect(out).toHaveLength(2);
    expect(collapsedItemsByItemId.size).toBe(0);
  });

  it('mixed threads: one thread has 4 items, another has 1', () => {
    const { items: out, collapsedItemsByItemId } = collapseFeedByRoot(
      [p('r1', 'john'), p('r2', 'john'), p('s1', 'mary'), p('r3', 'john'), p('r4', 'john')],
      { collapseByRoot: true, maxPerRoot: 2, ...opts },
    );

    expect(out.map((i) => i.id)).toEqual(['r1', 's1']);
    expect(collapsedIds(collapsedItemsByItemId, 'r1')).toEqual(['r2', 'r3', 'r4']);
    expect(collapsedItemsByItemId.has('s1')).toBe(false);
  });
});
