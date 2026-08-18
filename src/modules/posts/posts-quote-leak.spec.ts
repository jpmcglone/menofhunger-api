/**
 * Phase 2 pre-flight: failing tests that confirm the quoted-post visibility leak.
 *
 * A post that embeds a premiumOnly (or any gated) quoted post MUST NOT expose
 * the quoted body to a viewer who cannot access that post.  Today these tests
 * FAIL because buildAttachParentChain calls toPostDto(rawQuotedPost, baseUrl)
 * with no viewer options — the Prisma include is used as-is, bypassing all tier,
 * block, and visibility gating.
 *
 * After Phase 2 (quote-gating), the DTO builder will resolve quoted posts
 * through a quotedPostMap (populated by getByIds, which applies all gates), and
 * these tests will PASS.
 */
import { buildAttachParentChain } from './posts.utils';
import { toPostDto } from './post.dto';
import type { PostWithAuthorAndMedia } from './post.dto';

const AUTHOR: PostWithAuthorAndMedia['user'] = {
  id: 'author-id',
  username: 'author',
  name: 'Author Name',
  premium: false,
  premiumPlus: false,
  isOrganization: false,
  verifiedStatus: 'identity',
  avatarKey: null,
  avatarUpdatedAt: null,
  bannedAt: null,
};

