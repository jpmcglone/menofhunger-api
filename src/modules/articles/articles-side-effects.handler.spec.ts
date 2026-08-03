import { ArticlesSideEffectsHandler } from './articles-side-effects.handler';
import { SideEffectsRegistry } from '../side-effects/side-effects.registry';

function makeHandler() {
  const prisma: any = {
    article: { findFirst: jest.fn(async () => null), findUnique: jest.fn(async () => null) },
    articleComment: { findFirst: jest.fn(async () => null), findUnique: jest.fn(async () => null) },
    follow: { findMany: jest.fn(async () => []) },
    user: { findMany: jest.fn(async () => []) },
  };
  const notifications: any = { create: jest.fn(async () => undefined) };
  const registry = new SideEffectsRegistry();
  const sideEffects: any = { dispatch: jest.fn() };
  const handler = new ArticlesSideEffectsHandler(prisma, notifications, registry, sideEffects);
  return { handler, prisma, notifications, registry, sideEffects };
}

const PUBLISHED_ARTICLE = {
  title: 'A Long Title',
  visibility: 'public',
  publishedAt: new Date('2026-08-01T00:00:00.000Z'),
};

describe('ArticlesSideEffectsHandler registration', () => {
  it('registers every article effect', () => {
    const { handler, registry } = makeHandler();

    handler.onModuleInit();

    expect(registry.names()).toEqual([
      'article.boosted',
      'article.comment.created',
      'article.published',
      'article.reaction.added',
    ]);
  });
});

describe('ArticlesSideEffectsHandler article.published', () => {
  function setup(followers: any[], article: any = PUBLISHED_ARTICLE) {
    const ctx = makeHandler();
    ctx.prisma.article.findFirst.mockResolvedValue(article);
    ctx.prisma.follow.findMany.mockResolvedValue(followers);
    return ctx;
  }

  const run = (handler: ArticlesSideEffectsHandler) =>
    (handler as any).onArticlePublished({ articleId: 'a1', authorUserId: 'author' });

  it('notifies every follower for a public article', async () => {
    const { handler, notifications } = setup([
      { followerId: 'f1', follower: { verifiedStatus: 'none', premium: false, premiumPlus: false } },
      { followerId: 'f2', follower: { verifiedStatus: 'identity', premium: true, premiumPlus: false } },
    ]);

    await run(handler);

    expect(notifications.create.mock.calls.map((c: any[]) => c[0].recipientUserId).sort()).toEqual(['f1', 'f2']);
    expect(notifications.create).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'followed_article', subjectArticleId: 'a1', actorUserId: 'author' }),
    );
  });

  it('splits a large follower set into chunk jobs instead of writing them inline', async () => {
    const followerIds = Array.from({ length: 250 }, (_, i) => `f${i}`);
    const { handler, notifications, sideEffects } = setup(
      followerIds.map((followerId) => ({
        followerId,
        follower: { verifiedStatus: 'identity', premium: false, premiumPlus: false },
      })),
    );

    await run(handler);

    expect(notifications.create).not.toHaveBeenCalled();
    const chunkJobs = sideEffects.dispatch.mock.calls.filter(
      (c: any[]) => c[0] === 'notification.fanout.chunk',
    );
    expect(chunkJobs).toHaveLength(2);
    expect(chunkJobs.flatMap((c: any[]) => c[1].recipientUserIds)).toEqual(followerIds);
    expect(chunkJobs[0][1]).toMatchObject({ kind: 'followed_article', subjectArticleId: 'a1' });
  });

  it('never notifies the author about their own article', async () => {
    const { handler, notifications } = setup([
      { followerId: 'author', follower: { verifiedStatus: 'identity', premium: false, premiumPlus: false } },
    ]);

    await run(handler);

    expect(notifications.create).not.toHaveBeenCalled();
  });

  it('skips unverified followers for a verifiedOnly article', async () => {
    const { handler, notifications } = setup(
      [
        { followerId: 'unverified', follower: { verifiedStatus: 'none', premium: false, premiumPlus: false } },
        { followerId: 'verified', follower: { verifiedStatus: 'identity', premium: false, premiumPlus: false } },
      ],
      { ...PUBLISHED_ARTICLE, visibility: 'verifiedOnly' },
    );

    await run(handler);

    expect(notifications.create.mock.calls.map((c: any[]) => c[0].recipientUserId)).toEqual(['verified']);
  });

  it('skips non-premium followers for a premiumOnly article', async () => {
    const { handler, notifications } = setup(
      [
        { followerId: 'free', follower: { verifiedStatus: 'identity', premium: false, premiumPlus: false } },
        { followerId: 'plus', follower: { verifiedStatus: 'none', premium: false, premiumPlus: true } },
      ],
      { ...PUBLISHED_ARTICLE, visibility: 'premiumOnly' },
    );

    await run(handler);

    expect(notifications.create.mock.calls.map((c: any[]) => c[0].recipientUserId)).toEqual(['plus']);
  });

  // A retry must not announce an article that was unpublished or deleted in the meantime.
  it('does nothing when the article is no longer published', async () => {
    const { handler, notifications, prisma } = setup([
      { followerId: 'f1', follower: { verifiedStatus: 'identity', premium: false, premiumPlus: false } },
    ]);
    prisma.article.findFirst.mockResolvedValue({ ...PUBLISHED_ARTICLE, publishedAt: null });

    await run(handler);

    expect(notifications.create).not.toHaveBeenCalled();
  });

  it('does nothing when the article is gone', async () => {
    const { handler, notifications, prisma } = setup([]);
    prisma.article.findFirst.mockResolvedValue(null);

    await run(handler);

    expect(notifications.create).not.toHaveBeenCalled();
  });

  it('truncates a long title into the notification body', async () => {
    const longTitle = 'x'.repeat(120);
    const { handler, notifications } = setup(
      [{ followerId: 'f1', follower: { verifiedStatus: 'identity', premium: false, premiumPlus: false } }],
      { ...PUBLISHED_ARTICLE, title: longTitle },
    );

    await run(handler);

    expect(notifications.create.mock.calls[0][0].body).toBe(`${'x'.repeat(79)}…`);
  });
});

