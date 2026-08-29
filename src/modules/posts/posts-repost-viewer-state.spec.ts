/**
 * Guardrails for Phase 1 of the repost/quote hardening:
 * embedded posts (reposted originals + quoted posts) must receive the same
 * viewer-state enrichment (viewerHasBoosted, viewerHasBookmarked,
 * viewerHasReposted, viewerVotedPollOptionId) as top-level feed posts.
 */
import { buildAttachParentChain } from './posts.utils';
import { toPostDto } from './post.dto';
import type { PostWithAuthorAndMedia } from './post.dto';

// Minimal author fixture shared by all posts in these tests.
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

describe('buildAttachParentChain — embedded-post viewer state (Phase 1)', () => {
  it('surfaces viewerHasBoosted=true on the reposted original when the original id is in the boosted set', () => {
    const original = makePost({ id: 'original-id', body: 'original body' });
    const shell = makePost({
      id: 'repost-shell-id',
      kind: 'repost' as any,
      body: '',
      repostedPostId: 'original-id',
    });

    const boosted = new Set(['original-id']);
    const repostedPostMap = new Map<string, any>([['original-id', original]]);

    const attachParentChain = buildAttachParentChain({
      parentMap: new Map(),
      baseUrl: null,
      boosted,
      bookmarksByPostId: new Map(),
      votedPollOptionIdByPostId: new Map(),
      viewerUserId: 'viewer',
      viewerHasAdmin: false,
      internalByPostId: null,
      scoreByPostId: undefined,
      toPostDto,
      repostedByPostId: new Set(),
      repostedPostMap,
      viewedByPostId: new Set(),
    });

    const dto = attachParentChain(shell as any);
    expect(dto.repostedPost).toBeDefined();
    expect(dto.repostedPost?.viewerHasBoosted).toBe(true);
  });

  it('surfaces viewerHasBookmarked=true on the reposted original', () => {
    const original = makePost({ id: 'original-id', body: 'original body' });
    const shell = makePost({
      id: 'repost-shell-id',
      kind: 'repost' as any,
      body: '',
      repostedPostId: 'original-id',
    });

    const bookmarksByPostId = new Map([['original-id', { collectionIds: ['col-1'] }]]);
    const repostedPostMap = new Map<string, any>([['original-id', original]]);

    const attachParentChain = buildAttachParentChain({
      parentMap: new Map(),
      baseUrl: null,
      boosted: new Set(),
      bookmarksByPostId,
      votedPollOptionIdByPostId: new Map(),
      viewerUserId: 'viewer',
      viewerHasAdmin: false,
      internalByPostId: null,
      scoreByPostId: undefined,
      toPostDto,
      repostedByPostId: new Set(),
      repostedPostMap,
      viewedByPostId: new Set(),
    });

    const dto = attachParentChain(shell as any);
    expect(dto.repostedPost?.viewerHasBookmarked).toBe(true);
    expect(dto.repostedPost?.viewerBookmarkCollectionIds).toEqual(['col-1']);
  });

  it('surfaces viewerHasReposted=true on the reposted original', () => {
    const original = makePost({ id: 'original-id', body: 'original body' });
    const shell = makePost({
      id: 'repost-shell-id',
      kind: 'repost' as any,
      body: '',
      repostedPostId: 'original-id',
    });

    const repostedByPostId = new Set(['original-id']);
    const repostedPostMap = new Map<string, any>([['original-id', original]]);

    const attachParentChain = buildAttachParentChain({
      parentMap: new Map(),
      baseUrl: null,
      boosted: new Set(),
      bookmarksByPostId: new Map(),
      votedPollOptionIdByPostId: new Map(),
      viewerUserId: 'viewer',
      viewerHasAdmin: false,
      internalByPostId: null,
      scoreByPostId: undefined,
      toPostDto,
      repostedByPostId,
      repostedPostMap,
      viewedByPostId: new Set(),
    });

    const dto = attachParentChain(shell as any);
    // viewerHasReposted on the original means the viewer has their own flat repost of it
    expect(dto.repostedPost?.viewerHasReposted).toBe(true);
  });

  it('surfaces viewerVotedPollOptionId on the reposted original with a poll', () => {
    const original = makePost({
      id: 'original-id',
      body: 'vote on this',
      poll: {
        id: 'poll-1',
        endsAt: new Date(Date.now() + 60_000),
        ended: false,
        totalVoteCount: 10,
        creatorSkippedAt: null,
        options: [
          {
            id: 'opt-a',
            text: 'A',
            position: 0,
            voteCount: 6,
            imageR2Key: null,
            imageWidth: null,
            imageHeight: null,
            imageAlt: null,
          },
        ],
      } as any,
    });
    const shell = makePost({
      id: 'repost-shell-id',
      kind: 'repost' as any,
      body: '',
      repostedPostId: 'original-id',
    });

    const votedPollOptionIdByPostId = new Map([['original-id', 'opt-a']]);
    const repostedPostMap = new Map<string, any>([['original-id', original]]);

    const attachParentChain = buildAttachParentChain({
      parentMap: new Map(),
      baseUrl: null,
      boosted: new Set(),
      bookmarksByPostId: new Map(),
      votedPollOptionIdByPostId,
      viewerUserId: 'viewer',
      viewerHasAdmin: false,
      internalByPostId: null,
      scoreByPostId: undefined,
      toPostDto,
      repostedByPostId: new Set(),
      repostedPostMap,
      viewedByPostId: new Set(),
    });

    const dto = attachParentChain(shell as any);
    expect(dto.repostedPost?.poll?.viewerHasVoted).toBe(true);
    expect(dto.repostedPost?.poll?.viewerVotedOptionId).toBe('opt-a');
  });
});

