import { readFileSync } from 'fs';
import { resolve } from 'path';
import { PickaxApiError } from './pickax-api.client';
import { PickaxCrosspostService } from './pickax-crosspost.service';

type PostRow = Record<string, unknown>;

function postRow(overrides: PostRow = {}): PostRow {
  return {
    id: 'post-1',
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

function harness(opts: { post?: PostRow; connected?: boolean } = {}) {
  const dispatched: Array<{ name: string; payload: unknown }> = [];
  const postUpdates: Array<Record<string, unknown>> = [];
  const crosspostUpserts: Array<Record<string, unknown>> = [];
  let crosspostRow: Record<string, unknown> | null = null;

  const prisma = {
    user: { findUnique: jest.fn(async () => ({ verifiedStatus: 'identity', bannedAt: null })) },
    post: {
      findUnique: jest.fn(async () => opts.post ?? postRow()),
      updateMany: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        postUpdates.push(data);
        return { count: 1 };
      }),
    },
    article: { findUnique: jest.fn(async () => null), updateMany: jest.fn(async () => ({ count: 0 })) },
    pickaxCrosspost: {
      findUnique: jest.fn(async () => crosspostRow),
      upsert: jest.fn(async ({ create }: { create: Record<string, unknown> }) => {
        crosspostUpserts.push(create);
        crosspostRow = create;
        return create;
      }),
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
  };

  const connection = { id: 'conn-1', userId: 'user-1' };
  const connections = {
    getActiveConnection: jest.fn(async () => (opts.connected === false ? null : connection)),
    accessTokenFor: jest.fn(async () => 'token'),
    invalidateAccessToken: jest.fn(async () => undefined),
    markError: jest.fn(async () => undefined),
    clearError: jest.fn(async () => undefined),
  };

  const api = {
    createPost: jest.fn(async () => '794776'),
    updatePost: jest.fn(async () => undefined),
    createArticle: jest.fn(async () => null),
    updateArticle: jest.fn(async () => undefined),
  };

  const sideEffects = {
    dispatch: jest.fn((name: string, payload: unknown) => {
      dispatched.push({ name, payload });
    }),
  };

  const appConfig = { frontendBaseUrl: () => 'https://menofhunger.com', r2: () => ({ publicBaseUrl: null }) };
  const realtime = {
    emitPostsLiveUpdated: jest.fn(),
    emitPostsLiveUpdatedToUser: jest.fn(),
    emitArticlesLiveUpdated: jest.fn(),
    emitArticlesLiveUpdatedToUser: jest.fn(),
  };

  const service = new PickaxCrosspostService(
    prisma as never,
    { ensure: async (_user: string, _platform: string, kind: string, id: string) => sideEffects.dispatch('outbound.deliver', { kind, id }) } as never,
    appConfig as never,
    connections as never,
    api as never,
    realtime as never,
  );

  return { service, prisma, api, connections, sideEffects, dispatched, postUpdates, crosspostUpserts, realtime };
}

describe('Pickax cross-post requests', () => {
  it('defaults an explicitly requested Pickax share to an excerpt', async () => {
    const h = harness();
    await expect(h.service.requestPostCrosspost('user-1', 'post-1')).resolves.toEqual({ status: 'queued', mode: 'link' });
    expect(h.dispatched).toEqual([
      { name: 'outbound.deliver', payload: { kind: 'post', id: 'post-1' } },
    ]);
  });

  it.each([
    ['not_public', { visibility: 'verifiedOnly' }],
    ['unsupported_kind', { kind: 'checkin' }],
    ['group_post', { communityGroupId: 'group-1' }],
    ['reply', { parentId: 'parent-1' }],
  ])('never queues %s, even when asked', async (reason, overrides) => {
    const h = harness({ post: postRow(overrides) });
    await expect(h.service.requestPostCrosspost('user-1', 'post-1')).resolves.toEqual({
      status: 'skipped',
      reason,
    });
    expect(h.sideEffects.dispatch).not.toHaveBeenCalled();
  });

  it('skips when the viewer is not the author', async () => {
    const h = harness();
    await expect(h.service.requestPostCrosspost('someone-else', 'post-1')).resolves.toEqual({
      status: 'skipped',
      reason: 'not_found',
    });
    expect(h.sideEffects.dispatch).not.toHaveBeenCalled();
  });

  it('skips when no Pickax key is connected', async () => {
    const h = harness({ connected: false });
    await expect(h.service.requestPostCrosspost('user-1', 'post-1')).resolves.toEqual({
      status: 'skipped',
      reason: 'not_connected',
    });
    expect(h.sideEffects.dispatch).not.toHaveBeenCalled();
  });
});

describe('Pickax cross-post worker', () => {
  it('creates the remote post and stores its public link', async () => {
    const h = harness();
    await h.service.syncPost('post-1', true);
    expect(h.api.createPost).toHaveBeenCalledTimes(1);
    expect(h.crosspostUpserts[0]).toMatchObject({ kind: 'post', localId: 'post-1', remoteId: '794776' });
    expect(h.postUpdates).toContainEqual({ pickaxUrl: 'https://pickax.com/post/794776', pickaxError: null });
    expect(h.realtime.emitPostsLiveUpdated).toHaveBeenCalledWith(
      'post-1',
      expect.objectContaining({ reason: 'crosspost', patch: { pickaxUrl: 'https://pickax.com/post/794776' } }),
    );
  });

  it('records the Pickax rejection on the post so the author sees it', async () => {
    const h = harness();
    h.api.createPost.mockRejectedValueOnce(new PickaxApiError(400, 'bad_request', 'Pickax says no.'));
    await h.service.syncPost('post-1', true);
    expect(h.postUpdates).toContainEqual({ pickaxError: 'Pickax says no.' });
    expect(h.realtime.emitPostsLiveUpdated).not.toHaveBeenCalled();
    expect(h.realtime.emitPostsLiveUpdatedToUser).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ patch: { pickaxError: 'Pickax says no.' } }),
    );
    expect(h.connections.markError).toHaveBeenCalled();
  });

  it('does not call Pickax when the post stopped qualifying before the job ran', async () => {
    const h = harness({ post: postRow({ visibility: 'premiumOnly' }) });
    await h.service.syncPost('post-1', true);
    expect(h.api.createPost).not.toHaveBeenCalled();
  });
});

describe('Posts controller cross-post wiring', () => {
  it('only asks for a cross-post when the client opted in', () => {
    const src = readFileSync(resolve(process.cwd(), 'src/modules/posts/posts.controller.ts'), 'utf8');
    expect(src).toContain('this.pickax.requestPostCrosspost(userId, created.id, pickaxMode)');
    expect(src).toContain("parsed.crossPostToPickax ? 'native'");
  });
});
