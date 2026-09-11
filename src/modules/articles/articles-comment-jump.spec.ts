import { VerifiedStatus } from '@prisma/client';
import { ArticlesService } from './articles.service';

const author = {
  id: 'user-1',
  username: 'john',
  name: 'John',
  bio: null,
  articleBio: null,
  avatarKey: null,
  avatarVideoKey: null,
  avatarVideoDurationMs: null,
  avatarUpdatedAt: null,
  premium: false,
  premiumPlus: false,
  isOrganization: false,
  verifiedStatus: VerifiedStatus.identity,
  orgMemberships: [],
};

function leafComment(overrides: Record<string, unknown> = {}) {
  return {
    id: 'c1',
    createdAt: new Date('2026-09-01T00:00:00Z'),
    editedAt: null,
    deletedAt: null,
    body: 'Keep the phone in another room.',
    articleId: 'a1',
    parentId: null,
    replyCount: 0,
    author,
    reactions: [],
    ...overrides,
  };
}

function makeService() {
  const prisma = {
    article: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'a1',
        isDraft: false,
        deletedAt: null,
        visibility: 'public',
        authorId: 'author-1',
      }),
    },
    articleComment: {
      findFirst: jest.fn(),
    },
  } as any;

  const viewer = {
    getViewer: jest.fn().mockResolvedValue({
      id: 'viewer-1',
      verifiedStatus: VerifiedStatus.identity,
      premium: false,
      premiumPlus: false,
      siteAdmin: false,
    }),
    allowedPostVisibilities: jest.fn().mockReturnValue(['public']),
  } as any;

  const service = new ArticlesService(
    prisma,
    viewer,
    { r2: jest.fn().mockReturnValue({ publicBaseUrl: 'https://cdn.example.com' }) } as any,
    {} as any,
    { getOrSetJson: jest.fn() } as any,
    { feedGlobalVersion: jest.fn() } as any,
    { enqueue: jest.fn() } as any,
    { dispatch: jest.fn() } as any,
    { viewerViewedArticleIds: jest.fn() } as any,
  );

  return { service, prisma };
}

describe('ArticlesService.getComment', () => {
  it('returns a top-level comment with no parent', async () => {
    const { service, prisma } = makeService();
    prisma.articleComment.findFirst.mockResolvedValueOnce(leafComment());

    const result = await service.getComment({ articleId: 'a1', commentId: 'c1' });

    expect(result.comment.id).toBe('c1');
    expect(result.parent).toBeNull();
  });

  it('returns the parent thread for a nested reply', async () => {
    const { service, prisma } = makeService();
    const reply = leafComment({ id: 'c2', parentId: 'c1', body: 'Amen.' });
    const parent = leafComment({ id: 'c1', replyCount: 4 });
    prisma.articleComment.findFirst
      .mockResolvedValueOnce(reply)
      .mockResolvedValueOnce(parent);

    const result = await service.getComment({ articleId: 'a1', commentId: 'c2' });

    expect(result.comment.id).toBe('c2');
    expect(result.parent?.id).toBe('c1');
    expect(result.parent?.replies?.map((r) => r.id)).toEqual(['c2']);
  });
});
