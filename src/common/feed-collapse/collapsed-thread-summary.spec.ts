import { collapseFeedByRoot } from './collapse-by-root';
import { applyCollapsedThreadSummary, renderedChainIds } from './collapsed-thread-summary';

type Author = { id: string };
type Dto = {
  id: string;
  parent?: Dto;
  threadCollapsedCount?: number;
  threadCollapsedAuthors?: Author[];
};

/** Build a DTO for `[root, …, leaf]` the way `attachParentChain` hydrates one. */
function chain(ids: string[]): Dto {
  return ids.reduce<Dto | undefined>(
    (parent, id) => (parent ? { id, parent } : { id }),
    undefined,
  ) as Dto;
}

describe('renderedChainIds', () => {
  it('includes the post and every hydrated ancestor', () => {
    expect([...renderedChainIds(chain(['A', 'B', 'C']))].sort()).toEqual(['A', 'B', 'C']);
  });

  it('stops on a self-referential parent instead of looping forever', () => {
    const dto: Dto = { id: 'A' };
    dto.parent = dto;
    expect([...renderedChainIds(dto)]).toEqual(['A']);
  });
});

describe('applyCollapsedThreadSummary', () => {
  it('leaves the DTO untouched when nothing was collapsed', () => {
    const dto = chain(['A', 'B']);
    applyCollapsedThreadSummary(dto, undefined);
    expect(dto.threadCollapsedCount).toBeUndefined();
    expect(dto.threadCollapsedAuthors).toBeUndefined();
  });

  it('counts only collapsed items the row does not render', () => {
    const dto = chain(['A', 'B', 'C']);
    applyCollapsedThreadSummary(dto, [
      { id: 'B', author: { id: 'onscreen' } },
      { id: 'D', author: { id: 'hidden' } },
    ]);
    expect(dto.threadCollapsedCount).toBe(1);
    expect(dto.threadCollapsedAuthors).toEqual([{ id: 'hidden' }]);
  });

  it('dedupes authors across multiple hidden replies', () => {
    const dto = chain(['A']);
    applyCollapsedThreadSummary(dto, [
      { id: 'D', author: { id: 'u1' } },
      { id: 'E', author: { id: 'u1' } },
      { id: 'F', author: { id: 'u2' } },
    ]);
    expect(dto.threadCollapsedCount).toBe(3);
    expect(dto.threadCollapsedAuthors).toEqual([{ id: 'u1' }, { id: 'u2' }]);
  });

  it('stamps nothing when every collapsed item renders as an ancestor', () => {
    const dto = chain(['A', 'B', 'C']);
    applyCollapsedThreadSummary(dto, [{ id: 'A', author: { id: 'u1' } }]);
    expect(dto.threadCollapsedCount).toBeUndefined();
    expect(dto.threadCollapsedAuthors).toBeUndefined();
  });
});

// ─── Regression: footer advertised a reply that was already on screen ─────────

describe('feed pipeline: A → B → C all present in the "new" feed', () => {
  const rows = [
    { id: 'C', parentId: 'B' },
    { id: 'B', parentId: 'A' },
    { id: 'A', parentId: null },
  ];

  it('renders the whole thread with no "View 1 more new reply" footer', () => {
    const { items, collapsedItemsByItemId } = collapseFeedByRoot(rows, {
      collapseByRoot: true,
      maxPerRoot: 2,
      getId: (row) => row.id,
      getParentId: (row) => row.parentId,
      getAuthorPreview: (row) => ({ id: `author-${row.id}` }),
    });

    // The row the client renders is anchored on C, with A and B hydrated above it.
    const anchor = items.find((row) => row.id === 'C');
    expect(anchor).toBeDefined();

    const dto = chain(['A', 'B', 'C']);
    applyCollapsedThreadSummary(dto, collapsedItemsByItemId.get('C'));

    // A was not returned as its own feed row, but it renders as C's ancestor —
    // pointing the viewer at "1 more new reply" would point at a post on screen.
    expect(dto.threadCollapsedCount).toBeUndefined();
  });

  it('still counts a reply on a branch the row does not show', () => {
    const { collapsedItemsByItemId } = collapseFeedByRoot(
      [...rows, { id: 'D', parentId: 'A' }],
      {
        collapseByRoot: true,
        maxPerRoot: 2,
        getId: (row) => row.id,
        getParentId: (row) => row.parentId,
        getAuthorPreview: (row) => ({ id: `author-${row.id}` }),
      },
    );

    const dto = chain(['A', 'B', 'C']);
    applyCollapsedThreadSummary(dto, collapsedItemsByItemId.get('C'));

    expect(dto.threadCollapsedCount).toBe(1);
    expect(dto.threadCollapsedAuthors).toEqual([{ id: 'author-D' }]);
  });
});
