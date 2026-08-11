import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { PostVisibility } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ViewerContextService } from '../viewer/viewer-context.service';
import { CacheService } from '../redis/cache.service';
import { CacheInvalidationService } from '../redis/cache-invalidation.service';
import { CacheTtl } from '../redis/cache-ttl';
import { RedisKeys } from '../redis/redis-keys';
import {
  excludeCommunityGroupPostsWhere,
  notDeletedWhere,
  userNotBannedWhere,
} from './posts-query-builders';
import { feedPostInclude, type FeedPost } from './posts-feed.types';
import { PostsViewerEnrichmentService } from './posts-viewer-enrichment.service';
import { PostsFeedQueryService } from './posts-feed-query.service';
import type { PostDto } from '../../common/dto/post.dto';
import {
  mergeDiscoverCandidates,
  pageDiscoverIds,
  rankDiscoverCandidates,
  type DiscoverCandidate,
  type DiscoverSeedSignals,
} from './posts-discover-more.ranking';

const BUCKET_TAKE = 20;
const CACHED_ID_CAP = 80;
const FOLLOWED_AUTHOR_SAMPLE = 100;

type SeedRow = {
  id: string;
  userId: string;
  visibility: PostVisibility;
  communityGroupId: string | null;
  topics: string[];
  hashtags: string[];
  rootId: string | null;
  parentId: string | null;
};

type CandidateMetaRow = {
  id: string;
  userId: string;
  topics: string[];
  hashtags: string[];
  trendingScore: number | null;
  createdAt: Date;
};

/**
 * End-of-thread "Discover more" — multi-bucket retrieval on existing
 * topics/hashtags/trendingScore, Redis-cached candidate ids (post-context),
 * viewer filter + light re-rank, then composeFeedPostDtos.
 */
