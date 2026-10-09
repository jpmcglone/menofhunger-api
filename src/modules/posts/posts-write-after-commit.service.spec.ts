import { PostsWriteAfterCommitService, type PostWrittenInput } from './posts-write-after-commit.service';

function setup() {
  const appConfig = { r2: jest.fn(() => ({ publicBaseUrl: 'https://cdn.example.com' })) };
  const cacheInvalidation = { bumpForPostWrite: jest.fn(async () => undefined) };
  const posthog = { capture: jest.fn() };
  const postViews = { markViewed: jest.fn(async () => undefined) };
  const realtime = {
    emitPostsLiveUpdated: jest.fn(),
    emitPostsCommentAdded: jest.fn(),
    emitGroupNewPost: jest.fn(),
  };
  const ranking = { enqueueScoreRefresh: jest.fn() };
  const sideEffects = { dispatch: jest.fn() };
  const service = new PostsWriteAfterCommitService(
    appConfig as never,
    cacheInvalidation as never,
    posthog as never,
    postViews as never,
    realtime as never,
    ranking as never,
    sideEffects as never,
  );
  return { service, cacheInvalidation, posthog, postViews, realtime, ranking, sideEffects };
}

function input(overrides: Partial<PostWrittenInput> = {}): PostWrittenInput {
  return {
    post: {
      id: 'post-1',
      topics: ['faith'],
      visibility: 'public',
      communityGroupId: null,
      body: 'hello',
      createdAt: new Date('2026-10-08T12:00:00.000Z'),
      user: { id: 'author', username: 'author' },
      media: [],
      mentions: [],
      poll: null,
    } as unknown as PostWrittenInput['post'],
    userId: 'author',
    kind: 'regular',
    visibility: 'public',
    parentId: null,
    parentCommentCount: null,
    parentAuthorUserId: null,
    parentIsBot: undefined,
    boardRootToBump: null,
    boardRootCommentCount: null,
    quotedPostId: null,
    didAwardStreak: false,
    requestedMarvMode: null,
    fromArticle: false,
    hasMedia: false,
    hasPoll: false,
    authorIsBot: false,
    authorVerifiedStatus: 'identity',
    ...overrides,
  };
}

describe('PostsWriteAfterCommitService', () => {
  it('queues post.created with a stable job id and refreshes the new post score', () => {
    const { service, sideEffects, ranking, cacheInvalidation, realtime } = setup();
    service.run(input({ didAwardStreak: true, requestedMarvMode: 'smart' }));
    expect(sideEffects.dispatch).toHaveBeenCalledWith(
      'post.created',
      { postId: 'post-1', actorUserId: 'author', didAwardStreak: true, requestedMarvMode: 'smart' },
      { jobId: 'post-created-post-1' },
    );
    expect(ranking.enqueueScoreRefresh).toHaveBeenCalledWith('post-1');
    expect(cacheInvalidation.bumpForPostWrite).toHaveBeenCalledWith({ topics: ['faith'], invalidateFeed: false });
    expect(realtime.emitPostsCommentAdded).not.toHaveBeenCalled();
  });

  it('does not invalidate search or topics for only-me posts', () => {
    const { service, cacheInvalidation } = setup();
    service.run(input({ post: { ...input().post, visibility: 'onlyMe' } as PostWrittenInput['post'] }));
    expect(cacheInvalidation.bumpForPostWrite).not.toHaveBeenCalled();
  });

  it('pushes a reply to thread subscribers, bumps the parent count, marks the parent viewed, and refreshes the parent score', () => {
    const { service, realtime, postViews, ranking } = setup();
    service.run(input({ parentId: 'parent-1', parentCommentCount: 4 }));
    expect(realtime.emitPostsLiveUpdated).toHaveBeenCalledWith(
      'parent-1',
      expect.objectContaining({ postId: 'parent-1', reason: 'comment_created', patch: { commentCount: 4 } }),
    );
    expect(realtime.emitPostsCommentAdded).toHaveBeenCalledWith('parent-1', expect.objectContaining({ parentPostId: 'parent-1' }));
    expect(postViews.markViewed).toHaveBeenCalledWith('author', 'parent-1');
    expect(ranking.enqueueScoreRefresh).toHaveBeenCalledWith('parent-1');
  });

  it('mirrors a nested board comment to the thread root room', () => {
    const { service, realtime } = setup();
    service.run(input({ kind: 'board', parentId: 'comment-1', parentCommentCount: 1, boardRootToBump: 'root-1', boardRootCommentCount: 9 }));
    expect(realtime.emitPostsLiveUpdated).toHaveBeenCalledWith('root-1', expect.objectContaining({ patch: { commentCount: 9 } }));
    expect(realtime.emitPostsCommentAdded).toHaveBeenCalledWith('root-1', expect.objectContaining({ parentPostId: 'comment-1' }));
  });

  it('refreshes the quoted post score for a quote repost', () => {
    const { service, ranking } = setup();
    service.run(input({ quotedPostId: 'quoted-1' }));
    expect(ranking.enqueueScoreRefresh).toHaveBeenCalledWith('quoted-1');
    expect(ranking.enqueueScoreRefresh).toHaveBeenCalledWith('post-1');
  });

  it.each([
    ['public', true],
    ['verifiedOnly', true],
    ['premiumOnly', false],
    ['onlyMe', false],
  ])('emits a top-level %s group post to the group room: %s', (visibility, emitted) => {
    const { service, realtime } = setup();
    service.run(input({ post: { ...input().post, communityGroupId: 'group-1', visibility } as PostWrittenInput['post'], visibility }));
    expect(realtime.emitGroupNewPost).toHaveBeenCalledTimes(emitted ? 1 : 0);
  });

  it('never emits a reply into the group feed room', () => {
    const { service, realtime } = setup();
    service.run(input({ parentId: 'parent-1', parentCommentCount: 2, post: { ...input().post, communityGroupId: 'group-1' } as PostWrittenInput['post'] }));
    expect(realtime.emitGroupNewPost).not.toHaveBeenCalled();
  });

  it('keeps the write successful when a realtime emit throws', () => {
    const { service, realtime } = setup();
    realtime.emitPostsLiveUpdated.mockImplementation(() => {
      throw new Error('socket down');
    });
    expect(() => service.run(input({ parentId: 'parent-1', parentCommentCount: 4 }))).not.toThrow();
  });

  it.each([
    [{ kind: 'checkin' }, 'checkin_created'],
    [{ kind: 'board' }, 'board_thread_created'],
    [{ kind: 'board', parentId: 'thread-1', parentCommentCount: 1 }, 'board_comment_created'],
    [{ kind: 'regular' }, 'post_created'],
  ] as const)('captures %j as %s', (overrides, event) => {
    const { service, posthog } = setup();
    service.run(input(overrides as Partial<PostWrittenInput>));
    expect(posthog.capture).toHaveBeenCalledWith('author', event, expect.objectContaining({ post_id: 'post-1' }));
  });
});
