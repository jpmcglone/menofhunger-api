import { ConversationsService } from './conversations.service';

const now = new Date('2026-09-05T18:00:00Z');
const ago = (hours: number) => new Date(now.getTime() - hours * 3_600_000);
const candidate = {
  id: 'post',
  userId: 'author',
  body: 'How do you keep momentum on your own projects?',
  parentId: null,
  kind: 'regular',
  commentCount: 0,
  viewerCount: 4,
  createdAt: ago(12),
  quotedPostId: null,
  topics: ['building'],
};
const reply = {
  id: 'reply',
  parentId: 'post',
  userId: 'friend',
  createdAt: ago(1),
  body: 'I make the next step small enough that I can finish it before work.',
  user: {
    id: 'friend',
    username: 'friend',
    name: 'Friend',
    avatarKey: null,
    avatarUpdatedAt: null,
  },
};

function fixture(
  options: {
    seenHours?: number;
    following?: string[];
    topics?: string[];
    replies?: (typeof reply)[];
    participated?: boolean;
    quoted?: boolean;
    originalVisible?: boolean;
  } = {},
) {
  const post = {
    ...candidate,
    quotedPostId: options.quoted ? 'original' : null,
  };
  const findMany = jest
    .fn()
    .mockResolvedValueOnce([post])
    .mockResolvedValueOnce(
      options.participated ? [{ rootId: 'post', parentId: 'post' }] : [],
    )
    .mockResolvedValueOnce(options.replies ?? [])
    .mockResolvedValueOnce(
      options.originalVisible ? [{ id: 'original', userId: 'author' }] : [],
    );
  const prisma = {
    post: { findMany },
    postView: {
      findMany: jest
        .fn()
        .mockResolvedValue(
          options.seenHours === undefined
            ? []
            : [{ postId: 'post', lastSeenAt: ago(options.seenHours) }],
        ),
    },
    follow: {
      findMany: jest
        .fn()
        .mockResolvedValue(
          (options.following ?? []).map((followingId) => ({ followingId })),
        ),
    },
    topicFollow: {
      findMany: jest
        .fn()
        .mockResolvedValue((options.topics ?? []).map((topic) => ({ topic }))),
    },
  };
  const service = new ConversationsService(
    prisma as any,
    {} as any,
    { r2: () => null } as any,
  );
  jest.spyOn(service, 'readableWhere').mockResolvedValue({ deletedAt: null });
  return { service, findMany };
}

describe('Conversation opportunities in For You', () => {
  beforeEach(() => jest.useFakeTimers().setSystemTime(now));
  afterEach(() => jest.useRealTimers());

  it('surfaces an unseen unanswered question through an explicitly followed topic', async () => {
    const { service } = fixture({ topics: ['building'] });
    expect((await service.contexts('viewer', ['post'])).get('post')?.kind).toBe(
      'unanswered',
    );
  });

  it('does not label unrelated or already-seen questions as opportunities', async () => {
    expect((await fixture().service.contexts('viewer', ['post'])).size).toBe(0);
    const { service } = fixture({ following: ['author'], seenHours: 24 });
    expect((await service.contexts('viewer', ['post'])).size).toBe(0);
  });

  it('resurfaces a participated thread only for a reply newer than the last view', async () => {
    const { service } = fixture({
      participated: true,
      seenHours: 8,
      replies: [reply],
    });
    const context = (await service.contexts('viewer', ['post'])).get('post');
    expect(context?.kind).toBe('newReplies');
    expect(context?.reply?.id).toBe('reply');
    const stale = fixture({
      participated: true,
      seenHours: 8,
      replies: [{ ...reply, createdAt: ago(9) }],
    });
    expect((await stale.service.contexts('viewer', ['post'])).size).toBe(0);
  });

  it('respects the repeat-view cooldown even when a relevant reply arrives', async () => {
    const { service } = fixture({
      following: ['friend'],
      seenHours: 2,
      replies: [reply],
    });
    expect((await service.contexts('viewer', ['post'])).size).toBe(0);
  });

  it('links a follow-up only when its original is visible and relevant', async () => {
    const allowed = fixture({ quoted: true, originalVisible: true });
    expect(
      (await allowed.service.contexts('viewer', ['post'])).get('post'),
    ).toEqual({
      kind: 'followUp',
      reply: null,
      relatedPostId: 'original',
    });
    const hidden = fixture({ quoted: true });
    expect((await hidden.service.contexts('viewer', ['post'])).size).toBe(0);
    expect(hidden.findMany.mock.calls[3][0].where.AND[0]).toEqual({
      deletedAt: null,
    });
  });
});
