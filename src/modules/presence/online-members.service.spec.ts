import { OnlineMembersService } from './online-members.service';

function makeService(opts: {
  connected: string[];
  /** connected id → the pages it operates (shown online with it). */
  operates?: Record<string, string[]>;
  /** Ids that fail the member filter (banned, unfinished). */
  ineligible?: string[];
  locations?: Record<string, string | null>;
  marvId?: string | null;
}) {
  const findMany = jest.fn(async ({ where }: any) =>
    (where.id.in as string[])
      .filter((id) => !(opts.ineligible ?? []).includes(id))
      .map((id) => ({ id, locationState: opts.locations?.[id] ?? null })),
  );
  const service = new OnlineMembersService(
    { user: { findMany } } as any,
    { marvBot: () => ({ enabled: opts.marvId !== undefined }) } as any,
    { onlineUserIds: jest.fn(async () => [...opts.connected]) } as any,
    {
      expandPresenceOnlineIds: jest.fn(async (ids: string[]) => {
        const sourceByDisplayedId = new Map<string, string>();
        for (const id of ids) {
          sourceByDisplayedId.set(id, id);
          for (const page of opts.operates?.[id] ?? []) sourceByDisplayedId.set(page, id);
        }
        return { displayedIds: [...sourceByDisplayedId.keys()], sourceByDisplayedId };
      }),
    } as any,
    { getMarvUserId: jest.fn(async () => opts.marvId ?? null) } as any,
  );
  return { service, findMany };
}

describe('OnlineMembersService.resolve', () => {
  it('counts operated pages as online and adds Marv to the total', async () => {
    const { service } = makeService({
      connected: ['jp', 'sam'],
      operates: { jp: ['page-moh', 'page-shop'] },
      locations: { jp: 'VA', sam: 'TX' },
      marvId: 'marv',
    });

    const roster = await service.resolve();

    expect(roster.memberIds).toEqual(['jp', 'page-moh', 'page-shop', 'sam']);
    expect(roster.marvId).toBe('marv');
    expect(roster.total).toBe(5);
    expect(roster.sourceByDisplayedId.get('page-moh')).toBe('jp');
    expect(roster.locationById.get('jp')).toBe('VA');
    expect(roster.locationById.has('marv')).toBe(true);
  });

  it('drops banned or unfinished accounts from both the list and the total', async () => {
    const { service } = makeService({ connected: ['ok', 'banned'], ineligible: ['banned'] });
    const roster = await service.resolve();
    expect(roster.memberIds).toEqual(['ok']);
    expect(roster.total).toBe(1);
  });

  it('never double-counts Marv and leaves him out when the bot is disabled', async () => {
    const withMarv = await makeService({ connected: ['marv', 'a'], marvId: 'marv' }).service.resolve();
    expect(withMarv.memberIds).toEqual(['a']);
    expect(withMarv.total).toBe(2);

    const disabled = await makeService({ connected: ['a'] }).service.resolve();
    expect(disabled.marvId).toBeNull();
    expect(disabled.total).toBe(1);
  });

  it('adds a requesting viewer whose socket has not registered, or leaves them out on request', async () => {
    const { service } = makeService({ connected: ['a'] });
    expect((await service.resolve({ viewerUserId: 'me', includeViewer: true })).memberIds).toEqual(['me', 'a']);
    expect((await service.resolve({ viewerUserId: 'a', includeViewer: false })).memberIds).toEqual([]);
    expect((await service.resolve({ viewerUserId: 'me' })).memberIds).toEqual(['a']);
  });
});