describe('ArticlesSideEffectsHandler article.comment.created', () => {
  function setup(opts: { articleAuthorId?: string; mentionUsers?: Array<{ id: string }> } = {}) {
    const ctx = makeHandler();
    ctx.prisma.articleComment.findFirst.mockResolvedValue({ body: 'nice piece @alice' });
    ctx.prisma.article.findUnique.mockResolvedValue({ authorId: opts.articleAuthorId ?? 'article-author' });
    ctx.prisma.user.findMany.mockResolvedValue(opts.mentionUsers ?? []);
    return ctx;
  }

  const run = (handler: ArticlesSideEffectsHandler, overrides: Record<string, unknown> = {}) =>
    (handler as any).onCommentCreated({
      articleId: 'a1',
      commentId: 'c1',
      actorUserId: 'commenter',
      parentCommentId: null,
      mentionUsernames: [],
      ...overrides,
    });

  it('notifies the article author for a top-level comment', async () => {
    const { handler, notifications } = setup();

    await run(handler);

    expect(notifications.create).toHaveBeenCalledWith(
      expect.objectContaining({
        recipientUserId: 'article-author',
        kind: 'comment',
        title: 'replied to your article',
        subjectArticleCommentId: 'c1',
      }),
    );
  });

  it('notifies the parent comment author for a reply', async () => {
    const { handler, notifications, prisma } = setup();
    prisma.articleComment.findUnique.mockResolvedValue({ authorId: 'parent-author' });

    await run(handler, { parentCommentId: 'parent-1' });

    expect(notifications.create).toHaveBeenCalledWith(
      expect.objectContaining({ recipientUserId: 'parent-author', title: 'replied to your reply' }),
    );
  });

  it('never notifies the commenter about their own comment', async () => {
    const { handler, notifications } = setup({ articleAuthorId: 'commenter' });

    await run(handler);

    expect(notifications.create).not.toHaveBeenCalled();
  });

  // Parity with post replies: an explicit @mention outranks the reply notification.
  it('sends only a mention notification when the recipient was also @mentioned', async () => {
    const { handler, notifications } = setup({ mentionUsers: [{ id: 'article-author' }] });

    await run(handler, { mentionUsernames: ['author'] });

    const kinds = notifications.create.mock.calls.map((c: any[]) => c[0].kind);
    expect(kinds).toEqual(['mention']);
  });

  it('notifies mentioned users besides the author', async () => {
    const { handler, notifications } = setup({ mentionUsers: [{ id: 'alice' }] });

    await run(handler, { mentionUsernames: ['alice'] });

    const mentionCalls = notifications.create.mock.calls.filter((c: any[]) => c[0].kind === 'mention');
    expect(mentionCalls.map((c: any[]) => c[0].recipientUserId)).toEqual(['alice']);
  });

  it('does not notify the commenter even if they @mentioned themselves', async () => {
    const { handler, notifications } = setup({ articleAuthorId: 'commenter', mentionUsers: [{ id: 'commenter' }] });

    await run(handler, { mentionUsernames: ['commenter'] });

    expect(notifications.create).not.toHaveBeenCalled();
  });

  it('does nothing when the comment was deleted before the job ran', async () => {
    const { handler, notifications, prisma } = setup();
    prisma.articleComment.findFirst.mockResolvedValue(null);

    await run(handler);

    expect(notifications.create).not.toHaveBeenCalled();
  });
});

describe('ArticlesSideEffectsHandler article.boosted', () => {
  it('notifies the article author', async () => {
    const { handler, notifications, prisma } = makeHandler();
    prisma.article.findUnique.mockResolvedValue({ authorId: 'author', title: 'Some Title' });

    await (handler as any).onBoosted({ articleId: 'a1', actorUserId: 'booster' });

    expect(notifications.create).toHaveBeenCalledWith(
      expect.objectContaining({ recipientUserId: 'author', kind: 'boost', body: 'Some Title' }),
    );
  });

  it('does not notify a self-boost', async () => {
    const { handler, notifications, prisma } = makeHandler();
    prisma.article.findUnique.mockResolvedValue({ authorId: 'author', title: 'Some Title' });

    await (handler as any).onBoosted({ articleId: 'a1', actorUserId: 'author' });

    expect(notifications.create).not.toHaveBeenCalled();
  });
});

describe('ArticlesSideEffectsHandler article.reaction.added', () => {
  it('notifies the article author with the emoji as the body', async () => {
    const { handler, notifications, prisma } = makeHandler();
    prisma.article.findUnique.mockResolvedValue({ authorId: 'author' });

    await (handler as any).onReactionAdded({ articleId: 'a1', actorUserId: 'reactor', emoji: '🔥' });

    expect(notifications.create).toHaveBeenCalledWith(
      expect.objectContaining({ recipientUserId: 'author', title: 'reacted to your article', body: '🔥' }),
    );
  });

  it('does not notify a self-reaction', async () => {
    const { handler, notifications, prisma } = makeHandler();
    prisma.article.findUnique.mockResolvedValue({ authorId: 'author' });

    await (handler as any).onReactionAdded({ articleId: 'a1', actorUserId: 'author', emoji: '🔥' });

    expect(notifications.create).not.toHaveBeenCalled();
  });
});
