import { RecentlyOnlineService, decodeRecentlyOnlineCursor } from './recently-online.service';

type Row = { id: string; lastOnlineAt?: Date | null; createdAt?: Date };

function makeService(recent: Row[], never: Row[]) {
  const findMany = jest.fn(async ({ where, take }: { where: { lastOnlineAt: unknown }; take: number }) =>
    (where.lastOnlineAt === null ? never : recent).slice(0, take),
  );
  return { service: new RecentlyOnlineService({ user: { findMany } } as never), findMany };
}

const at = (n: number) => new Date(1_700_000_000_000 + n);

describe('RecentlyOnlineService.page', () => {
  it('continues the recent section from the last returned row', async () => {
    const { service } = makeService([{ id: 'a', lastOnlineAt: at(3) }, { id: 'b', lastOnlineAt: at(2) }, { id: 'c', lastOnlineAt: at(1) }], []);
    const page = await service.page({ excludeIds: [], limit: 2, cursor: null });
    expect(page.items.map((i) => i.id)).toEqual(['a', 'b']);
    expect(decodeRecentlyOnlineCursor(page.nextCursor!)).toEqual({ section: 'recent', tMs: at(2).getTime(), id: 'b' });
  });

  it('fills the page from users with no presence history and continues from the last one', async () => {
    const { service } = makeService(
      [{ id: 'a', lastOnlineAt: at(3) }],
      [{ id: 'n1', createdAt: at(9) }, { id: 'n2', createdAt: at(8) }, { id: 'n3', createdAt: at(7) }],
    );
    const page = await service.page({ excludeIds: [], limit: 3, cursor: null });
    expect(page.items.map((i) => i.id)).toEqual(['a', 'n1', 'n2']);
    expect(decodeRecentlyOnlineCursor(page.nextCursor!)).toEqual({ section: 'never', cMs: at(8).getTime(), id: 'n2' });
  });

  it('resumes at the start of the never section when the recent section fills the page', async () => {
    const { service } = makeService([{ id: 'a', lastOnlineAt: at(3) }], [{ id: 'n1', createdAt: at(9) }]);
    const page = await service.page({ excludeIds: [], limit: 1, cursor: null });
    expect(page.items.map((i) => i.id)).toEqual(['a']);
    expect(decodeRecentlyOnlineCursor(page.nextCursor!)).toEqual({ section: 'never', cMs: null, id: null });
  });

  it('ends with no cursor when nothing remains', async () => {
    const { service } = makeService([], [{ id: 'n1', createdAt: at(9) }]);
    const page = await service.page({ excludeIds: [], limit: 5, cursor: { section: 'never', cMs: null, id: null } });
    expect(page.items.map((i) => i.id)).toEqual(['n1']);
    expect(page.nextCursor).toBeNull();
  });
});