describe('allPostIds includes embedded post IDs (source guardrail)', () => {
  const feedQuerySource = require('node:fs').readFileSync(
    require('node:path').join(__dirname, 'posts-feed-query.service.ts'),
    'utf8',
  );
  const controllerSource = require('node:fs').readFileSync(
    require('node:path').join(__dirname, 'posts.controller.ts'),
    'utf8',
  );

  it('composeFeedPostDtos seeds the ancestor CTE with reposted and quoted ids', () => {
    expect(feedQuerySource).toContain('collectAncestorPostIds');
    const idx = feedQuerySource.indexOf('const ancestorAndEmbedIds');
    const snippet = feedQuerySource.slice(idx, idx + 400);
    expect(snippet).toContain('repostedPostIds');
    expect(snippet).toContain('quotedPostIds');
  });

  it('composeFeedPostDtos includes page + ancestor ids in overlay allPostIds', () => {
    expect(feedQuerySource).toContain('allPostIds = [...pageIdSet, ...ancestorAndEmbedIds]');
  });

  it('profile feed path uses composeFeedPostDtos', () => {
    expect(controllerSource).toContain('this.posts.composeFeedPostDtos');
    expect(controllerSource).not.toContain('repostedPostMapUser.keys()');
  });

  it('permalink getById batches ancestors instead of walking getById per parent', () => {
    expect(controllerSource).toContain('collectAncestorPostIds');
    expect(controllerSource).toContain('loadPermalinkRelatedPosts');
    expect(controllerSource).not.toContain('current = await this.posts.getById({ viewerUserId, id: parentId })');
  });

  it('permalink overlays load in one Promise.all', () => {
    const overlayStart = controllerSource.indexOf('quotedPostByIdPermalink');
    const snippet = controllerSource.slice(overlayStart, overlayStart + 1400);
    expect(snippet).toContain('await Promise.all([');
    expect(snippet).toContain('communityGroupPreviewMapForIds');
    expect(snippet).toContain('viewerBoostedPostIds');
    expect(snippet).toContain('viewerBookmarksByPostId');
    expect(snippet).toContain('viewerVotedPollOptionIdByPostId');
    expect(snippet).toContain('viewerRepostedPostIds');
    expect(snippet).toContain('viewerLastSeenAtByPostId');
  });

  it('comments and thread-participants use a shell access check, not full getById', () => {
    const commentsStart = feedQuerySource.indexOf('async listComments(');
    const commentsEnd = feedQuerySource.indexOf('async getThreadParticipants(');
    const comments = feedQuerySource.slice(commentsStart, commentsEnd);
    expect(comments).toContain('requireReadablePostShell');
    expect(comments).not.toContain('this.getById(');

    const participants = feedQuerySource.slice(
      commentsEnd,
      feedQuerySource.indexOf('async getById('),
    );
    expect(participants).toContain('requireReadablePostShell');
    expect(participants).toContain('RedisKeys.threadParticipants');
    expect(participants).not.toContain('this.getById(');
  });
});

describe('authenticated post-view batch writes (source guardrail)', () => {
  const viewsSource = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '../post-views/post-views.service.ts'),
    'utf8',
  );

  it('markViewedBatch writes authenticated views in one transaction', () => {
    expect(viewsSource).toContain('markAuthenticatedViewsBatch');
    expect(viewsSource).toContain('createManyAndReturn');
    const batchFn = viewsSource.slice(
      viewsSource.indexOf('async markViewedBatch('),
      viewsSource.indexOf('async expandViewTargetIds('),
    );
    expect(batchFn).toContain('if (uid)');
    expect(batchFn).toContain('this.markAuthenticatedViewsBatch');
    expect(batchFn).not.toContain('expanded.map((pid) => this.markViewed(uid');
  });
});