function makePost(overrides: Record<string, unknown> = {}): PostWithAuthorAndMedia {
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
    boostCount: 0,
    boostScore: null,
    boostScoreUpdatedAt: null,
    bookmarkCount: 0,
    commentCount: 0,
    repostCount: 0,
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

/** Premium-only quoted post (what getByIds would EXCLUDE for a free viewer). */
const PREMIUM_QUOTED_POST = makePost({
  id: 'premium-post-id',
  body: 'This is premium-only content that free users must not see',
  visibility: 'premiumOnly',
  userId: 'other-author',
});

function buildAttach(quotedPostMap: Map<string, any>) {
  return buildAttachParentChain({
    parentMap: new Map(),
    baseUrl: null,
    boosted: new Set(),
    bookmarksByPostId: new Map(),
    votedPollOptionIdByPostId: new Map(),
    viewerUserId: 'free-viewer',
    viewerHasAdmin: false,
    internalByPostId: null,
    scoreByPostId: undefined,
    toPostDto,
    repostedByPostId: new Set(),
    repostedPostMap: new Map(),
    quotedPostMap,
    viewedByPostId: new Set(),
  });
}

describe('quoted-post visibility gate (Phase 2 failing tests)', () => {
  /**
   * A regular post quoting a premiumOnly post: when the quoted post is NOT in
   * quotedPostMap (because getByIds excluded it for the free viewer), the
   * resulting DTO must have no quotedPost at all — body must not leak.
   */
  it('omits quotedPost when it is absent from quotedPostMap (free viewer, premiumOnly quote)', () => {
    // The raw Prisma row has quotedPost populated (as the DB join would return it),
    // but getByIds excluded it for this viewer, so quotedPostMap is empty.
    const regularPost = makePost({
      id: 'quoting-post-id',
      body: 'Check out https://menofhunger.com/p/premium-post-id',
      quotedPostId: 'premium-post-id',
      quotedPost: PREMIUM_QUOTED_POST, // raw Prisma include — must NOT be trusted
    });

    const attach = buildAttach(new Map()); // empty map = viewer cannot see it
    const dto = attach(regularPost as any);

    expect(dto.quotedPost).toBeUndefined();
  });

  /**
   * A reply to a public post that quotes a premiumOnly post:
   * the floor bypass on replies must not override the DTO gate.
   * (The floor check is a create-time guard; the DTO gate is the runtime defense.)
   */
  it('omits quotedPost for a reply that quotes a premiumOnly post (floor bypass case)', () => {
    const replyPost = makePost({
      id: 'reply-post-id',
      body: 'Replying with a quote https://menofhunger.com/p/premium-post-id',
      parentId: 'parent-post-id',
      quotedPostId: 'premium-post-id',
      quotedPost: PREMIUM_QUOTED_POST,
    });

    const attach = buildAttach(new Map());
    const dto = attach(replyPost as any);

    expect(dto.quotedPost).toBeUndefined();
  });

  /**
   * A group post quoting a premiumOnly post (another floor bypass case).
   */
  it('omits quotedPost for a group post that quotes a premiumOnly post', () => {
    const groupPost = makePost({
      id: 'group-post-id',
      body: 'In group, quoting https://menofhunger.com/p/premium-post-id',
      communityGroupId: 'group-1',
      quotedPostId: 'premium-post-id',
      quotedPost: PREMIUM_QUOTED_POST,
    });

    const attach = buildAttach(new Map());
    const dto = attach(groupPost as any);

    expect(dto.quotedPost).toBeUndefined();
  });

  /**
   * A check-in quoting a premiumOnly post (the third floor bypass case).
   */
  it('omits quotedPost for a check-in that quotes a premiumOnly post', () => {
    const checkinPost = makePost({
      id: 'checkin-post-id',
      kind: 'checkin',
      body: 'Checking in with https://menofhunger.com/p/premium-post-id',
      checkinDayKey: '2024-01-01',
      quotedPostId: 'premium-post-id',
      quotedPost: PREMIUM_QUOTED_POST,
    });

    const attach = buildAttach(new Map());
    const dto = attach(checkinPost as any);

    expect(dto.quotedPost).toBeUndefined();
  });

  /**
   * Happy path: when the quoted post IS in quotedPostMap (viewer has access),
   * it must appear in the DTO.
   */
  it('includes quotedPost when it is present in quotedPostMap (viewer has access)', () => {
    const quotingPost = makePost({
      id: 'quoting-post-id',
      body: 'Check out https://menofhunger.com/p/public-post-id',
      quotedPostId: 'public-post-id',
      quotedPost: makePost({ id: 'public-post-id', body: 'public content' }),
    });

    const publicQuotedPost = makePost({ id: 'public-post-id', body: 'public content' });
    const attach = buildAttach(new Map([['public-post-id', publicQuotedPost]]));
    const dto = attach(quotingPost as any);

    expect(dto.quotedPost).toBeDefined();
    expect(dto.quotedPost?.id).toBe('public-post-id');
    expect(dto.quotedPost?.body).toBe('public content');
  });

  /**
   * Deleted quoted post: when the quoted post has deletedAt set, the DTO should
   * surface a tombstone (deletedAt is set, body is empty) rather than the full content.
   */
  it('surfaces a tombstone when the quoted post was deleted', () => {
    const deletedQuoted = makePost({
      id: 'deleted-post-id',
      body: 'Content that was deleted',
      deletedAt: new Date('2024-02-01'),
    });
    const quotingPost = makePost({
      id: 'quoting-post-id',
      body: 'Look at https://menofhunger.com/p/deleted-post-id',
      quotedPostId: 'deleted-post-id',
    });

    const attach = buildAttach(new Map([['deleted-post-id', deletedQuoted]]));
    const dto = attach(quotingPost as any);

    expect(dto.quotedPost).toBeDefined();
    expect(dto.quotedPost?.deletedAt).toBeTruthy();
    expect(dto.quotedPost?.body).toBe('');
  });
});

describe('list include has no nested quotedPost', () => {
  const { POST_LIST_INCLUDE, POST_WITH_POLL_INCLUDE } = require('../../common/prisma-includes/post.include');
  const { feedPostInclude } = require('./posts-feed.types');
  const feedQuerySource = require('node:fs').readFileSync(
    require('node:path').join(__dirname, 'posts-feed-query.service.ts'),
    'utf8',
  );

  it('POST_LIST_INCLUDE and feedPostInclude omit quotedPost', () => {
    expect(feedPostInclude).toBe(POST_LIST_INCLUDE);
    expect(POST_LIST_INCLUDE).not.toHaveProperty('quotedPost');
  });

  it('permalink include still nests quotedPost', () => {
    expect(POST_WITH_POLL_INCLUDE).toHaveProperty('quotedPost');
  });

  it('getByIds uses feedPostInclude (quotes hydrate via quotedPostMap)', () => {
    const idx = feedQuerySource.indexOf('async getByIds');
    const snippet = feedQuerySource.slice(idx, idx + 1800);
    expect(snippet).toContain('include: feedPostInclude');
    expect(snippet).not.toContain('quotedPost: { include: QUOTED_POST_INCLUDE }');
  });
});