@Injectable()
export class PostsDiscoverMoreService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly viewerContextService: ViewerContextService,
    private readonly enrichment: PostsViewerEnrichmentService,
    private readonly feedQuery: PostsFeedQueryService,
    private readonly cache: CacheService,
    private readonly cacheInvalidation: CacheInvalidationService,
  ) {}

  async listDiscoverMore(params: {
    viewerUserId: string | null;
    postId: string;
    limit: number;
    cursor: string | null;
  }): Promise<{ posts: PostDto[]; nextCursor: string | null }> {
    const limit = Math.max(1, Math.min(50, Math.floor(params.limit || 8)));
    const viewerUserId = params.viewerUserId ?? null;
    const postId = (params.postId ?? '').trim();
    if (!postId) throw new NotFoundException('Post not found.');

    const seed = await this.loadSeed(postId, viewerUserId);
    const signals = await this.resolveSeedSignals(seed);

    const feedVer = await this.cacheInvalidation.feedGlobalVersion();
    const cacheKey = RedisKeys.discoverMoreIds(seed.id, feedVer);

    const cachedIds = await this.cache.getOrSetJson<string[]>({
      enabled: true,
      key: cacheKey,
      ttlSeconds: CacheTtl.discoverMoreIdsSeconds,
      compute: () => this.buildCandidateIds({ seed, signals }),
    });

    const blockSets = viewerUserId
      ? await this.enrichment.viewerBlockSets(viewerUserId)
      : { blockedByViewer: new Set<string>(), viewerBlockedBy: new Set<string>() };
    const blockedAuthorIds = new Set([...blockSets.blockedByViewer, ...blockSets.viewerBlockedBy]);

    const viewer = await this.viewerContextService.getViewer(viewerUserId);
    const allowed = this.enrichment.allowedVisibilitiesForViewer(viewer);

    const followingRows = viewerUserId
      ? await this.loadFollowedAuthorCandidateRows({
          viewerUserId,
          seed,
          blockedAuthorIds,
          excludeIds: cachedIds,
        })
      : [];

    const candidateIds = Array.from(
      new Set([...cachedIds, ...followingRows.map((r) => r.id)]),
    );

    // Load lightweight rows for viewer re-rank + visibility/block/ban filter.
    const metaRows =
      candidateIds.length > 0
        ? await this.prisma.post.findMany({
            where: {
              id: { in: candidateIds },
              ...notDeletedWhere(),
              isDraft: false,
              parentId: null,
              ...excludeCommunityGroupPostsWhere(),
              ...userNotBannedWhere(),
              visibility: { in: allowed },
              ...(blockedAuthorIds.size ? { userId: { notIn: [...blockedAuthorIds] } } : {}),
            },
            select: {
              id: true,
              userId: true,
              topics: true,
              hashtags: true,
              trendingScore: true,
              createdAt: true,
            },
          })
        : [];

    const metaById = new Map(metaRows.map((r) => [r.id, r]));
    // Preserve cache order, then append any following-only ids that survived filters.
    const visibleOrdered = [
      ...cachedIds.filter((id) => metaById.has(id)),
      ...followingRows.map((r) => r.id).filter((id) => metaById.has(id) && !cachedIds.includes(id)),
    ];

    const authorIdsForFollowCheck = metaRows.map((r) => r.userId);
    const [followedAuthorIds, followedTopics, viewedPostIds] = viewerUserId
      ? await Promise.all([
          this.loadFollowedAuthorsAmong(viewerUserId, authorIdsForFollowCheck),
          this.loadFollowedTopics(viewerUserId),
          this.loadViewedPostIds(viewerUserId, visibleOrdered),
        ])
      : [new Set<string>(), new Set<string>(), new Set<string>()];

    const followingBucketIds = new Set(followingRows.map((r) => r.id));
    const candidates: DiscoverCandidate[] = visibleOrdered.map((id) => {
      const r = metaById.get(id)!;
      const buckets: DiscoverCandidate['buckets'] = [];
      if (followingBucketIds.has(id)) buckets.push('following');
      return {
        id: r.id,
        userId: r.userId,
        topics: Array.isArray(r.topics) ? r.topics : [],
        hashtags: Array.isArray(r.hashtags) ? r.hashtags : [],
        trendingScore: r.trendingScore ?? 0,
        createdAt: r.createdAt,
        buckets,
      };
    });

    const rankedIds = rankDiscoverCandidates({
      candidates,
      seed: signals,
      viewer: viewerUserId
        ? {
            viewerUserId,
            followedAuthorIds,
            followedTopics,
            viewedPostIds,
          }
        : null,
      maxPerAuthor: 2,
    });

    const { ids: pageIds, nextCursor } = pageDiscoverIds({
      orderedIds: rankedIds,
      cursor: params.cursor,
      limit,
    });

    if (!pageIds.length) {
      return { posts: [], nextCursor: null };
    }

    const posts = await this.prisma.post.findMany({
      where: { id: { in: pageIds } },
      include: feedPostInclude,
    });
    const byId = new Map(posts.map((p) => [p.id, p as FeedPost]));
    const ordered = pageIds.map((id) => byId.get(id)).filter((p): p is FeedPost => Boolean(p));

    const dtos = await this.feedQuery.composeFeedPostDtos({
      viewerUserId,
      filteredPosts: ordered,
      collapsedItemsByItemId: new Map(),
    });

    return { posts: dtos, nextCursor };
  }

  private async loadSeed(postId: string, viewerUserId: string | null): Promise<SeedRow> {
    const post = await this.prisma.post.findFirst({
      where: { id: postId, deletedAt: null },
      select: {
        id: true,
        userId: true,
        visibility: true,
        communityGroupId: true,
        topics: true,
        hashtags: true,
        rootId: true,
        parentId: true,
      },
    });
    if (!post) throw new NotFoundException('Post not found.');

    const viewer = await this.viewerContextService.getViewer(viewerUserId);
    const allowed = this.enrichment.allowedVisibilitiesForViewer(viewer);
    if (!allowed.includes(post.visibility) && post.userId !== viewerUserId) {
      throw new NotFoundException('Post not found.');
    }

    if (post.communityGroupId) {
      try {
        await this.feedQuery.assertCanReadCommunityGroup(viewerUserId, post.communityGroupId);
      } catch {
        throw new NotFoundException('Post not found.');
      }
    }

    return {
      ...post,
      topics: Array.isArray(post.topics) ? post.topics : [],
      hashtags: Array.isArray(post.hashtags) ? post.hashtags : [],
    };
  }

  private async resolveSeedSignals(seed: SeedRow): Promise<DiscoverSeedSignals> {
    const topics = new Set(seed.topics);
    const hashtags = new Set(seed.hashtags.map((h) => h.toLowerCase()));

    if (seed.parentId || seed.rootId) {
      const rootLookupId = seed.rootId ?? seed.parentId;
      if (rootLookupId && rootLookupId !== seed.id) {
        const root = await this.prisma.post.findFirst({
          where: { id: rootLookupId, deletedAt: null },
          select: { topics: true, hashtags: true, userId: true },
        });
        if (root) {
          for (const t of root.topics ?? []) topics.add(t);
          for (const h of root.hashtags ?? []) hashtags.add(String(h).toLowerCase());
        }
      }
    }

    return {
      topics: Array.from(topics),
      hashtags: Array.from(hashtags),
      authorUserId: seed.userId,
    };
  }

  private threadExcludeIds(seed: SeedRow): string[] {
    const threadRoot = seed.rootId ?? seed.id;
    return Array.from(new Set([seed.id, threadRoot].filter(Boolean)));
  }

  private baseCandidateWhere(seed: SeedRow): Prisma.PostWhereInput {
    const excludeIds = this.threadExcludeIds(seed);
    const threadRoot = seed.rootId ?? seed.id;
    return {
      AND: [
        notDeletedWhere(),
        excludeCommunityGroupPostsWhere(),
        userNotBannedWhere(),
        { isDraft: false },
        { parentId: null },
        { id: { notIn: excludeIds } },
        // Drop any other posts that still sit in this thread tree.
        { OR: [{ rootId: null }, { rootId: { not: threadRoot } }] },
        // Public-ish default: only public posts in the shared candidate cache.
        // Viewer-specific visibility is re-checked on the request path.
        { visibility: 'public' },
      ],
    };
  }

  private async buildCandidateIds(params: {
    seed: SeedRow;
    signals: DiscoverSeedSignals;
  }): Promise<string[]> {
    const { seed, signals } = params;
    const base = this.baseCandidateWhere(seed);
    const select = {
      id: true,
      userId: true,
      topics: true,
      hashtags: true,
      trendingScore: true,
      createdAt: true,
    } as const;

    const [hashtagRows, topicRows, authorRows, trendingRows] = await Promise.all([
      signals.hashtags.length
        ? this.prisma.post.findMany({
            where: { AND: [base, { hashtags: { hasSome: signals.hashtags } }] },
            select,
            orderBy: [{ trendingScore: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
            take: BUCKET_TAKE,
          })
        : Promise.resolve([]),
      signals.topics.length
        ? this.prisma.post.findMany({
            where: { AND: [base, { topics: { hasSome: signals.topics } }] },
            select,
            orderBy: [{ trendingScore: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
            take: BUCKET_TAKE,
          })
        : Promise.resolve([]),
      this.prisma.post.findMany({
        where: { AND: [base, { userId: seed.userId }] },
        select,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: BUCKET_TAKE,
      }),
      this.prisma.post.findMany({
        where: { AND: [base, { trendingScore: { gt: 0 } }] },
        select,
        orderBy: [{ trendingScore: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
        take: BUCKET_TAKE,
      }),
    ]);

    const toCand = (
      rows: Array<{
        id: string;
        userId: string;
        topics: string[];
        hashtags: string[];
        trendingScore: number | null;
        createdAt: Date;
      }>,
      bucket: DiscoverCandidate['buckets'][number],
    ): DiscoverCandidate[] =>
      rows.map((r) => ({
        id: r.id,
        userId: r.userId,
        topics: Array.isArray(r.topics) ? r.topics : [],
        hashtags: Array.isArray(r.hashtags) ? r.hashtags : [],
        trendingScore: r.trendingScore ?? 0,
        createdAt: r.createdAt,
        buckets: [bucket],
      }));

    const merged = mergeDiscoverCandidates([
      ...toCand(hashtagRows, 'hashtag'),
      ...toCand(topicRows, 'topic'),
      ...toCand(authorRows, 'author'),
      ...toCand(trendingRows, 'trending'),
    ]);

    const ranked = rankDiscoverCandidates({
      candidates: merged,
      seed: signals,
      viewer: null,
      maxPerAuthor: 2,
    });

    return ranked.slice(0, CACHED_ID_CAP);
  }

  /**
   * Request-path bucket: recent public posts from people the viewer follows.
   * Kept off the shared Redis cache so it stays viewer-specific.
   */
  private async loadFollowedAuthorCandidateRows(params: {
    viewerUserId: string;
    seed: SeedRow;
    blockedAuthorIds: Set<string>;
    excludeIds: string[];
  }): Promise<CandidateMetaRow[]> {
    const follows = await this.prisma.follow.findMany({
      where: {
        followerId: params.viewerUserId,
        ...(params.blockedAuthorIds.size
          ? { followingId: { notIn: [...params.blockedAuthorIds] } }
          : {}),
      },
      select: { followingId: true },
      orderBy: { createdAt: 'desc' },
      take: FOLLOWED_AUTHOR_SAMPLE,
    });
    const authorIds = follows
      .map((f) => f.followingId)
      .filter((id) => id && id !== params.seed.userId && id !== params.viewerUserId);
    if (!authorIds.length) return [];

    const excludeIds = Array.from(
      new Set([...params.excludeIds, ...this.threadExcludeIds(params.seed)]),
    );

    return this.prisma.post.findMany({
      where: {
        AND: [
          this.baseCandidateWhere(params.seed),
          { userId: { in: authorIds } },
          ...(excludeIds.length ? [{ id: { notIn: excludeIds } }] : []),
        ],
      },
      select: {
        id: true,
        userId: true,
        topics: true,
        hashtags: true,
        trendingScore: true,
        createdAt: true,
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: BUCKET_TAKE,
    });
  }

  private async loadFollowedAuthorsAmong(viewerUserId: string, authorIds: string[]): Promise<Set<string>> {
    const ids = [...new Set(authorIds.map((id) => id.trim()).filter(Boolean))];
    if (!ids.length) return new Set();
    const rows = await this.prisma.follow.findMany({
      where: { followerId: viewerUserId, followingId: { in: ids } },
      select: { followingId: true },
    });
    return new Set(rows.map((r) => r.followingId));
  }

  private async loadFollowedTopics(viewerUserId: string): Promise<Set<string>> {
    const rows = await this.prisma.topicFollow.findMany({
      where: { userId: viewerUserId },
      select: { topic: true },
      take: 100,
    });
    return new Set(rows.map((r) => r.topic));
  }

  private async loadViewedPostIds(viewerUserId: string, postIds: string[]): Promise<Set<string>> {
    const ids = [...new Set(postIds.map((id) => id.trim()).filter(Boolean))];
    if (!ids.length) return new Set();
    const rows = await this.prisma.postView.findMany({
      where: { userId: viewerUserId, postId: { in: ids } },
      select: { postId: true },
    });
    return new Set(rows.map((r) => r.postId));
  }
}
