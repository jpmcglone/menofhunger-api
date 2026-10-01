import { X_LINK_COST_MICROS, X_NATIVE_COST_MICROS } from '../../common/crosspost/crosspost-eligibility';
import { XApiError } from './x-api.client';
import { XCrosspostService } from './x-crosspost.service';

type Row = Record<string, unknown> | null;

function postRow(overrides: Record<string, unknown> = {}) {
  return {
    userId: 'user-1',
    body: 'hello world',
    visibility: 'public',
    kind: 'regular',
    boardOnly: false,
    isDraft: false,
    deletedAt: null,
    scheduledAt: null,
    parentId: null,
    communityGroupId: null,
    quotedPostId: null,
    repostedPostId: null,
    poll: null,
    media: [],
    ...overrides,
  };
}

function harness(opts: { post?: Record<string, unknown>; premium?: boolean; spent?: number; connected?: boolean } = {}) {
  let row: Row = null;
  const postUpdates: Array<Record<string, unknown>> = [];
  const dispatched: string[] = [];
  const prisma: any = {
    post: {
      findUnique: jest.fn(async () => opts.post ?? postRow()),
      updateMany: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        postUpdates.push(data);
        return { count: 1 };
      }),
    },
    article: {
      findUnique: jest.fn(async () => null),
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
    user: {
      findUnique: jest.fn(async () => ({ premium: opts.premium !== false, premiumPlus: false, verifiedStatus: 'identity' })),
    },
    xConnection: { findUnique: jest.fn(async () => ({ username: 'hunter' })) },
    xCrosspost: {
      findUnique: jest.fn(async () => row),
      aggregate: jest.fn(async () => ({ _sum: { costMicros: opts.spent ?? 0 } })),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        row = { id: 'row-1', remoteId: null, refundedAt: null, ...data };
        return row;
      }),
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        row = { ...(row ?? {}), ...data };
        return row;
      }),
      updateMany: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        if (row) row = { ...row, ...data };
        return { count: 1 };
      }),
    },
    $executeRaw: jest.fn(async () => 1),
    $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma)),
  };

  const connections = {
    getActiveConnection: jest.fn(async () => (opts.connected === false ? null : { id: 'c', userId: 'user-1', username: 'hunter' })),
    accessTokenFor: jest.fn(async () => 'token'),
    invalidateAccessToken: jest.fn(),
    markError: jest.fn(),
    clearError: jest.fn(),
  };
  const api = {
    createPost: jest.fn(async () => '99'),
    uploadImage: jest.fn(async () => 'media'),
  };
  const sideEffects = {
    dispatch: jest.fn((name: string) => {
      dispatched.push(name);
    }),
  };
  const appConfig = {
    partner: () => ({ xCountAllowance: false }),
    x: () => ({ clientId: 'id', clientSecret: 'secret', encryptionKey: 'k'.repeat(32), monthlyBudgetCents: 300 }),
    frontendBaseUrl: () => 'https://menofhunger.com',
    r2: () => ({ publicBaseUrl: null }),
  };
  const realtime = {
    emitPostsLiveUpdated: jest.fn(),
    emitPostsLiveUpdatedToUser: jest.fn(),
    emitArticlesLiveUpdated: jest.fn(),
    emitArticlesLiveUpdatedToUser: jest.fn(),
  };
  const service = new XCrosspostService(
    prisma as never,
    { ensure: async () => sideEffects.dispatch('outbound.deliver') } as never,
    { settle: jest.fn(), reserve: jest.fn(async () => true) } as never,
    appConfig as never,
    connections as never,
    api as never,
    realtime as never,
  );
  return { service, prisma, api, connections, postUpdates, dispatched, realtime, row: () => row };
}

