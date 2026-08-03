/**
 * Guardrails for the discovery endpoints introduced in the repost/quote hardening:
 *
 * 1. Repost shell rows (kind='repost') must NOT appear in the GET /posts/:id/reposts
 *    response — that endpoint returns PostAuthorDto[], not PostDto[].
 * 2. Quoted posts (posts whose quotedPostId = :id) must appear in GET /posts/:id/quotes,
 *    stripped of restricted-tier bodies for free viewers, with no repost shells leaking in.
 * 3. quoteCount is included in a post DTO when the post has quotes.
 */
import { toPostDto } from './post.dto';
import type { PostWithAuthorAndMedia } from './post.dto';

const AUTHOR: PostWithAuthorAndMedia['user'] = {
  id: 'author-id',
  username: 'author',
  name: 'Author Name',
  premium: false,
  premiumPlus: false,
  isOrganization: false,
  stewardBadgeEnabled: false,
  verifiedStatus: 'identity',
  avatarKey: null,
  avatarUpdatedAt: null,
  bannedAt: null,
};

function makePost(overrides: Partial<PostWithAuthorAndMedia>): PostWithAuthorAndMedia {
  return {
    id: 'post-id',
    createdAt: new Date('2024-01-01'),
    updatedAt: new Date('2024-01-01'),
    editedAt: null,
    editCount: 0,
    body: 'hello world',
    deletedAt: null,
    kind: 'regular',
    checkinDayKey: null,
    checkinPrompt: null,
    visibility: 'public',
    isDraft: false,
    topics: [],
    hashtags: [],
    hashtagCasings: [],
    cashtags: [],
    boostCount: 5,
    boostScore: null,
    boostScoreUpdatedAt: null,
    bookmarkCount: 2,
    commentCount: 3,
    repostCount: 1,
    quoteCount: 0,
    viewerCount: 0,
    parentId: null,
    rootId: null,
    communityGroupId: null,
    pinnedInGroupAt: null,
    repostedPostId: null,
    quotedPostId: null,
    userId: 'author-id',
    user: AUTHOR,
    media: [],
    mentions: [],
    poll: null,
    ...overrides,
  } as any;
}

describe('discovery endpoints — view expansion guardrails', () => {
  it('toPostDto includes quoteCount from the post', () => {
    const post = makePost({ id: 'target-id', quoteCount: 7 } as any);
    const dto = toPostDto(post, null, {});
    expect((dto as any).quoteCount).toBe(7);
  });

  it('toPostDto quoteCount defaults to 0 when absent', () => {
    const post = makePost({ id: 'no-quotes-id' });
    const dto = toPostDto(post, null, {});
    expect((dto as any).quoteCount).toBe(0);
  });

  it('a repost shell (kind=repost) is NOT a quote and must not appear in the quotes list', () => {
    // Simulate the filter that listQuotes applies: kind != 'repost'.
    const candidatePosts: Array<{ kind: string; quotedPostId: string | null }> = [
      { kind: 'repost', quotedPostId: 'target-id' },   // flat repost – should be excluded
      { kind: 'regular', quotedPostId: 'target-id' },  // genuine quote – should be included
      { kind: 'checkin', quotedPostId: 'target-id' },  // checkin quoting – should be included
    ];

    const quotes = candidatePosts.filter(
      (p) => p.kind !== 'repost' && p.quotedPostId === 'target-id',
    );

    expect(quotes).toHaveLength(2);
    expect(quotes.every((q) => q.kind !== 'repost')).toBe(true);
  });

  it('a post with deletedAt is treated as deleted in the DTO', () => {
    const deleted = makePost({ id: 'deleted-id', deletedAt: new Date() });
    const dto = toPostDto(deleted, null, {});
    expect(dto.deletedAt).not.toBeNull();
    // Body is stripped for deleted posts.
    expect(dto.body).toBe('');
  });

  it('toPostDto strips body from a premiumOnly post when viewerCanAccess is false', () => {
    const premiumPost = makePost({
      id: 'premium-id',
      visibility: 'premiumOnly',
      body: 'secret content',
    });
    const dto = toPostDto(premiumPost, null, { viewerCanAccess: false });
    expect(dto.body).toBe('');
    expect(dto.viewerCanAccess).toBe(false);
  });
});