describe('X cross-post requests', () => {
  it('reserves a native post at the text rate', async () => {
    const h = harness();
    await expect(h.service.requestPostCrosspost('user-1', 'post-1', 'native')).resolves.toEqual({
      status: 'queued',
      mode: 'native',
    });
    expect(h.prisma.xCrosspost.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ mode: 'native', costMicros: X_NATIVE_COST_MICROS }) }),
    );
    expect(h.dispatched).toEqual(['outbound.deliver']);
  });

  it('downgrades a poll to a link and bills the link rate', async () => {
    const h = harness({ post: postRow({ poll: { id: 'poll' } }) });
    await expect(h.service.requestPostCrosspost('user-1', 'post-1', 'native')).resolves.toEqual({
      status: 'queued',
      mode: 'link',
    });
    expect(h.prisma.xCrosspost.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ mode: 'link', costMicros: X_LINK_COST_MICROS }) }),
    );
  });

  it('skips members who are not Premium', async () => {
    const h = harness({ premium: false });
    await expect(h.service.requestPostCrosspost('user-1', 'post-1', 'link')).resolves.toEqual({
      status: 'skipped',
      reason: 'premium_required',
    });
    expect(h.prisma.xCrosspost.create).not.toHaveBeenCalled();
  });

  it('skips when the month is already spent', async () => {
    const h = harness({ spent: 300 * 10_000 });
    await expect(h.service.requestPostCrosspost('user-1', 'post-1', 'link')).resolves.toEqual({
      status: 'skipped',
      reason: 'monthly_limit',
    });
  });

  it('skips when X is not connected', async () => {
    const h = harness({ connected: false });
    await expect(h.service.requestPostCrosspost('user-1', 'post-1', 'native')).resolves.toEqual({
      status: 'skipped',
      reason: 'not_connected',
    });
  });
});

describe('X cross-post worker', () => {
  it('stores the status url', async () => {
    const h = harness();
    await h.service.requestPostCrosspost('user-1', 'post-1', 'native');
    await h.service.syncPost('post-1');
    expect(h.api.createPost).toHaveBeenCalledWith('token', expect.objectContaining({ text: 'hello world' }));
    expect(h.postUpdates).toContainEqual({ xUrl: 'https://x.com/hunter/status/99', xError: null });
    expect(h.realtime.emitPostsLiveUpdated).toHaveBeenCalledWith(
      'post-1',
      expect.objectContaining({ reason: 'crosspost', patch: { xUrl: 'https://x.com/hunter/status/99' } }),
    );
    expect(h.realtime.emitPostsLiveUpdatedToUser).toHaveBeenCalledWith('user-1', expect.objectContaining({ postId: 'post-1' }));
    expect(h.row()?.remoteId).toBe('99');
  });

  it('holds the reservation for a timed-out create instead of retrying it', async () => {
    const h = harness();
    await h.service.requestPostCrosspost('user-1', 'post-1', 'native');
    h.api.createPost.mockRejectedValueOnce(new XApiError(0, 'network_error', 'timed out', true));
    await expect(h.service.syncPost('post-1')).resolves.toBeUndefined();
    expect(h.row()?.refundedAt).toBeNull();
    expect(h.postUpdates.at(-1)).toEqual({ xError: 'Delivery is uncertain. Check X before retrying.' });
    expect(h.realtime.emitPostsLiveUpdated).not.toHaveBeenCalled();
    expect(h.realtime.emitPostsLiveUpdatedToUser).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ patch: { xError: 'Delivery is uncertain. Check X before retrying.' } }),
    );
  });

  it('rethrows a server error so the queue can retry', async () => {
    const h = harness();
    await h.service.requestPostCrosspost('user-1', 'post-1', 'native');
    h.api.createPost.mockRejectedValueOnce(new XApiError(503, 'request_failed', 'unavailable'));
    await expect(h.service.syncPost('post-1')).rejects.toBeInstanceOf(XApiError);
    expect(h.row()?.refundedAt).toBeNull();
  });
});


describe('X outbox recovery before request-path reservation', () => {
  it.each([{ premium: false, spent: 0 }, { premium: true, spent: 3000000 }])('preserves the legacy allowance while count rollout is off (%j)', async options => {
    const h = harness(options);
    await h.prisma.xCrosspost.create({ data: { userId: 'user-1', kind: 'post', localId: 'post-1', mode: 'native', costMicros: 0 } });
    await h.service.syncPost('post-1');
    expect(h.api.createPost).not.toHaveBeenCalled();
    expect(h.row()?.lastError).toContain('current allowance');
  });
  it('records the final payload cost for a recovered placeholder before publishing', async () => {
    const h = harness();
    await h.prisma.xCrosspost.create({ data: { userId: 'user-1', kind: 'post', localId: 'post-1', mode: 'native', costMicros: 0 } });
    await h.service.syncPost('post-1');
    expect(h.api.createPost).toHaveBeenCalledTimes(1);
    expect(h.row()?.costMicros).toBe(X_NATIVE_COST_MICROS);
  });
});
