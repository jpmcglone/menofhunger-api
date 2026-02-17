import { BadRequestException, ForbiddenException, HttpException, HttpStatus, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { PostVisibility } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PresenceRealtimeService } from '../presence/presence-realtime.service';
import { PollsService } from './polls.service';
import { ViewerContextService, type ViewerContext } from '../viewer/viewer-context.service';
import { createdAtIdCursorWhere } from '../../common/pagination/created-at-id-cursor';
import { RequestCacheService } from '../../common/cache/request-cache.service';
import { parseMentionsFromBody as parseMentionsFromBodyText } from '../../common/mentions/mention-regex';
import { parseHashtagTokensFromText, type HashtagToken } from '../../common/hashtags/hashtag-regex';
import { inferTopicsFromText } from '../../common/topics/topic-utils';
import { CacheInvalidationService } from '../redis/cache-invalidation.service';
import { POST_WITH_POLL_INCLUDE } from '../../common/prisma-includes/post.include';
import { MENTION_USER_SELECT, USER_LIST_SELECT } from '../../common/prisma-selects/user.select';

export type PostCounts = {
  all: number;
  public: number;
  verifiedOnly: number;
  premiumOnly: number;
};

const feedPostInclude = POST_WITH_POLL_INCLUDE;
type FeedPost = Prisma.PostGetPayload<{ include: typeof feedPostInclude }>;
type FeedResult = { posts: FeedPost[]; nextCursor: string | null };
type PopularFeedResult = FeedResult & { scoreByPostId: Map<string, number> };

@Injectable()
export class PostsService {
  private readonly logger = new Logger(PostsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly requestCache: RequestCacheService,
    private readonly presenceRealtime: PresenceRealtimeService,
    private readonly polls: PollsService,
    private readonly viewerContextService: ViewerContextService,
    private readonly cacheInvalidation: CacheInvalidationService,
  ) {}

  /**
   * Centralized guardrail: any query that *returns posts* should include this.
   * This prevents accidentally surfacing soft-deleted posts via new endpoints.
   */
  private notDeletedWhere(): Prisma.PostWhereInput {
    return { deletedAt: null };
  }

  private static boostScoreTtlMs = 10 * 60 * 1000;
  /** 12h half-life so trending favors recent engagement. */
  private static popularHalfLifeSeconds = 12 * 60 * 60;
  private static popularLookbackDays = 30;
  private static popularWarmupTake = 200;
  /**
   * Score penalty for posts that have deleted ancestors.
   * We avoid expensive recursive ancestry checks; instead we penalize based on:
   * - deleted direct parent (for replies to deleted replies)
   * - deleted thread root (for replies under a deleted root post)
   *
   * If both apply, penalty compounds.
   */
  private static deletedAncestorPenalty = 0.85;
  // Popular feed candidate selection: bias toward recency, but include top engaged.
  // Keep bounded so we never score/sort an unbounded 30-day set.
  private static popularRecentWindowHours = 72;
  private static popularCandidatesRecentTake = 8000;
  private static popularCandidatesBoostedTake = 1500;
  private static popularCandidatesBookmarkedTake = 1500;
  private static popularCandidatesCommentedTake = 1500;
  private static popularCandidatesRepliesTake = 1200;
  /** Weight for comment score in trending (same as bookmarks: quieter signal than boosts). */
  private static commentScoreWeight = 0.5;
  /** Top-level posts get this multiplier so they rank slightly above replies with similar engagement. */
  private static popularTopLevelScoreBoost = 1.15;
  /** Pin score: "I think this is important" — premium pinner > verified > neither (same hierarchy as boost weights). */
  private static pinScorePremium = 0.5;
  private static pinScoreVerified = 0.3;
  private static pinScoreBase = 0.15;
  /**
   * Trending hashtag bonus: small additive bump so "hot topic" posts surface a bit sooner,
   * but engagement signals (boosts/bookmarks/comments) still dominate.
   *
   * Base applies when the post has >=1 hashtag that appears in the latest trending snapshot.
   * Scaled applies proportional to the post's strongest trending hashtag score (normalized to snapshot max).
   */
  private static popularTrendingHashtagBaseBonus = 0.05;
  private static popularTrendingHashtagMaxScaledBonus = 0.15;

  // "Featured" is an automated, stable subset of trending:
  // - Top-level posts only
  // - Shorter lookback window (more “fresh”)
  // - Light author diversity (avoid 5 posts in a row from same author)
  private static featuredLookbackDays = 10;
  private static featuredMaxPerAuthor = 1;
  private static featuredScanTakeMax = 500;
  private static featuredRisingWindowHours = 48;
  private static featuredRisingHalfLifeSeconds = 6 * 60 * 60;
  private static featuredRisingMixTopRatio = 0.7;

  private encodePopularCursor(cursor: { asOf: string; score: number; createdAt: string; id: string }) {
    return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
  }

  private decodePopularCursor(token: string | null): { asOf: string; score: number; createdAt: string; id: string } | null {
    const t = (token ?? '').trim();
    if (!t) return null;
    try {
      const raw = Buffer.from(t, 'base64url').toString('utf8');
      const parsed = JSON.parse(raw) as Partial<{ asOf: string; score: number; createdAt: string; id: string }>;
      const asOf = typeof parsed.asOf === 'string' ? parsed.asOf : '';
      const createdAt = typeof parsed.createdAt === 'string' ? parsed.createdAt : '';
      const id = typeof parsed.id === 'string' ? parsed.id : '';
      const score = typeof parsed.score === 'number' && Number.isFinite(parsed.score) ? parsed.score : NaN;
      if (!asOf || !createdAt || !id) return null;
      if (!Number.isFinite(score)) return null;
      return { asOf, score, createdAt, id };
    } catch {
      return null;
    }
  }

  async ensureBoostScoresFresh(postIds: string[]) {
    const ids = (postIds ?? []).filter(Boolean);
    if (ids.length === 0) return new Map<string, { boostScore: number | null; boostScoreUpdatedAt: Date | null }>();

    const now = new Date();
    const staleBefore = new Date(now.getTime() - PostsService.boostScoreTtlMs);

    const posts = await this.prisma.post.findMany({
      where: { id: { in: ids } },
      select: { id: true, boostScoreUpdatedAt: true },
    });

    const staleIds = posts
      .filter((p) => !p.boostScoreUpdatedAt || p.boostScoreUpdatedAt < staleBefore)
      .map((p) => p.id);

    if (staleIds.length > 0) {
      const rows = await this.prisma.$queryRaw<Array<{ postId: string; score: number | null }>>(Prisma.sql`
        SELECT
          b."postId" as "postId",
          CAST(
            SUM(
              (
                CASE
                  WHEN u."premium" THEN 3
                  WHEN u."verifiedStatus" <> 'none' THEN 2
                  ELSE 1
                END
              )
              * POWER(
                0.5,
                EXTRACT(EPOCH FROM (NOW() - b."createdAt")) / (24 * 60 * 60)
              )
            ) AS DOUBLE PRECISION
          ) as "score"
        FROM "Boost" b
        JOIN "User" u ON u."id" = b."userId"
        WHERE b."postId" IN (${Prisma.join(staleIds)})
        GROUP BY b."postId"
      `);

      const scoreByPostId = new Map<string, number>();
      for (const r of rows) scoreByPostId.set(r.postId, r.score ?? 0);

      const tuples = staleIds.map((id) => Prisma.sql`(${id}, ${scoreByPostId.get(id) ?? 0})`);
      await this.prisma.$executeRaw(Prisma.sql`
        UPDATE "Post" AS p
        SET
          "boostScore" = v.score,
          "boostScoreUpdatedAt" = ${now}
        FROM (VALUES ${Prisma.join(tuples)}) AS v(id, score)
        WHERE p."id" = v.id
      `);
    }

    const refreshed = await this.prisma.post.findMany({
      where: { id: { in: ids } },
      select: { id: true, boostScore: true, boostScoreUpdatedAt: true },
    });

    const out = new Map<string, { boostScore: number | null; boostScoreUpdatedAt: Date | null }>();
    for (const p of refreshed) out.set(p.id, { boostScore: p.boostScore ?? null, boostScoreUpdatedAt: p.boostScoreUpdatedAt });
    return out;
  }

  /**
   * Computes the overall popularity score for given post IDs (same formula as popular feed).
   * Call ensureBoostScoresFresh first so boostScore is up to date.
   */
  async computeScoresForPostIds(postIds: string[]): Promise<Map<string, number>> {
    const ids = [...new Set((postIds ?? []).filter(Boolean))];
    if (ids.length === 0) return new Map<string, number>();

    const snapshotAsOf = new Date();
    const lookbackMs = PostsService.popularLookbackDays * 24 * 60 * 60 * 1000;
    const snapshotMinCreatedAt = new Date(snapshotAsOf.getTime() - lookbackMs);

    const rows = await this.prisma.$queryRaw<Array<{ id: string; score: number }>>(Prisma.sql`
      WITH
      comment_scores AS (
        SELECT
          p."parentId" as "postId",
          CAST(
            SUM(
              POWER(
                0.5,
                GREATEST(
                  0,
                  EXTRACT(EPOCH FROM (${snapshotAsOf}::timestamptz - p."createdAt"))
                ) / ${PostsService.popularHalfLifeSeconds}
              )
            ) AS DOUBLE PRECISION
          ) as "commentScore"
        FROM "Post" p
        WHERE
          p."parentId" IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}`))})
          AND p."deletedAt" IS NULL
          AND p."createdAt" >= ${snapshotMinCreatedAt}
        GROUP BY p."parentId"
      ),
      scored AS (
        SELECT
          p."id" as "id",
          CAST(
            (
              CASE
                WHEN p."boostScore" IS NULL OR p."boostScoreUpdatedAt" IS NULL THEN 0
                ELSE p."boostScore" * POWER(
                  0.5,
                  GREATEST(
                    0,
                    EXTRACT(EPOCH FROM (${snapshotAsOf}::timestamptz - p."createdAt"))
                  ) / ${PostsService.popularHalfLifeSeconds}
                )
              END
            )
            +
            (
              (p."bookmarkCount"::DOUBLE PRECISION) * 0.5 * POWER(
                0.5,
                GREATEST(
                  0,
                  EXTRACT(EPOCH FROM (${snapshotAsOf}::timestamptz - p."createdAt"))
                ) / ${PostsService.popularHalfLifeSeconds}
              )
            )
            +
            (
              (COALESCE(cs."commentScore", 0)::DOUBLE PRECISION) * ${PostsService.commentScoreWeight}
            )
            +
            (
              CASE
                WHEN u."pinnedPostId" = p."id" THEN
                  (CASE WHEN u."premium" THEN ${PostsService.pinScorePremium} WHEN u."verifiedStatus" <> 'none' THEN ${PostsService.pinScoreVerified} ELSE ${PostsService.pinScoreBase} END)
                  * POWER(
                    0.5,
                    GREATEST(0, EXTRACT(EPOCH FROM (${snapshotAsOf}::timestamptz - p."createdAt"))) / ${PostsService.popularHalfLifeSeconds}
                  )
                ELSE 0
              END
            )
            * (CASE WHEN p."parentId" IS NULL THEN ${PostsService.popularTopLevelScoreBoost} ELSE 1.0 END)
            * POWER(
              ${PostsService.deletedAncestorPenalty},
              (
                (CASE WHEN parent."deletedAt" IS NOT NULL THEN 1 ELSE 0 END)
                +
                (CASE
                  WHEN root."deletedAt" IS NOT NULL AND (parent."id" IS NULL OR root."id" <> parent."id") THEN 1
                  ELSE 0
                END)
              )
            )
            AS DOUBLE PRECISION
          ) as "score"
        FROM "Post" p
        LEFT JOIN "User" u ON u."id" = p."userId"
        LEFT JOIN "Post" parent ON parent."id" = p."parentId"
        LEFT JOIN "Post" root ON root."id" = COALESCE(p."rootId", p."id")
        LEFT JOIN comment_scores cs ON cs."postId" = p."id"
        WHERE p."id" IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}`))})
      )
      SELECT "id", "score" FROM scored
    `);

    return new Map(rows.map((r) => [r.id, r.score]));
  }

  private async getSiteConfig() {
    // Low-churn single row; cache briefly to avoid a DB hit on every create.
    const now = Date.now();
    if (this.siteConfigCache && this.siteConfigCache.expiresAt > now) return this.siteConfigCache.value;

    const cfg = await this.prisma.siteConfig.findUnique({ where: { id: 1 } });
    // If missing (shouldn't happen after migrations), use safe defaults.
    const value =
      cfg ??
      ({
        id: 1,
        postsPerWindow: 5,
        windowSeconds: 300,
        verifiedPostsPerWindow: 5,
        verifiedWindowSeconds: 300,
        premiumPostsPerWindow: 5,
        premiumWindowSeconds: 300,
      } as const);
    this.siteConfigCache = { value, expiresAt: now + 5 * 60 * 1000 };
    return value;
  }

  private siteConfigCache: {
    value: {
      id: number;
      postsPerWindow: number;
      windowSeconds: number;
      verifiedPostsPerWindow: number;
      verifiedWindowSeconds: number;
      premiumPostsPerWindow: number;
      premiumWindowSeconds: number;
    };
    expiresAt: number;
  } | null = null;

  invalidateSiteConfigCache() {
    this.siteConfigCache = null;
  }

  async viewerContext(viewerUserId: string | null) {
    return await this.viewerContextService.getViewer(viewerUserId);
  }

  async viewerBoostedPostIds(params: { viewerUserId: string; postIds: string[] }) {
    const { viewerUserId, postIds } = params;
    if (!viewerUserId) return new Set<string>();
    const ids = (postIds ?? []).filter(Boolean);
    if (ids.length === 0) return new Set<string>();

    const key = `posts.viewerBoosted:${viewerUserId}`;
    const map = this.requestCache.get<Map<string, boolean>>(key) ?? new Map<string, boolean>();
    if (this.requestCache.get<Map<string, boolean>>(key) == null) {
      this.requestCache.set(key, map);
    }

    const missing = ids.filter((id) => !map.has(id));
    if (missing.length > 0) {
      const boosts = await this.prisma.boost.findMany({
        where: { userId: viewerUserId, postId: { in: missing } },
        select: { postId: true },
      });
      const boostedSet = new Set(boosts.map((b) => b.postId));
      for (const id of missing) map.set(id, boostedSet.has(id));
    }

    const out = new Set<string>();
    for (const id of ids) if (map.get(id)) out.add(id);
    return out;
  }

  async viewerBookmarksByPostId(params: { viewerUserId: string; postIds: string[] }) {
    const { viewerUserId, postIds } = params;
    if (!viewerUserId) return new Map<string, { collectionIds: string[] }>();
    const ids = (postIds ?? []).filter(Boolean);
    if (ids.length === 0) return new Map<string, { collectionIds: string[] }>();

    const cacheKey = `posts.viewerBookmarks:${viewerUserId}`;
    const cached =
      this.requestCache.get<Map<string, { collectionIds: string[] } | null>>(cacheKey) ??
      new Map<string, { collectionIds: string[] } | null>();
    if (this.requestCache.get<Map<string, { collectionIds: string[] } | null>>(cacheKey) == null) {
      this.requestCache.set(cacheKey, cached);
    }

    const missing = ids.filter((id) => !cached.has(id));

    let rows: Array<{ postId: string; collections: Array<{ collectionId: string }> }>;
    try {
      rows = missing.length
        ? await this.prisma.bookmark.findMany({
            where: { userId: viewerUserId, postId: { in: missing } },
            select: { postId: true, collections: { select: { collectionId: true } } },
          })
        : [];
    } catch (e: unknown) {
      // If migrations haven't been applied yet, don't crash the entire feed.
      // Prisma throws P2021 when the underlying table doesn't exist.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2021') {
        return new Map<string, { collectionIds: string[] }>();
      }
      throw e;
    }

    // Populate cache with missing IDs (including explicit nulls for "not bookmarked").
    for (const id of missing) cached.set(id, null);
    for (const r of rows) {
      cached.set(r.postId, { collectionIds: (r.collections ?? []).map((c) => c.collectionId) });
    }

    const out = new Map<string, { collectionIds: string[] }>();
    for (const id of ids) {
      const v = cached.get(id);
      if (v) out.set(id, v);
    }
    return out;
  }

  async viewerVotedPollOptionIdByPostId(params: { viewerUserId: string; postIds: string[] }) {
    const { viewerUserId, postIds } = params;
    if (!viewerUserId) return new Map<string, string>();
    const ids = (postIds ?? []).filter(Boolean);
    if (ids.length === 0) return new Map<string, string>();

    const cacheKey = `posts.viewerPollVotes:${viewerUserId}`;
    const cached =
      this.requestCache.get<Map<string, string | null>>(cacheKey) ??
      new Map<string, string | null>();
    if (this.requestCache.get<Map<string, string | null>>(cacheKey) == null) {
      this.requestCache.set(cacheKey, cached);
    }

    const missing = ids.filter((id) => !cached.has(id));
    if (missing.length > 0) {
      const rows = await this.prisma.postPollVote.findMany({
        where: { userId: viewerUserId, poll: { postId: { in: missing } } },
        select: { optionId: true, poll: { select: { postId: true } } },
      });
      for (const id of missing) cached.set(id, null);
      for (const r of rows) cached.set(r.poll.postId, r.optionId);
    }

    const out = new Map<string, string>();
    for (const id of ids) {
      const v = cached.get(id);
      if (v) out.set(id, v);
    }
    return out;
  }

  private allowedVisibilitiesForViewer(viewer: Pick<ViewerContext, 'verifiedStatus' | 'premium' | 'premiumPlus'> | null) {
    return this.viewerContextService.allowedPostVisibilities(viewer);
  }

  async listOnlyMe(params: { userId: string; limit: number; cursor: string | null }) {
    const { userId, limit, cursor } = params;

    const cursorWhere = await createdAtIdCursorWhere({
      cursor,
      lookup: async (id) => await this.prisma.post.findUnique({ where: { id }, select: { id: true, createdAt: true } }),
    });

    const posts = await this.prisma.post.findMany({
      where: {
        AND: [
          { userId, visibility: 'onlyMe', parentId: null, isDraft: false, ...this.notDeletedWhere() },
          ...(cursorWhere ? [cursorWhere] : []),
        ],
      },
      include: feedPostInclude,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });

    const slice = posts.slice(0, limit);
    const nextCursor = posts.length > limit ? slice[slice.length - 1]?.id ?? null : null;
    return { posts: slice, nextCursor };
  }

  async listFeed(params: {
    viewerUserId: string | null;
    limit: number;
    cursor: string | null;
    visibility: 'all' | PostVisibility;
    followingOnly: boolean;
    authorUserIds?: string[] | null;
  }): Promise<FeedResult> {
    const { viewerUserId, limit, cursor, visibility, followingOnly } = params;
    const authorUserIds = (params.authorUserIds ?? null)?.map((s) => (s ?? '').trim()).filter(Boolean) ?? null;

    const viewer = await this.viewerContextService.getViewer(viewerUserId);

    const allowed = this.allowedVisibilitiesForViewer(viewer);

    if (visibility === 'verifiedOnly') {
      if (!viewer || viewer.verifiedStatus === 'none') throw new ForbiddenException('Verify to view verified-only posts.');
    }
    if (visibility === 'premiumOnly') {
      if (!viewer || !viewer.premium) throw new ForbiddenException('Upgrade to premium to view premium-only posts.');
    }

    if (followingOnly && !viewerUserId) {
      return { posts: [], nextCursor: null };
    }

    // Author always sees own posts (e.g. after tier downgrade); others filtered by allowed visibility.
    const baseVisibility =
      visibility === 'all'
        ? ({ visibility: { in: allowed } } as Prisma.PostWhereInput)
        : visibility === 'public'
          ? ({ visibility: 'public' } as Prisma.PostWhereInput)
          : ({ visibility } as Prisma.PostWhereInput);
    
    // IMPORTANT: Only apply "author sees own posts" override when visibility='all'.
    // When user explicitly filters by a specific visibility, respect that filter even for their own posts.
    const visibilityWhere =
      viewerUserId && visibility === 'all'
        ? ({
            OR: [
              baseVisibility,
              // Author sees own posts (e.g. after tier downgrade), but never include only-me outside /only-me.
              { userId: viewerUserId, visibility: { not: 'onlyMe' } },
            ],
          } as Prisma.PostWhereInput)
        : baseVisibility;

    if (authorUserIds && authorUserIds.length === 0) {
      return { posts: [], nextCursor: null };
    }

    const where = followingOnly
      ? {
          AND: [
            visibilityWhere,
            this.notDeletedWhere(),
            ...(authorUserIds?.length ? ([{ userId: { in: authorUserIds } }] as Prisma.PostWhereInput[]) : []),
            {
              OR: [
                { userId: viewerUserId as string },
                { user: { followers: { some: { followerId: viewerUserId as string } } } },
              ],
            },
          ],
        }
      : {
          AND: [
            visibilityWhere,
            this.notDeletedWhere(),
            ...(authorUserIds?.length ? ([{ userId: { in: authorUserIds } }] as Prisma.PostWhereInput[]) : []),
          ],
        };

    const cursorWhere = await createdAtIdCursorWhere({
      cursor,
      lookup: async (id) => await this.prisma.post.findUnique({ where: { id }, select: { id: true, createdAt: true } }),
    });
    const whereWithCursor = cursorWhere ? ({ AND: [where, cursorWhere] } as Prisma.PostWhereInput) : where;

    const posts = await this.prisma.post.findMany({
      where: whereWithCursor,
      include: feedPostInclude,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });

    const slice = posts.slice(0, limit);
    const nextCursor = posts.length > limit ? slice[slice.length - 1]?.id ?? null : null;

    return { posts: slice, nextCursor };
  }

  /**
   * Returns [viewerUserId, ...userIds the viewer follows] for "following" feed scope.
   * Used by trending (popular) feed when followingOnly is true.
   */
  private async getAuthorIdsForFollowingFilter(viewerUserId: string): Promise<string[]> {
    const follows = await this.prisma.follow.findMany({
      where: { followerId: viewerUserId },
      select: { followingId: true },
    });
    const followingIds = follows.map((f) => f.followingId);
    return [viewerUserId, ...followingIds];
  }

  private async listPopularFeedFromSnapshot(params: {
    viewerUserId: string | null;
    limit: number;
    decodedCursor: { asOf: string; score: number; createdAt: string; id: string } | null;
    visibility: 'all' | PostVisibility;
    allowed: PostVisibility[];
    authorUserIds: string[] | null;
  }): Promise<PopularFeedResult | null> {
    const { viewerUserId, limit, decodedCursor, visibility, allowed, authorUserIds } = params;

    const asOf = decodedCursor ? new Date(decodedCursor.asOf) : null;
    const snapshotAsOf =
      asOf ??
      (await this.prisma.postPopularScoreSnapshot.findFirst({
        orderBy: [{ asOf: 'desc' }],
        select: { asOf: true },
      }))?.asOf ??
      null;

    if (!snapshotAsOf) return null;

    const baseVisibilityWhere: Prisma.PostPopularScoreSnapshotWhereInput =
      visibility === 'all'
        ? ({ visibility: { in: allowed } } as Prisma.PostPopularScoreSnapshotWhereInput)
        : visibility === 'public'
          ? ({ visibility: 'public' } as Prisma.PostPopularScoreSnapshotWhereInput)
          : ({ visibility } as Prisma.PostPopularScoreSnapshotWhereInput);

    // IMPORTANT: Only apply "author sees own posts" override when visibility='all'.
    // When user explicitly filters by a specific visibility, respect that filter even for their own posts.
    const visibilityWhere: Prisma.PostPopularScoreSnapshotWhereInput =
      viewerUserId && visibility === 'all'
        ? ({
            OR: [
              baseVisibilityWhere,
              { userId: viewerUserId, visibility: { not: 'onlyMe' } },
            ],
          } as Prisma.PostPopularScoreSnapshotWhereInput)
        : baseVisibilityWhere;

    const cursorCreatedAt = decodedCursor ? new Date(decodedCursor.createdAt) : null;
    const cursorScore = decodedCursor?.score ?? null;
    const cursorId = decodedCursor?.id ?? null;

    const cursorWhere: Prisma.PostPopularScoreSnapshotWhereInput =
      decodedCursor && cursorCreatedAt && cursorScore != null && cursorId
        ? ({
            OR: [
              { score: { lt: cursorScore } },
              {
                AND: [
                  { score: cursorScore },
                  {
                    OR: [
                      { createdAt: { lt: cursorCreatedAt } },
                      { AND: [{ createdAt: cursorCreatedAt }, { postId: { lt: cursorId } }] },
                    ],
                  },
                ],
              },
            ],
          } as Prisma.PostPopularScoreSnapshotWhereInput)
        : {};

    const rows = await this.prisma.postPopularScoreSnapshot.findMany({
      where: {
        asOf: snapshotAsOf,
        ...(authorUserIds?.length ? ({ userId: { in: authorUserIds } } as Prisma.PostPopularScoreSnapshotWhereInput) : {}),
        ...visibilityWhere,
        ...cursorWhere,
      },
      orderBy: [{ score: 'desc' }, { createdAt: 'desc' }, { postId: 'desc' }],
      take: limit + 1,
      select: { postId: true, createdAt: true, score: true },
    });

    // If caller asked for a specific asOf (cursor pagination) but we no longer retain that snapshot, return null and fallback.
    if (decodedCursor && rows.length === 0) return null;

    const sliceRows = rows.slice(0, limit);
    const ids = sliceRows.map((r) => r.postId);
    const nextRow = rows.length > limit ? sliceRows[sliceRows.length - 1] ?? null : null;

    const posts = ids.length
      ? await this.prisma.post.findMany({
          where: { id: { in: ids }, ...this.notDeletedWhere() },
          include: feedPostInclude,
        })
      : [];
    const byId = new Map(posts.map((p) => [p.id, p] as const));
    const ordered = ids.map((id) => byId.get(id)).filter((p): p is (typeof posts)[number] => Boolean(p));

    const nextCursor =
      rows.length > limit && nextRow
        ? this.encodePopularCursor({
            asOf: snapshotAsOf.toISOString(),
            score: nextRow.score,
            createdAt: nextRow.createdAt.toISOString(),
            id: nextRow.postId,
          })
        : null;

    const scoreByPostId = new Map<string, number>(sliceRows.map((r) => [r.postId, r.score]));
    return { posts: ordered, nextCursor, scoreByPostId };
  }

  private async listFeaturedFeedFromSnapshot(params: {
    viewerUserId: string | null;
    limit: number;
    decodedCursor: { asOf: string; score: number; createdAt: string; id: string } | null;
    visibility: 'all' | PostVisibility;
    allowed: PostVisibility[];
    authorUserIds: string[] | null;
  }): Promise<PopularFeedResult | null> {
    const { viewerUserId, limit, decodedCursor, visibility, allowed, authorUserIds } = params;

    const asOf = decodedCursor ? new Date(decodedCursor.asOf) : null;
    const snapshotAsOf =
      asOf ??
      (await this.prisma.postPopularScoreSnapshot.findFirst({
        orderBy: [{ asOf: 'desc' }],
        select: { asOf: true },
      }))?.asOf ??
      null;

    if (!snapshotAsOf) return null;

    const baseVisibilityWhere: Prisma.PostPopularScoreSnapshotWhereInput =
      visibility === 'all'
        ? ({ visibility: { in: allowed } } as Prisma.PostPopularScoreSnapshotWhereInput)
        : visibility === 'public'
          ? ({ visibility: 'public' } as Prisma.PostPopularScoreSnapshotWhereInput)
          : ({ visibility } as Prisma.PostPopularScoreSnapshotWhereInput);

    // IMPORTANT: Only apply "author sees own posts" override when visibility='all'.
    // When user explicitly filters by a specific visibility, respect that filter even for their own posts.
    const visibilityWhere: Prisma.PostPopularScoreSnapshotWhereInput =
      viewerUserId && visibility === 'all'
        ? ({
            OR: [
              baseVisibilityWhere,
              { userId: viewerUserId, visibility: { not: 'onlyMe' } },
            ],
          } as Prisma.PostPopularScoreSnapshotWhereInput)
        : baseVisibilityWhere;

    const cursorCreatedAt = decodedCursor ? new Date(decodedCursor.createdAt) : null;
    const cursorScore = decodedCursor?.score ?? null;
    const cursorId = decodedCursor?.id ?? null;

    const cursorWhere: Prisma.PostPopularScoreSnapshotWhereInput =
      decodedCursor && cursorCreatedAt && cursorScore != null && cursorId
        ? ({
            OR: [
              { score: { lt: cursorScore } },
              {
                AND: [
                  { score: cursorScore },
                  {
                    OR: [
                      { createdAt: { lt: cursorCreatedAt } },
                      { AND: [{ createdAt: cursorCreatedAt }, { postId: { lt: cursorId } }] },
                    ],
                  },
                ],
              },
            ],
          } as Prisma.PostPopularScoreSnapshotWhereInput)
        : {};

    const lookbackMs = PostsService.featuredLookbackDays * 24 * 60 * 60 * 1000;
    const minCreatedAt = new Date(snapshotAsOf.getTime() - lookbackMs);

    const scanTake = Math.min(PostsService.featuredScanTakeMax, Math.max(limit * 40, limit + 1));

    const rows = await this.prisma.postPopularScoreSnapshot.findMany({
      where: {
        asOf: snapshotAsOf,
        parentId: null,
        createdAt: { gte: minCreatedAt },
        // Featured on Explore: never show the viewer their own posts.
        ...(viewerUserId ? ({ userId: { not: viewerUserId } } as Prisma.PostPopularScoreSnapshotWhereInput) : {}),
        ...(authorUserIds?.length ? ({ userId: { in: authorUserIds } } as Prisma.PostPopularScoreSnapshotWhereInput) : {}),
        ...visibilityWhere,
        ...cursorWhere,
      },
      orderBy: [{ score: 'desc' }, { createdAt: 'desc' }, { postId: 'desc' }],
      take: scanTake,
      select: { postId: true, createdAt: true, score: true, userId: true },
    });

    // If caller asked for a specific asOf (cursor pagination) but we no longer retain that snapshot, return null and fallback.
    if (decodedCursor && rows.length === 0) return null;

    if (decodedCursor) {
      const picked: Array<{ postId: string; createdAt: Date; score: number; userId: string }> = [];
      const perAuthor = new Map<string, number>();

      for (const r of rows) {
        if (picked.length >= limit + 1) break;
        const n = perAuthor.get(r.userId) ?? 0;
        if (n >= PostsService.featuredMaxPerAuthor) continue;
        perAuthor.set(r.userId, n + 1);
        picked.push(r);
      }

      const sliceRows = picked.slice(0, limit);
      const ids = sliceRows.map((r) => r.postId);
      const boundaryRow = sliceRows.length > 0 ? sliceRows[sliceRows.length - 1] : null;

      const posts = ids.length
        ? await this.prisma.post.findMany({
            where: { id: { in: ids }, ...this.notDeletedWhere() },
            include: feedPostInclude,
          })
        : [];
      const byId = new Map(posts.map((p) => [p.id, p] as const));
      const ordered = ids.map((id) => byId.get(id)).filter((p): p is (typeof posts)[number] => Boolean(p));

      const nextCursor =
        picked.length > limit && boundaryRow
          ? this.encodePopularCursor({
              asOf: snapshotAsOf.toISOString(),
              score: boundaryRow.score,
              createdAt: boundaryRow.createdAt.toISOString(),
              id: boundaryRow.postId,
            })
          : null;

      const scoreByPostId = new Map<string, number>(sliceRows.map((r) => [r.postId, r.score]));
      return { posts: ordered, nextCursor, scoreByPostId };
    }

    // First page only: blend two buckets so Explore "Featured" feels fresh.
    // Cursor pagination continues using the stable snapshot ordering path above.
    const topTake = Math.max(1, Math.min(limit, Math.round(limit * PostsService.featuredRisingMixTopRatio)));
    const risingTake = Math.max(0, limit - topTake);

    const perAuthor = new Map<string, number>();
    const topPicked: Array<{ postId: string; createdAt: Date; score: number; userId: string }> = [];
    for (const r of rows) {
      if (topPicked.length >= topTake + 1) break; // keep one extra for cursor
      const n = perAuthor.get(r.userId) ?? 0;
      if (n >= PostsService.featuredMaxPerAuthor) continue;
      perAuthor.set(r.userId, n + 1);
      topPicked.push(r);
    }

    const topSlice = topPicked.slice(0, topTake);
    const topBoundaryRow = topSlice.length > 0 ? topSlice[topSlice.length - 1] : null;
    const nextCursor =
      topPicked.length > topTake && topBoundaryRow
        ? this.encodePopularCursor({
            asOf: snapshotAsOf.toISOString(),
            score: topBoundaryRow.score,
            createdAt: topBoundaryRow.createdAt.toISOString(),
            id: topBoundaryRow.postId,
          })
        : null;

    const excludePostIds = topSlice.map((r) => r.postId);
    const excludePostIdsSql =
      excludePostIds.length > 0
        ? Prisma.sql`AND p."id" NOT IN (${Prisma.join(excludePostIds.map((id) => Prisma.sql`${id}`))})`
        : Prisma.sql``;

    const excludeAuthorIds = Array.from(perAuthor.keys());
    const excludeAuthorIdsSql =
      excludeAuthorIds.length > 0
        ? Prisma.sql`AND p."userId" NOT IN (${Prisma.join(excludeAuthorIds.map((id) => Prisma.sql`${id}`))})`
        : Prisma.sql``;

    const excludeSelfSql = viewerUserId ? Prisma.sql`AND p."userId" <> ${viewerUserId}` : Prisma.sql``;
    const authorFilterSql =
      authorUserIds?.length
        ? Prisma.sql`AND p."userId" IN (${Prisma.join(authorUserIds.map((id) => Prisma.sql`${id}`))})`
        : Prisma.sql``;

    const risingWindowMs = PostsService.featuredRisingWindowHours * 60 * 60 * 1000;
    const risingMinCreatedAt = new Date(snapshotAsOf.getTime() - risingWindowMs);

    const risingVisibilitiesForQuery: PostVisibility[] =
      visibility === 'all' ? allowed : visibility === 'public' ? (['public'] as PostVisibility[]) : ([visibility] as PostVisibility[]);
    const risingVisibilitiesForQuerySql = risingVisibilitiesForQuery.map((v) => Prisma.sql`${v}::"PostVisibility"`);
    const risingVisibilityFilterSql = Prisma.sql`AND p."visibility" IN (${Prisma.join(risingVisibilitiesForQuerySql)})`;

    const risingRows =
      risingTake > 0
        ? await this.prisma.$queryRaw<Array<{ id: string; createdAt: Date; score: number; userId: string }>>(Prisma.sql`
            WITH
            comment_scores AS (
              SELECT
                p."parentId" as "postId",
                CAST(
                  SUM(
                    POWER(
                      0.5,
                      GREATEST(
                        0,
                        EXTRACT(EPOCH FROM (${snapshotAsOf}::timestamptz - p."createdAt"))
                      ) / ${PostsService.featuredRisingHalfLifeSeconds}
                    )
                  ) AS DOUBLE PRECISION
                ) as "commentScore"
              FROM "Post" p
              WHERE
                p."parentId" IS NOT NULL
                AND p."deletedAt" IS NULL
                AND p."createdAt" >= ${risingMinCreatedAt}
              GROUP BY p."parentId"
            ),
            candidates AS (
              SELECT p."id"
              FROM "Post" p
              WHERE
                p."deletedAt" IS NULL
                AND p."parentId" IS NULL
                AND p."createdAt" >= ${risingMinCreatedAt}
                ${risingVisibilityFilterSql}
                ${excludeSelfSql}
                ${authorFilterSql}
                ${excludePostIdsSql}
                ${excludeAuthorIdsSql}
                AND (p."boostCount" > 0 OR p."bookmarkCount" > 0 OR p."commentCount" > 0)
              ORDER BY (p."boostCount" + p."bookmarkCount" + p."commentCount") DESC, p."createdAt" DESC, p."id" DESC
              LIMIT 2000
            ),
            latest_hashtag_snapshot AS (
              SELECT (
                SELECT s."asOf"
                FROM "HashtagTrendingScoreSnapshot" s
                ORDER BY s."asOf" DESC
                LIMIT 1
              ) as "asOf"
            ),
            hashtag_global AS (
              SELECT
                CAST(MAX(h."score") AS DOUBLE PRECISION) as "maxScore"
              FROM "HashtagTrendingScoreSnapshot" h
              JOIN latest_hashtag_snapshot lhs ON TRUE
              WHERE
                lhs."asOf" IS NOT NULL
                AND h."asOf" = lhs."asOf"
                AND h."visibility" IN (${Prisma.join(risingVisibilitiesForQuerySql)})
            ),
            post_hashtag_scores AS (
              SELECT
                p."id" as "postId",
                CAST(MAX(h."score") AS DOUBLE PRECISION) as "maxTagScore"
              FROM "Post" p
              JOIN candidates c ON c."id" = p."id"
              CROSS JOIN LATERAL UNNEST(p."hashtags") AS t
              JOIN latest_hashtag_snapshot lhs ON TRUE
              LEFT JOIN "HashtagTrendingScoreSnapshot" h ON
                lhs."asOf" IS NOT NULL
                AND h."asOf" = lhs."asOf"
                AND h."visibility" = p."visibility"
                AND h."tag" = LOWER(TRIM(t))
              WHERE LOWER(TRIM(t)) <> ''
              GROUP BY p."id"
            ),
            scored AS (
              SELECT
                p."id" as "id",
                p."createdAt" as "createdAt",
                p."userId" as "userId",
                CAST(
                  (
                    CASE
                    WHEN p."boostScore" IS NULL OR p."boostScoreUpdatedAt" IS NULL THEN 0
                    ELSE p."boostScore" * POWER(
                      0.5,
                      GREATEST(
                        0,
                        EXTRACT(EPOCH FROM (${snapshotAsOf}::timestamptz - p."createdAt"))
                      ) / ${PostsService.featuredRisingHalfLifeSeconds}
                    )
                    END
                  )
                  +
                  (
                    (p."bookmarkCount"::DOUBLE PRECISION) * 0.5 * POWER(
                      0.5,
                      GREATEST(
                        0,
                        EXTRACT(EPOCH FROM (${snapshotAsOf}::timestamptz - p."createdAt"))
                      ) / ${PostsService.featuredRisingHalfLifeSeconds}
                    )
                  )
                  +
                  (
                    (COALESCE(cs."commentScore", 0)::DOUBLE PRECISION) * ${PostsService.commentScoreWeight}
                  )
                  +
                  (
                    CASE
                      WHEN hs."maxTagScore" IS NULL OR hs."maxTagScore" <= 0 THEN 0
                      ELSE
                        ${PostsService.popularTrendingHashtagBaseBonus}
                        +
                        COALESCE(
                          LEAST(
                            1.0,
                            hs."maxTagScore" / NULLIF(hg."maxScore", 0)
                          ),
                          0
                        ) * ${PostsService.popularTrendingHashtagMaxScaledBonus}
                    END
                  )
                  +
                  (
                    CASE
                      WHEN u."pinnedPostId" = p."id" THEN
                        (CASE WHEN u."premium" THEN ${PostsService.pinScorePremium} WHEN u."verifiedStatus" <> 'none' THEN ${PostsService.pinScoreVerified} ELSE ${PostsService.pinScoreBase} END)
                        * POWER(
                          0.5,
                          GREATEST(0, EXTRACT(EPOCH FROM (${snapshotAsOf}::timestamptz - p."createdAt"))) / ${PostsService.featuredRisingHalfLifeSeconds}
                        )
                      ELSE 0
                    END
                  )
                  * ${PostsService.popularTopLevelScoreBoost}
                  AS DOUBLE PRECISION
                ) as "score"
              FROM "Post" p
              JOIN candidates c ON c."id" = p."id"
              LEFT JOIN "User" u ON u."id" = p."userId"
              LEFT JOIN comment_scores cs ON cs."postId" = p."id"
              CROSS JOIN hashtag_global hg
              LEFT JOIN post_hashtag_scores hs ON hs."postId" = p."id"
            )
            SELECT "id", "createdAt", "score", "userId"
            FROM scored
            WHERE "score" > 0
            ORDER BY "score" DESC, "createdAt" DESC, "id" DESC
            LIMIT 200
          `)
        : [];

    const risingPicked: Array<{ postId: string; createdAt: Date; score: number; userId: string }> = [];
    for (const r of risingRows) {
      if (risingPicked.length >= risingTake) break;
      const n = perAuthor.get(r.userId) ?? 0;
      if (n >= PostsService.featuredMaxPerAuthor) continue;
      perAuthor.set(r.userId, n + 1);
      risingPicked.push({ postId: r.id, createdAt: r.createdAt, score: r.score, userId: r.userId });
    }

    // Interleave so Explore doesn't show "2 old + 1 new" clumped.
    const combined: Array<{ postId: string; createdAt: Date; score: number; userId: string }> = [];
    const topQueue = [...topSlice];
    const risingQueue = [...risingPicked];
    while (combined.length < limit && (topQueue.length > 0 || risingQueue.length > 0)) {
      if (topQueue.length > 0) combined.push(topQueue.shift()!);
      if (combined.length >= limit) break;
      if (risingQueue.length > 0) combined.push(risingQueue.shift()!);
    }

    const ids = combined.map((r) => r.postId);
    const posts = ids.length
      ? await this.prisma.post.findMany({
          where: { id: { in: ids }, ...this.notDeletedWhere() },
          include: feedPostInclude,
        })
      : [];
    const byId = new Map(posts.map((p) => [p.id, p] as const));
    const ordered = ids.map((id) => byId.get(id)).filter((p): p is (typeof posts)[number] => Boolean(p));

    const scoreByPostId = new Map<string, number>(combined.map((r) => [r.postId, r.score]));
    return { posts: ordered, nextCursor, scoreByPostId };
  }

  /**
   * Trending feed: same half-life boost + bookmark scoring everywhere.
   * Scope: site-wide (authorUserIds null), or only from authors [viewer + followed] (home "following"), or one user (profile).
   */
  async listPopularFeed(params: {
    viewerUserId: string | null;
    limit: number;
    cursor: string | null;
    visibility: 'all' | PostVisibility;
    followingOnly?: boolean;
    authorUserIds?: string[] | null;
  }): Promise<PopularFeedResult> {
    const { viewerUserId, limit, cursor, visibility, followingOnly = false } = params;
    const requestedAuthorUserIds =
      (params.authorUserIds ?? null)?.map((s) => (s ?? '').trim()).filter(Boolean).slice(0, 50) ?? null;

    const viewer = await this.viewerContextService.getViewer(viewerUserId);
    const allowed = this.allowedVisibilitiesForViewer(viewer);

    if (visibility === 'verifiedOnly') {
      if (!viewer || viewer.verifiedStatus === 'none') throw new ForbiddenException('Verify to view verified-only posts.');
    }
    if (visibility === 'premiumOnly') {
      if (!viewer || !viewer.premium) throw new ForbiddenException('Upgrade to premium to view premium-only posts.');
    }

    if (followingOnly && !viewerUserId) {
      return { posts: [], nextCursor: null, scoreByPostId: new Map() };
    }

    const followingAuthorIds: string[] | null =
      followingOnly && viewerUserId ? await this.getAuthorIdsForFollowingFilter(viewerUserId) : null;

    const authorUserIds: string[] | null = requestedAuthorUserIds?.length
      ? followingAuthorIds?.length
        ? followingAuthorIds.filter((id) => requestedAuthorUserIds.includes(id))
        : requestedAuthorUserIds
      : followingAuthorIds;

    if (requestedAuthorUserIds && requestedAuthorUserIds.length === 0) {
      return { posts: [], nextCursor: null, scoreByPostId: new Map() };
    }
    if (authorUserIds && authorUserIds.length === 0) {
      // Intersection produced empty set.
      return { posts: [], nextCursor: null, scoreByPostId: new Map() };
    }

    const visibilityWhere =
      visibility === 'all'
        ? ({ visibility: { in: allowed } } as Prisma.PostWhereInput)
        : visibility === 'public'
          ? ({ visibility: 'public' } as Prisma.PostWhereInput)
          : ({ visibility } as Prisma.PostWhereInput);

    const visibilitiesForQuery: PostVisibility[] =
      visibility === 'all' ? allowed : visibility === 'public' ? (['public'] as PostVisibility[]) : ([visibility] as PostVisibility[]);
    const visibilitiesForQuerySql = visibilitiesForQuery.map((v) => Prisma.sql`${v}::"PostVisibility"`);

    const decoded = this.decodePopularCursor(cursor);

    // Fast path: if we have a precomputed snapshot table, use it.
    // Fallback to request-time scoring when snapshots are missing (fresh env, retention window, etc).
    const snapshotResult = await this.listPopularFeedFromSnapshot({
      viewerUserId,
      limit,
      decodedCursor: decoded,
      visibility,
      allowed,
      authorUserIds,
    });
    if (snapshotResult) return snapshotResult;

    // Stable pagination: keep a consistent "as-of" timestamp across pages.
    // First page: we warm up scores for likely-top posts, then snapshot `asOf`.
    const asOf = decoded ? new Date(decoded.asOf) : new Date();
    const asOfMs = asOf.getTime();
    const lookbackMs = PostsService.popularLookbackDays * 24 * 60 * 60 * 1000;
    const minCreatedAt = new Date(asOfMs - lookbackMs);

    const warmupAuthorFilter = authorUserIds?.length
      ? ({ userId: { in: authorUserIds } } as Prisma.PostWhereInput)
      : undefined;

    // IMPORTANT: Only apply "author sees own posts" override when visibility='all'.
    // When user explicitly filters by a specific visibility, respect that filter even for their own posts.
    const popularVisibilityWhere =
      viewerUserId && visibility === 'all'
        ? ({
            OR: [
              visibilityWhere,
              // Author sees own posts (e.g. after tier downgrade), but never include only-me outside /only-me.
              { userId: viewerUserId, visibility: { not: 'onlyMe' } },
            ],
          } as Prisma.PostWhereInput)
        : visibilityWhere;

    if (!decoded) {
      const staleBefore = new Date(asOfMs - PostsService.boostScoreTtlMs);
      const warmup = await this.prisma.post.findMany({
        where: {
          AND: [
            popularVisibilityWhere,
            { parentId: null },
            ...(warmupAuthorFilter ? [warmupAuthorFilter] : []),
            this.notDeletedWhere(),
            { createdAt: { gte: minCreatedAt } },
            { boostCount: { gt: 0 } },
            { OR: [{ boostScoreUpdatedAt: null }, { boostScoreUpdatedAt: { lt: staleBefore } }] },
          ],
        },
        orderBy: [{ boostCount: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
        take: PostsService.popularWarmupTake,
        select: { id: true },
      });

      await this.ensureBoostScoresFresh(warmup.map((p) => p.id));
    }

    // Snapshot `asOf` *after* any warmup updates, so we never "amplify" scores.
    const snapshotAsOf = decoded ? asOf : new Date();
    const snapshotMinCreatedAt = new Date(snapshotAsOf.getTime() - lookbackMs);
    const recentCutoff = new Date(snapshotAsOf.getTime() - PostsService.popularRecentWindowHours * 60 * 60 * 1000);

    const cursorCreatedAt = decoded ? new Date(decoded.createdAt) : null;
    const cursorScore = decoded?.score ?? null;
    const cursorId = decoded?.id ?? null;

    const authorFilterSql =
      authorUserIds?.length
        ? Prisma.sql`AND p."userId" IN (${Prisma.join(authorUserIds.map((id) => Prisma.sql`${id}`))})`
        : Prisma.sql``;

    // IMPORTANT: Only apply "author sees own posts" override when visibility='all'.
    // When user explicitly filters by a specific visibility, respect that filter even for their own posts.
    const visibilityFilterSql =
      viewerUserId && visibility === 'all'
        ? Prisma.sql`AND (p."visibility" IN (${Prisma.join(visibilitiesForQuerySql)}) OR (p."userId" = ${viewerUserId} AND p."visibility" <> 'onlyMe'))`
        : Prisma.sql`AND p."visibility" IN (${Prisma.join(visibilitiesForQuerySql)})`;

    const rows = await this.prisma.$queryRaw<Array<{ id: string; createdAt: Date; score: number }>>(Prisma.sql`
      WITH
      comment_scores AS (
        SELECT
          p."parentId" as "postId",
          CAST(
            SUM(
              POWER(
                0.5,
                GREATEST(
                  0,
                  EXTRACT(EPOCH FROM (${snapshotAsOf}::timestamptz - p."createdAt"))
                ) / ${PostsService.popularHalfLifeSeconds}
              )
            ) AS DOUBLE PRECISION
          ) as "commentScore"
        FROM "Post" p
        WHERE
          p."parentId" IS NOT NULL
          AND p."deletedAt" IS NULL
          AND p."createdAt" >= ${snapshotMinCreatedAt}
        GROUP BY p."parentId"
      ),
      candidates AS (
        SELECT u."id" as "id"
        FROM (
          (
            -- Recency bucket: include recent posts even with no engagement.
            SELECT p."id"
            FROM "Post" p
            WHERE
              p."deletedAt" IS NULL
              AND p."parentId" IS NULL
              AND p."createdAt" >= ${snapshotMinCreatedAt}
              AND p."createdAt" >= ${recentCutoff}
              ${visibilityFilterSql}
              ${authorFilterSql}
            ORDER BY p."createdAt" DESC, p."id" DESC
            LIMIT ${PostsService.popularCandidatesRecentTake}
          )
          UNION
          (
            -- Engagement buckets: top boosted, bookmarked, and commented.
            SELECT p."id"
            FROM "Post" p
            WHERE
              p."deletedAt" IS NULL
              AND p."parentId" IS NULL
              AND p."createdAt" >= ${snapshotMinCreatedAt}
              AND p."boostCount" > 0
              ${visibilityFilterSql}
              ${authorFilterSql}
            ORDER BY p."boostCount" DESC, p."createdAt" DESC, p."id" DESC
            LIMIT ${PostsService.popularCandidatesBoostedTake}
          )
          UNION
          (
            SELECT p."id"
            FROM "Post" p
            WHERE
              p."deletedAt" IS NULL
              AND p."parentId" IS NULL
              AND p."createdAt" >= ${snapshotMinCreatedAt}
              AND p."bookmarkCount" > 0
              ${visibilityFilterSql}
              ${authorFilterSql}
            ORDER BY p."bookmarkCount" DESC, p."createdAt" DESC, p."id" DESC
            LIMIT ${PostsService.popularCandidatesBookmarkedTake}
          )
          UNION
          (
            SELECT p."id"
            FROM "Post" p
            WHERE
              p."deletedAt" IS NULL
              AND p."parentId" IS NULL
              AND p."createdAt" >= ${snapshotMinCreatedAt}
              AND p."commentCount" > 0
              ${visibilityFilterSql}
              ${authorFilterSql}
            ORDER BY p."commentCount" DESC, p."createdAt" DESC, p."id" DESC
            LIMIT ${PostsService.popularCandidatesCommentedTake}
          )
          UNION
          (
            -- Replies with engagement can become popular; top-level posts get a slight boost in scoring.
            SELECT p."id"
            FROM "Post" p
            WHERE
              p."deletedAt" IS NULL
              AND p."parentId" IS NOT NULL
              AND p."createdAt" >= ${snapshotMinCreatedAt}
              AND (p."boostCount" > 0 OR p."bookmarkCount" > 0)
              ${visibilityFilterSql}
              ${authorFilterSql}
            ORDER BY (p."boostCount" + p."bookmarkCount") DESC, p."createdAt" DESC, p."id" DESC
            LIMIT ${PostsService.popularCandidatesRepliesTake}
          )
        ) u
        GROUP BY u."id"
      ),
      latest_hashtag_snapshot AS (
        SELECT (
          SELECT s."asOf"
          FROM "HashtagTrendingScoreSnapshot" s
          ORDER BY s."asOf" DESC
          LIMIT 1
        ) as "asOf"
      ),
      hashtag_global AS (
        SELECT
          CAST(MAX(h."score") AS DOUBLE PRECISION) as "maxScore"
        FROM "HashtagTrendingScoreSnapshot" h
        JOIN latest_hashtag_snapshot lhs ON TRUE
        WHERE
          lhs."asOf" IS NOT NULL
          AND h."asOf" = lhs."asOf"
          AND h."visibility" IN (${Prisma.join(visibilitiesForQuerySql)})
      ),
      post_hashtag_scores AS (
        SELECT
          p."id" as "postId",
          CAST(MAX(h."score") AS DOUBLE PRECISION) as "maxTagScore"
        FROM "Post" p
        JOIN candidates c ON c."id" = p."id"
        CROSS JOIN LATERAL UNNEST(p."hashtags") AS t
        JOIN latest_hashtag_snapshot lhs ON TRUE
        LEFT JOIN "HashtagTrendingScoreSnapshot" h ON
          lhs."asOf" IS NOT NULL
          AND h."asOf" = lhs."asOf"
          AND h."visibility" = p."visibility"
          AND h."tag" = LOWER(TRIM(t))
        WHERE LOWER(TRIM(t)) <> ''
        GROUP BY p."id"
      ),
      scored AS (
        SELECT
          p."id" as "id",
          p."createdAt" as "createdAt",
          CAST(
            (
              -- Decay by post age so score reflects "recent engagement on this post," not cache refresh time.
              CASE
              WHEN p."boostScore" IS NULL OR p."boostScoreUpdatedAt" IS NULL THEN 0
              ELSE p."boostScore" * POWER(
                0.5,
                GREATEST(
                  0,
                  EXTRACT(EPOCH FROM (${snapshotAsOf}::timestamptz - p."createdAt"))
                ) / ${PostsService.popularHalfLifeSeconds}
              )
              END
            )
            +
            (
              -- Bookmarks are a quieter signal than boosts: they indicate “save for later,”
              -- so we count them, but decay them by post age so this stays “trending”.
              (p."bookmarkCount"::DOUBLE PRECISION) * 0.5 * POWER(
                0.5,
                GREATEST(
                  0,
                  EXTRACT(EPOCH FROM (${snapshotAsOf}::timestamptz - p."createdAt"))
                ) / ${PostsService.popularHalfLifeSeconds}
              )
            )
            +
            (
              (COALESCE(cs."commentScore", 0)::DOUBLE PRECISION) * ${PostsService.commentScoreWeight}
            )
            +
            (
              CASE
                WHEN hs."maxTagScore" IS NULL OR hs."maxTagScore" <= 0 THEN 0
                ELSE
                  ${PostsService.popularTrendingHashtagBaseBonus}
                  +
                  COALESCE(
                    LEAST(
                      1.0,
                      hs."maxTagScore" / NULLIF(hg."maxScore", 0)
                    ),
                    0
                  ) * ${PostsService.popularTrendingHashtagMaxScaledBonus}
              END
            )
            +
            (
              CASE
                WHEN u."pinnedPostId" = p."id" THEN
                  (CASE WHEN u."premium" THEN ${PostsService.pinScorePremium} WHEN u."verifiedStatus" <> 'none' THEN ${PostsService.pinScoreVerified} ELSE ${PostsService.pinScoreBase} END)
                  * POWER(
                    0.5,
                    GREATEST(0, EXTRACT(EPOCH FROM (${snapshotAsOf}::timestamptz - p."createdAt"))) / ${PostsService.popularHalfLifeSeconds}
                  )
                ELSE 0
              END
            )
            * (CASE WHEN p."parentId" IS NULL THEN ${PostsService.popularTopLevelScoreBoost} ELSE 1.0 END)
            * POWER(
              ${PostsService.deletedAncestorPenalty},
              (
                (CASE WHEN parent."deletedAt" IS NOT NULL THEN 1 ELSE 0 END)
                +
                (CASE
                  WHEN root."deletedAt" IS NOT NULL AND (parent."id" IS NULL OR root."id" <> parent."id") THEN 1
                  ELSE 0
                END)
              )
            )
            AS DOUBLE PRECISION
          ) as "score"
        FROM "Post" p
        JOIN candidates c ON c."id" = p."id"
        LEFT JOIN "User" u ON u."id" = p."userId"
        LEFT JOIN "Post" parent ON parent."id" = p."parentId"
        LEFT JOIN "Post" root ON root."id" = COALESCE(p."rootId", p."id")
        LEFT JOIN comment_scores cs ON cs."postId" = p."id"
        CROSS JOIN hashtag_global hg
        LEFT JOIN post_hashtag_scores hs ON hs."postId" = p."id"
      )
      SELECT "id", "createdAt", "score"
      FROM scored
      WHERE
        ${
          decoded && cursorCreatedAt && cursorScore != null && cursorId
            ? Prisma.sql`
              (
                "score" < ${cursorScore}
                OR (
                  "score" = ${cursorScore}
                  AND (
                    "createdAt" < ${cursorCreatedAt}
                    OR ("createdAt" = ${cursorCreatedAt} AND "id" < ${cursorId})
                  )
                )
              )
            `
            : Prisma.sql`TRUE`
        }
      ORDER BY "score" DESC, "createdAt" DESC, "id" DESC
      LIMIT ${limit + 1}
    `);

    const sliceRows = rows.slice(0, limit);
    const ids = sliceRows.map((r) => r.id);
    const nextRow = rows.length > limit ? sliceRows[sliceRows.length - 1] ?? null : null;

    const posts = ids.length
      ? await this.prisma.post.findMany({
          where: { id: { in: ids }, ...this.notDeletedWhere() },
          include: feedPostInclude,
        })
      : [];
    const byId = new Map(posts.map((p) => [p.id, p] as const));
    const ordered = ids.map((id) => byId.get(id)).filter((p): p is (typeof posts)[number] => Boolean(p));

    const nextCursor =
      rows.length > limit && nextRow
        ? this.encodePopularCursor({
            asOf: snapshotAsOf.toISOString(),
            score: nextRow.score,
            createdAt: nextRow.createdAt.toISOString(),
            id: nextRow.id,
          })
        : null;

    const scoreByPostId = new Map<string, number>(sliceRows.map((r) => [r.id, r.score]));
    return { posts: ordered, nextCursor, scoreByPostId };
  }

  /**
   * Featured feed: automated subset of trending (popular), tuned for Explore.
   * Uses snapshot table when available; falls back to the trending feed otherwise.
   */
  async listFeaturedFeed(params: {
    viewerUserId: string | null;
    limit: number;
    cursor: string | null;
    visibility: 'all' | PostVisibility;
    followingOnly?: boolean;
    authorUserIds?: string[] | null;
  }): Promise<PopularFeedResult> {
    const { viewerUserId, limit, cursor, visibility, followingOnly = false } = params;
    const requestedAuthorUserIds =
      (params.authorUserIds ?? null)?.map((s) => (s ?? '').trim()).filter(Boolean).slice(0, 50) ?? null;

    const viewer = await this.viewerContextService.getViewer(viewerUserId);
    const allowed = this.allowedVisibilitiesForViewer(viewer);

    if (visibility === 'verifiedOnly') {
      if (!viewer || viewer.verifiedStatus === 'none') throw new ForbiddenException('Verify to view verified-only posts.');
    }
    if (visibility === 'premiumOnly') {
      if (!viewer || !viewer.premium) throw new ForbiddenException('Upgrade to premium to view premium-only posts.');
    }

    if (followingOnly && !viewerUserId) {
      return { posts: [], nextCursor: null, scoreByPostId: new Map() };
    }

    const followingAuthorIds: string[] | null =
      followingOnly && viewerUserId ? await this.getAuthorIdsForFollowingFilter(viewerUserId) : null;

    const authorUserIds: string[] | null = requestedAuthorUserIds?.length
      ? followingAuthorIds?.length
        ? followingAuthorIds.filter((id) => requestedAuthorUserIds.includes(id))
        : requestedAuthorUserIds
      : followingAuthorIds;

    if (requestedAuthorUserIds && requestedAuthorUserIds.length === 0) {
      return { posts: [], nextCursor: null, scoreByPostId: new Map() };
    }
    if (authorUserIds && authorUserIds.length === 0) {
      // Intersection produced empty set.
      return { posts: [], nextCursor: null, scoreByPostId: new Map() };
    }

    const decoded = this.decodePopularCursor(cursor);

    const snapshotResult = await this.listFeaturedFeedFromSnapshot({
      viewerUserId,
      limit,
      decodedCursor: decoded,
      visibility,
      allowed,
      authorUserIds,
    });
    if (snapshotResult) return snapshotResult;

    // Fallback: if snapshots aren't available, return the trending feed.
    // (Avoid custom cursor semantics when the snapshot table isn't present yet.)
    const base = await this.listPopularFeed({
      viewerUserId,
      // Fetch extras so we can enforce featured rules (self-filter + top-level + light diversity).
      // Keep bounded: controller caps to 50 anyway; this is mainly for fresh/dev envs without snapshots.
      limit: Math.min(50, Math.max(limit * 12, limit)),
      cursor,
      visibility,
      followingOnly,
      authorUserIds,
    });

    const picked: FeedPost[] = [];
    const perAuthor = new Map<string, number>();

    for (const p of base.posts) {
      if (picked.length >= limit) break;
      if (p.parentId) continue; // featured: top-level only
      if (viewerUserId && p.userId === viewerUserId) continue; // never show viewer their own posts
      const n = perAuthor.get(p.userId) ?? 0;
      if (n >= PostsService.featuredMaxPerAuthor) continue;
      perAuthor.set(p.userId, n + 1);
      picked.push(p);
    }

    const pickedIds = new Set(picked.map((p) => p.id));
    const scoreByPostId = new Map<string, number>();
    for (const [id, score] of base.scoreByPostId.entries()) {
      if (pickedIds.has(id)) scoreByPostId.set(id, score);
    }

    return { posts: picked, nextCursor: base.nextCursor, scoreByPostId };
  }

  async listForUsername(params: {
    viewerUserId: string | null;
    username: string;
    limit: number;
    cursor: string | null;
    visibility: 'all' | PostVisibility;
    includeCounts: boolean;
    sort: 'new' | 'popular';
  }) {
    const { viewerUserId, username, limit, cursor, visibility, includeCounts, sort } = params;
    const normalized = (username ?? '').trim();
    if (!normalized) throw new NotFoundException('User not found.');

    const user = await this.prisma.user.findFirst({
      where: { username: { equals: normalized, mode: 'insensitive' } },
      select: { id: true },
    });
    if (!user) throw new NotFoundException('User not found.');

    const viewer = await this.viewerContextService.getViewer(viewerUserId);

    const isSelf = Boolean(viewer && viewer.id === user.id);

    const counts: PostCounts | null = includeCounts
      ? await (async () => {
          const grouped = await this.prisma.post.groupBy({
            by: ['visibility'],
            where: { userId: user.id, visibility: { not: 'onlyMe' }, ...this.notDeletedWhere() },
            _count: { _all: true },
          });

          const out: PostCounts = {
            all: 0,
            public: 0,
            verifiedOnly: 0,
            premiumOnly: 0,
          };
          for (const g of grouped) {
            const n = g._count._all;
            out.all += n;
            if (g.visibility === 'public') out.public = n;
            if (g.visibility === 'verifiedOnly') out.verifiedOnly = n;
            if (g.visibility === 'premiumOnly') out.premiumOnly = n;
          }
          return out;
        })()
      : null;

    const allowed =
      isSelf ? (['public', 'verifiedOnly', 'premiumOnly'] as PostVisibility[]) : this.allowedVisibilitiesForViewer(viewer);

    if (visibility === 'verifiedOnly' && !isSelf) {
      if (!viewer || viewer.verifiedStatus === 'none') throw new ForbiddenException('Verify to view verified-only posts.');
    }
    if (visibility === 'premiumOnly' && !isSelf) {
      if (!viewer || !viewer.premium) throw new ForbiddenException('Upgrade to premium to view premium-only posts.');
    }

    const baseWhere =
      visibility === 'all'
        ? ({
            userId: user.id,
            visibility: { in: allowed },
            ...this.notDeletedWhere(),
          } as Prisma.PostWhereInput)
        : ({ userId: user.id, visibility, ...this.notDeletedWhere() } as Prisma.PostWhereInput);

    if (sort === 'popular') {
      // Trending for profile: same half-life boost + bookmark scoring as home feed, scoped to this user.
      const visibilitiesForQuery: PostVisibility[] =
        visibility === 'all' ? allowed : visibility === 'public' ? (['public'] as PostVisibility[]) : ([visibility] as PostVisibility[]);
      const visibilitiesForQuerySql = visibilitiesForQuery.map((v) => Prisma.sql`${v}::"PostVisibility"`);

      const decoded = this.decodePopularCursor(cursor);
      const asOf = decoded ? new Date(decoded.asOf) : new Date();
      const asOfMs = asOf.getTime();
      const lookbackMs = PostsService.popularLookbackDays * 24 * 60 * 60 * 1000;
      const minCreatedAt = new Date(asOfMs - lookbackMs);

      if (!decoded) {
        const staleBefore = new Date(asOfMs - PostsService.boostScoreTtlMs);
        const warmup = await this.prisma.post.findMany({
          where: {
            AND: [
              { userId: user.id },
              { parentId: null },
              { visibility: { in: visibilitiesForQuery } },
              this.notDeletedWhere(),
              { createdAt: { gte: minCreatedAt } },
              { boostCount: { gt: 0 } },
              { OR: [{ boostScoreUpdatedAt: null }, { boostScoreUpdatedAt: { lt: staleBefore } }] },
            ],
          },
          orderBy: [{ boostCount: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
          take: PostsService.popularWarmupTake,
          select: { id: true },
        });
        await this.ensureBoostScoresFresh(warmup.map((p) => p.id));
      }

      const snapshotAsOf = decoded ? asOf : new Date();
      const snapshotMinCreatedAt = new Date(snapshotAsOf.getTime() - lookbackMs);

      const cursorCreatedAt = decoded ? new Date(decoded.createdAt) : null;
      const cursorScore = decoded?.score ?? null;
      const cursorId = decoded?.id ?? null;

      const rows = await this.prisma.$queryRaw<Array<{ id: string; createdAt: Date; score: number }>>(Prisma.sql`
        WITH
        comment_scores AS (
          SELECT
            p."parentId" as "postId",
            CAST(
              SUM(
                POWER(
                  0.5,
                  GREATEST(
                    0,
                    EXTRACT(EPOCH FROM (${snapshotAsOf}::timestamptz - p."createdAt"))
                  ) / ${PostsService.popularHalfLifeSeconds}
                )
              ) AS DOUBLE PRECISION
            ) as "commentScore"
          FROM "Post" p
          WHERE
            p."parentId" IS NOT NULL
            AND p."deletedAt" IS NULL
            AND p."createdAt" >= ${snapshotMinCreatedAt}
          GROUP BY p."parentId"
        ),
        scored AS (
          SELECT
            p."id" as "id",
            p."createdAt" as "createdAt",
            CAST(
              (
                CASE
                WHEN p."boostScore" IS NULL OR p."boostScoreUpdatedAt" IS NULL THEN 0
                ELSE p."boostScore" * POWER(
                  0.5,
                  GREATEST(
                    0,
                    EXTRACT(EPOCH FROM (${snapshotAsOf}::timestamptz - p."createdAt"))
                  ) / ${PostsService.popularHalfLifeSeconds}
                )
                END
              )
              +
              (
                (p."bookmarkCount"::DOUBLE PRECISION) * 0.5 * POWER(
                  0.5,
                  GREATEST(
                    0,
                    EXTRACT(EPOCH FROM (${snapshotAsOf}::timestamptz - p."createdAt"))
                  ) / ${PostsService.popularHalfLifeSeconds}
                )
              )
              +
              (
                (COALESCE(cs."commentScore", 0)::DOUBLE PRECISION) * ${PostsService.commentScoreWeight}
              )
              +
              (
                CASE
                  WHEN u."pinnedPostId" = p."id" THEN
                    (CASE WHEN u."premium" THEN ${PostsService.pinScorePremium} WHEN u."verifiedStatus" <> 'none' THEN ${PostsService.pinScoreVerified} ELSE ${PostsService.pinScoreBase} END)
                    * POWER(
                      0.5,
                      GREATEST(0, EXTRACT(EPOCH FROM (${snapshotAsOf}::timestamptz - p."createdAt"))) / ${PostsService.popularHalfLifeSeconds}
                    )
                  ELSE 0
                END
              )
              AS DOUBLE PRECISION
            ) as "score"
          FROM "Post" p
          LEFT JOIN "User" u ON u."id" = p."userId"
          LEFT JOIN comment_scores cs ON cs."postId" = p."id"
          WHERE
            p."deletedAt" IS NULL
            AND p."parentId" IS NULL
            AND p."createdAt" >= ${snapshotMinCreatedAt}
            AND p."userId" = ${user.id}
            AND p."visibility" IN (${Prisma.join(visibilitiesForQuerySql)})
        )
        SELECT "id", "createdAt", "score"
        FROM scored
        WHERE
          ${
            decoded && cursorCreatedAt && cursorScore != null && cursorId
              ? Prisma.sql`
                (
                  "score" < ${cursorScore}
                  OR (
                    "score" = ${cursorScore}
                    AND (
                      "createdAt" < ${cursorCreatedAt}
                      OR ("createdAt" = ${cursorCreatedAt} AND "id" < ${cursorId})
                    )
                  )
                )
              `
              : Prisma.sql`TRUE`
          }
        ORDER BY "score" DESC, "createdAt" DESC, "id" DESC
        LIMIT ${limit + 1}
      `);

      const sliceRows = rows.slice(0, limit);
      const ids = sliceRows.map((r) => r.id);
      const nextRow = rows.length > limit ? sliceRows[sliceRows.length - 1] ?? null : null;

      const posts = ids.length
        ? await this.prisma.post.findMany({
            where: { id: { in: ids } },
            include: feedPostInclude,
          })
        : [];
      const byId = new Map(posts.map((p) => [p.id, p] as const));
      const ordered = ids.map((id) => byId.get(id)).filter((p): p is (typeof posts)[number] => Boolean(p));

      const nextCursor =
        rows.length > limit && nextRow
          ? this.encodePopularCursor({
              asOf: snapshotAsOf.toISOString(),
              score: nextRow.score,
              createdAt: nextRow.createdAt.toISOString(),
              id: nextRow.id,
            })
          : null;

      const scoreByPostId = new Map<string, number>(sliceRows.map((r) => [r.id, r.score]));
      return { posts: ordered, nextCursor, counts, scoreByPostId };
    }

    const cursorWhere = await createdAtIdCursorWhere({
      cursor,
      lookup: async (id) => await this.prisma.post.findUnique({ where: { id }, select: { id: true, createdAt: true } }),
    });

    const posts = await this.prisma.post.findMany({
      where: { AND: [baseWhere, ...(cursorWhere ? [cursorWhere] : [])] },
      include: feedPostInclude,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });

    const slice = posts.slice(0, limit);
    const nextCursor = posts.length > limit ? slice[slice.length - 1]?.id ?? null : null;

    return { posts: slice, nextCursor, counts };
  }

  private encodeCommentCursor(cursor: { createdAt: string; id: string }) {
    return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
  }

  private decodeCommentCursor(
    token: string | null,
  ): { createdAt: string; id: string } | null {
    const t = (token ?? '').trim();
    if (!t) return null;
    try {
      const raw = Buffer.from(t, 'base64url').toString('utf8');
      const parsed = JSON.parse(raw) as Partial<{ createdAt: string; id: string }>;
      const createdAt = typeof parsed.createdAt === 'string' ? parsed.createdAt : '';
      const id = typeof parsed.id === 'string' ? parsed.id : '';
      if (!createdAt || !id) return null;
      return { createdAt, id };
    } catch {
      return null;
    }
  }

  /**
   * List comments for a post. Viewer must be able to see the parent (same rule as getById).
   * Only top-level posts can have comments; only-me parents are unreachable.
   */
  async listComments(params: {
    viewerUserId: string | null;
    postId: string;
    limit: number;
    cursor: string | null;
    visibility?: 'all' | PostVisibility;
    sort?: 'new' | 'popular';
  }) {
    const { viewerUserId, postId, limit, cursor, visibility = 'all', sort = 'new' } = params;
    const parent = await this.getById({ viewerUserId, id: postId });
    if (parent.visibility === 'onlyMe') {
      throw new ForbiddenException('This post is private.');
    }

    const viewer = await this.viewerContextService.getViewer(viewerUserId);
    const allowed = this.allowedVisibilitiesForViewer(viewer);
    const baseVisibilityWhere: Prisma.PostWhereInput =
      visibility === 'all'
        ? { visibility: { in: allowed } }
        : visibility === 'public'
          ? { visibility: 'public' }
          : { visibility };
    // Author always sees own replies (e.g. after tier downgrade).
    const visibilityWhere: Prisma.PostWhereInput =
      viewerUserId
        ? { OR: [baseVisibilityWhere, { userId: viewerUserId }] }
        : baseVisibilityWhere;

    const decoded = this.decodeCommentCursor(cursor);
    const isDesc = sort === 'new';
    const cursorWhere =
      decoded != null
        ? isDesc
          ? ({
              OR: [
                { createdAt: { lt: new Date(decoded.createdAt) } },
                { AND: [{ createdAt: new Date(decoded.createdAt) }, { id: { lt: decoded.id } }] },
              ],
            } as Prisma.PostWhereInput)
          : ({
              OR: [
                { createdAt: { gt: new Date(decoded.createdAt) } },
                { AND: [{ createdAt: new Date(decoded.createdAt) }, { id: { gt: decoded.id } }] },
              ],
            } as Prisma.PostWhereInput)
        : undefined;

    const baseWhere = {
      parentId: postId,
      ...visibilityWhere,
      ...this.notDeletedWhere(),
    };

    if (sort === 'popular') {
      const candidateIds = (
        await this.prisma.post.findMany({
          where: { ...baseWhere, OR: [{ boostCount: { gt: 0 } }, { bookmarkCount: { gt: 0 } }] },
          select: { id: true },
          take: 500,
        })
      ).map((p) => p.id);
      if (candidateIds.length > 0) await this.ensureBoostScoresFresh(candidateIds);
      const comments = await this.prisma.post.findMany({
        where: cursorWhere ? { AND: [baseWhere, cursorWhere] } : baseWhere,
        include: {
          user: { select: USER_LIST_SELECT },
          media: { orderBy: { position: 'asc' } },
          mentions: { include: { user: { select: MENTION_USER_SELECT } } },
        },
        orderBy: [
          { boostScore: 'desc' },
          { boostCount: 'desc' },
          { createdAt: 'desc' },
          { id: 'desc' },
        ],
        take: limit + 1,
      });
      const slice = comments.slice(0, limit);
      const nextCursor =
        comments.length > limit && slice[slice.length - 1]
          ? this.encodeCommentCursor({
              createdAt: slice[slice.length - 1].createdAt.toISOString(),
              id: slice[slice.length - 1].id,
            })
          : null;
      const countsWhere =
        viewerUserId
          ? { parentId: postId, ...this.notDeletedWhere(), OR: [{ visibility: { in: allowed } }, { userId: viewerUserId }] }
          : { parentId: postId, ...this.notDeletedWhere(), visibility: { in: allowed } };
      const counts = await this.prisma.post.groupBy({
        by: ['visibility'],
        where: countsWhere,
        _count: { _all: true },
      });
      const countMap = { all: 0, public: 0, verifiedOnly: 0, premiumOnly: 0 };
      for (const g of counts) {
        countMap.all += g._count._all;
        if (g.visibility === 'public') countMap.public = g._count._all;
        if (g.visibility === 'verifiedOnly') countMap.verifiedOnly = g._count._all;
        if (g.visibility === 'premiumOnly') countMap.premiumOnly = g._count._all;
      }
      return { comments: slice, nextCursor, counts: countMap };
    }

    const comments = await this.prisma.post.findMany({
      where: cursorWhere ? { AND: [baseWhere, cursorWhere] } : baseWhere,
      include: {
        user: { select: USER_LIST_SELECT },
        media: { orderBy: { position: 'asc' } },
        mentions: { include: { user: { select: MENTION_USER_SELECT } } },
      },
      orderBy: isDesc ? [{ createdAt: 'desc' }, { id: 'desc' }] : [{ createdAt: 'asc' }, { id: 'asc' }],
      take: limit + 1,
    });

    const slice = comments.slice(0, limit);
    const nextCursor =
      comments.length > limit && slice[slice.length - 1]
        ? this.encodeCommentCursor({
            createdAt: slice[slice.length - 1].createdAt.toISOString(),
            id: slice[slice.length - 1].id,
          })
        : null;

    const countsWhereNonPopular =
      viewerUserId
        ? { parentId: postId, ...this.notDeletedWhere(), OR: [{ visibility: { in: allowed } }, { userId: viewerUserId }] }
        : { parentId: postId, ...this.notDeletedWhere(), visibility: { in: allowed } };
    const counts = await this.prisma.post.groupBy({
      by: ['visibility'],
      where: countsWhereNonPopular,
      _count: { _all: true },
    });
    const countMap = { all: 0, public: 0, verifiedOnly: 0, premiumOnly: 0 };
    for (const g of counts) {
      countMap.all += g._count._all;
      if (g.visibility === 'public') countMap.public = g._count._all;
      if (g.visibility === 'verifiedOnly') countMap.verifiedOnly = g._count._all;
      if (g.visibility === 'premiumOnly') countMap.premiumOnly = g._count._all;
    }

    return { comments: slice, nextCursor, counts: countMap };
  }

  /**
   * Thread participants = root post author + all comment authors + everyone mentioned in the thread.
   * Used to pre-fill mentions and show "Replying to @userA, @userB" when composing a reply.
   */
  async getThreadParticipants(params: { viewerUserId: string | null; postId: string }) {
    const { viewerUserId, postId } = params;
    const post = await this.getById({ viewerUserId, id: postId });
    if (post.visibility === 'onlyMe') {
      throw new ForbiddenException('This post is private.');
    }

    // Use rootId if set (post is a reply), otherwise post.id is the root
    const rootId = (post as { rootId?: string | null }).rootId ?? post.id;

    // Collect all posts in the thread: root post + all replies (using rootId index)
    const threadPosts = await this.prisma.post.findMany({
      where: { OR: [{ id: rootId }, { rootId }], ...this.notDeletedWhere() },
      select: { userId: true, mentions: { select: { userId: true } } },
    });
    const participantIds = new Set<string>();
    for (const p of threadPosts) {
      participantIds.add(p.userId);
      for (const m of p.mentions) participantIds.add(m.userId);
    }

    const users = await this.prisma.user.findMany({
      where: { id: { in: Array.from(participantIds) }, usernameIsSet: true },
      select: { id: true, username: true },
    });
    return {
      participants: users
        .filter((u) => u.username != null)
        .map((u) => ({ id: u.id, username: u.username as string })),
    };
  }

  async getById(params: { viewerUserId: string | null; id: string }) {
    const { viewerUserId, id } = params;
    const postId = (id ?? '').trim();
    if (!postId) throw new NotFoundException('Post not found.');

    const cacheKey = `posts.getById:${viewerUserId ?? 'anon'}:${postId}`;
    const cached = this.requestCache.get<FeedPost>(cacheKey);
    if (cached) return cached;

    const viewer = await this.viewerContextService.getViewer(viewerUserId);
    const allowed = this.allowedVisibilitiesForViewer(viewer);

    const post = await this.prisma.post.findFirst({
      where: { id: postId },
      include: {
        user: { select: USER_LIST_SELECT },
        media: { orderBy: { position: 'asc' } },
        poll: { include: { options: { orderBy: { position: 'asc' } } } },
        mentions: { include: { user: { select: MENTION_USER_SELECT } } },
      },
    });
    if (!post) throw new NotFoundException('Post not found.');

    // Author can always view their own posts.
    const isSelf = Boolean(viewer && viewer.id === post.userId);
    if (!isSelf) {
      // Only-me posts are private. Allow site admins to view for support/moderation.
      if (post.visibility === 'onlyMe' && !viewer?.siteAdmin) throw new ForbiddenException('This post is private.');
      if (!allowed.includes(post.visibility)) {
        if (post.visibility === 'verifiedOnly') throw new ForbiddenException('Verify to view verified-only posts.');
        if (post.visibility === 'premiumOnly') throw new ForbiddenException('Upgrade to premium to view premium-only posts.');
        throw new ForbiddenException('Not allowed to view this post.');
      }
    }

    this.requestCache.set(cacheKey, post as FeedPost);
    return post;
  }

  async deletePost(params: { userId: string; postId: string }) {
    const { userId, postId } = params;
    const id = (postId ?? '').trim();
    if (!id) throw new NotFoundException('Post not found.');

    const post = await this.prisma.post.findUnique({
      where: { id },
      select: { id: true, userId: true, deletedAt: true, hashtags: true, hashtagCasings: true, topics: true },
    });
    if (!post) throw new NotFoundException('Post not found.');
    if (post.userId !== userId) throw new ForbiddenException('Not allowed to delete this post.');
    if (post.deletedAt) return { success: true };

    const postTopics = Array.isArray((post as any).topics) ? ((post as any).topics as string[]) : [];
    const tags = Array.isArray((post as any).hashtags) ? ((post as any).hashtags as string[]) : [];
    const variants = Array.isArray((post as any).hashtagCasings) ? ((post as any).hashtagCasings as string[]) : [];
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      await tx.post.update({
        where: { id },
        data: { deletedAt: now },
      });

      // Poll cleanup: once a post is deleted, we should never send "poll results ready" notifications.
      // This also prevents notifications if the post is later restored by an admin.
      await tx.postPoll.updateMany({
        where: { postId: id, resultsNotifiedAt: null },
        data: { resultsNotifiedAt: now },
      });

      // Posts are soft-deleted, so FK cascades won't run. Ensure bookmarks don't retain deleted posts.
      // (BookmarkCollectionItem cascades off Bookmark, so folder links are cleaned up too.)
      await tx.bookmark.deleteMany({ where: { postId: id } });

      if (tags.length > 0) {
        for (let i = 0; i < tags.length; i++) {
          const t = (tags[i] ?? '').trim().toLowerCase();
          const variant = (variants[i] ?? '').trim();
          if (!t) continue;
          try {
            await tx.hashtag.update({
              where: { tag: t },
              data: { usageCount: { decrement: 1 } },
            });
          } catch {
            // ignore: missing hashtag row (best-effort counters)
          }
          if (variant) {
            try {
              await tx.hashtagVariant.update({
                where: { tag_variant: { tag: t, variant } },
                data: { count: { decrement: 1 } },
              });
            } catch {
              // ignore
            }
          }
        }
        await tx.hashtagVariant.deleteMany({ where: { tag: { in: tags }, count: { lte: 0 } } });
        await tx.hashtag.deleteMany({ where: { tag: { in: tags }, usageCount: { lte: 0 } } });
      }
    });

    // Delete all notifications that reference this post (as subject) or were caused by this post (as actorPost).
    // Best-effort: deleting a post should not fail due to notification cleanup.
    await Promise.allSettled([
      this.notifications.deleteBySubjectPostId(id),
      this.notifications.deleteByActorPostId(id),
    ]).catch(() => {});
    await this.cacheInvalidation.bumpForPostWrite({ topics: postTopics });
    // Realtime: mark post deleted for live subscribers (best-effort).
    try {
      this.presenceRealtime.emitPostsLiveUpdated(id, {
        postId: id,
        version: now.toISOString(),
        reason: 'post_deleted',
        patch: { deletedAt: now.toISOString() },
      });
    } catch {
      // Best-effort
    }
    return { success: true };
  }

  async updatePost(params: { userId: string; postId: string; body: string }) {
    const { userId, postId } = params;
    const id = (postId ?? '').trim();
    if (!id) throw new NotFoundException('Post not found.');

    const nextBody = (params.body ?? '').trim();
    if (!nextBody) throw new BadRequestException('Post must include text.');

    const post = await this.prisma.post.findUnique({
      where: { id },
      include: {
        user: { select: USER_LIST_SELECT },
        media: { orderBy: { position: 'asc' } },
        mentions: { select: { userId: true } },
        poll: { select: { id: true, totalVoteCount: true } },
      },
    });
    if (!post) throw new NotFoundException('Post not found.');
    if (post.userId !== userId) throw new ForbiddenException('Not allowed to edit this post.');
    if (post.deletedAt) throw new ForbiddenException('Cannot edit a deleted post.');
    if (post.parentId) throw new ForbiddenException('Replies cannot be edited.');

    // Product rule: posts with polls cannot be edited once voting begins.
    if ((post as any).poll && ((post as any).poll.totalVoteCount ?? 0) > 0) {
      throw new ForbiddenException('This post can no longer be edited.');
    }

    // Only-me posts behave like notes/drafts: allow edits without age/count limits.
    if (post.visibility !== 'onlyMe') {
      // Enforce edit window + count: 3 edits in first 30 minutes after creation.
      const now = Date.now();
      const createdAtMs = post.createdAt instanceof Date ? post.createdAt.getTime() : new Date(post.createdAt as any).getTime();
      const windowMs = 30 * 60 * 1000;
      if (Number.isFinite(createdAtMs) && now > createdAtMs + windowMs) {
        throw new ForbiddenException('This post can no longer be edited.');
      }
      const editCount = typeof (post as any).editCount === 'number' ? ((post as any).editCount as number) : 0;
      if (editCount >= 3) throw new ForbiddenException('This post has reached the edit limit.');
    }

    // Length rules align with createPost.
    const maxLen = post.user?.premium ? 1000 : 200;
    if (nextBody.length > maxLen) {
      throw new BadRequestException(
        post.user?.premium
          ? 'Posts are limited to 1000 characters.'
          : 'Posts are limited to 200 characters for non-premium members.',
      );
    }

    const hashtagTokensRaw = this.parseHashtagsFromBody(nextBody);
    const hashtagTokens = hashtagTokensRaw
      .map((t) => ({ tag: (t.tag ?? '').trim().toLowerCase(), variant: (t.variant ?? '').trim() }))
      .filter((t) => Boolean(t.tag && t.variant));
    hashtagTokens.sort((a, b) => a.tag.localeCompare(b.tag) || a.variant.localeCompare(b.variant));
    const hashtags = hashtagTokens.map((t) => t.tag);
    const hashtagCasings = hashtagTokens.map((t) => t.variant);

    const fromBodyMentions = this.parseMentionsFromBody(nextBody);
    const bodyMentionIds = await this.resolveMentionUsernames(fromBodyMentions);
    const existingMentionIds = Array.isArray((post as any).mentions) ? ((post as any).mentions as Array<{ userId: string }>).map((m) => m.userId) : [];
    const mentionUserIds = Array.from(new Set([...existingMentionIds, ...bodyMentionIds])).filter(Boolean);

    const prevTopics = Array.isArray((post as any).topics) ? ((post as any).topics as string[]) : [];
    const updated = await this.prisma.$transaction(async (tx) => {
      // Snapshot previous state (pre-edit).
      await tx.postVersion.create({
        data: {
          postId: post.id,
          body: post.body,
          topics: Array.isArray((post as any).topics) ? ((post as any).topics as string[]) : [],
          hashtags: Array.isArray((post as any).hashtags) ? ((post as any).hashtags as string[]) : [],
          hashtagCasings: Array.isArray((post as any).hashtagCasings) ? ((post as any).hashtagCasings as string[]) : [],
          visibility: post.visibility,
        },
      });

      // Recompute topics from text and hashtags (no related topics for root post edits).
      const topics = inferTopicsFromText(nextBody, { hashtags, relatedTopics: [] });

      const next = await tx.post.update({
        where: { id: post.id },
        data: {
          body: nextBody,
          topics,
          hashtags,
          hashtagCasings,
          editedAt: new Date(),
          editCount: { increment: 1 },
        },
        include: {
          user: { select: USER_LIST_SELECT },
          media: { orderBy: { position: 'asc' } },
          mentions: {
            include: {
              user: {
                select: MENTION_USER_SELECT,
              },
            },
          },
        },
      });

      await tx.postMention.deleteMany({ where: { postId: post.id } });
      if (mentionUserIds.length > 0) {
        await tx.postMention.createMany({
          data: mentionUserIds.map((uid) => ({ postId: post.id, userId: uid })),
          skipDuplicates: true,
        });
      }

      // If hashtags changed, best-effort adjust counters by recomputing counts deltas.
      // We keep it simple for v1: decrement old and increment new based on tokens.
      const prevTags = Array.isArray((post as any).hashtags) ? ((post as any).hashtags as string[]) : [];
      const prevVariants = Array.isArray((post as any).hashtagCasings) ? ((post as any).hashtagCasings as string[]) : [];
      const prevPairs = prevTags.map((t, i) => ({ tag: (t ?? '').trim().toLowerCase(), variant: (prevVariants[i] ?? '').trim() })).filter((x) => x.tag);
      const nextPairs = hashtagTokens;

      const prevKeyCount = new Map<string, number>();
      for (const p of prevPairs) prevKeyCount.set(`${p.tag}\n${p.variant}`, (prevKeyCount.get(`${p.tag}\n${p.variant}`) ?? 0) + 1);
      const nextKeyCount = new Map<string, number>();
      for (const p of nextPairs) nextKeyCount.set(`${p.tag}\n${p.variant}`, (nextKeyCount.get(`${p.tag}\n${p.variant}`) ?? 0) + 1);

      const allKeys = new Set<string>([...prevKeyCount.keys(), ...nextKeyCount.keys()]);
      for (const key of allKeys) {
        const [tag, variant] = key.split('\n');
        const prevN = prevKeyCount.get(key) ?? 0;
        const nextN = nextKeyCount.get(key) ?? 0;
        const delta = nextN - prevN;
        if (!tag || delta === 0) continue;
        if (delta > 0) {
          await tx.hashtag.upsert({
            where: { tag },
            create: { tag, usageCount: delta },
            update: { usageCount: { increment: delta } },
          });
          if (variant) {
            await tx.hashtagVariant.upsert({
              where: { tag_variant: { tag, variant } },
              create: { tag, variant, count: delta },
              update: { count: { increment: delta } },
            });
          }
        } else if (delta < 0) {
          try {
            await tx.hashtag.update({ where: { tag }, data: { usageCount: { decrement: Math.abs(delta) } } });
          } catch {
            // ignore
          }
          if (variant) {
            try {
              await tx.hashtagVariant.update({ where: { tag_variant: { tag, variant } }, data: { count: { decrement: Math.abs(delta) } } });
            } catch {
              // ignore
            }
          }
        }
      }
      const allTagsTouched = Array.from(new Set([...prevTags, ...hashtags].map((t) => String(t ?? '').trim().toLowerCase()).filter(Boolean)));
      await tx.hashtagVariant.deleteMany({ where: { tag: { in: allTagsTouched }, count: { lte: 0 } } });
      await tx.hashtag.deleteMany({ where: { tag: { in: allTagsTouched }, usageCount: { lte: 0 } } });

      return next;
    });
    const nextTopics = Array.isArray((updated as any).topics) ? ((updated as any).topics as string[]) : [];
    await this.cacheInvalidation.bumpForPostWrite({ topics: [...prevTopics, ...nextTopics] });

    // Realtime: update body/edited markers for live subscribers (best-effort).
    try {
      const editedAtIso = (updated as any)?.editedAt instanceof Date ? (updated as any).editedAt.toISOString() : new Date().toISOString();
      const editCount = typeof (updated as any)?.editCount === 'number' ? (updated as any).editCount : undefined;
      this.presenceRealtime.emitPostsLiveUpdated(id, {
        postId: id,
        version: editedAtIso,
        reason: 'post_edited',
        patch: {
          body: String((updated as any)?.body ?? ''),
          editedAt: editedAtIso,
          ...(typeof editCount === 'number' ? { editCount } : {}),
        },
      });
    } catch {
      // Best-effort
    }
    return updated;
  }

  async listDrafts(params: { userId: string; limit: number; cursor: string | null }) {
    const limit = Math.max(1, Math.min(50, params.limit || 30));
    const cursor = (params.cursor ?? '').trim() || null;

    const cursorWhere = await createdAtIdCursorWhere({
      cursor,
      lookup: async (id) => await this.prisma.post.findUnique({ where: { id }, select: { id: true, createdAt: true } }),
    });

    const rows = await this.prisma.post.findMany({
      where: {
        AND: [
          this.notDeletedWhere(),
          { userId: params.userId },
          { visibility: 'onlyMe' },
          { isDraft: true },
          { parentId: null },
          ...(cursorWhere ? [cursorWhere as Prisma.PostWhereInput] : []),
        ],
      },
      include: {
        user: { select: USER_LIST_SELECT },
        media: { orderBy: { position: 'asc' } },
        mentions: {
          include: {
            user: {
              select: MENTION_USER_SELECT,
            },
          },
        },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });

    const slice = rows.slice(0, limit);
    const nextCursor = rows.length > limit ? (slice[slice.length - 1]?.id ?? null) : null;
    return { posts: slice, nextCursor };
  }

  async createDraft(params: {
    userId: string;
    body: string;
    media: Array<{
      source: 'upload' | 'giphy';
      kind: 'image' | 'gif' | 'video';
      r2Key?: string;
      thumbnailR2Key?: string;
      url?: string;
      mp4Url?: string;
      width?: number;
      height?: number;
      durationSeconds?: number;
      alt?: string | null;
    }> | null;
  }) {
    const { userId } = params;
    const body = (params.body ?? '').trim();

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { verifiedStatus: true, premium: true, premiumPlus: true },
    });
    if (!user) throw new NotFoundException('User not found.');

    const media = (params.media ?? []).filter(Boolean);
    if (media.length > 4) throw new BadRequestException('You can attach up to 4 images, GIFs, or videos.');

    // Media drafts are Premium/Premium+ only (align with post media rule).
    if (media.length > 0 && !user.premium) {
      throw new ForbiddenException('Upgrade to premium to post media.');
    }

    const maxLen = user.premium ? 1000 : 200;
    if (body.length > maxLen) {
      throw new BadRequestException(
        user.premium
          ? 'Posts are limited to 1000 characters.'
          : 'Posts are limited to 200 characters for non-premium members.',
      );
    }

    // Clean + validate media (same rules as createPost, but without notifications/mentions side-effects).
    const allowedImagePrefixes = [`uploads/${userId}/images/`, `dev/uploads/${userId}/images/`];
    const allowedVideoPrefixes = [`uploads/${userId}/videos/`, `dev/uploads/${userId}/videos/`];
    const allowedThumbnailPrefixes = [`uploads/${userId}/thumbnails/`, `dev/uploads/${userId}/thumbnails/`];
    const uploadKeys = media
      .filter((m) => m.source === 'upload' && (m.r2Key ?? '').trim())
      .map((m) => (m.r2Key ?? '').trim());
    const reusedKeySet = new Set(
      uploadKeys.length
        ? (await this.prisma.mediaContentHash.findMany({ where: { r2Key: { in: uploadKeys } }, select: { r2Key: true } })).map((r) => r.r2Key)
        : [],
    );
    const cleanedMedia = media
      .map((m, idx) => {
        const source = m.source;
        const kind = m.kind;
        const r2Key = (m.r2Key ?? '').trim();
        const thumbnailR2Key = (m.thumbnailR2Key ?? '').trim() || null;
        const url = (m.url ?? '').trim();
        const mp4Url = (m.mp4Url ?? '').trim();
        const width = typeof m.width === 'number' && Number.isFinite(m.width) ? Math.max(1, Math.floor(m.width)) : null;
        const height = typeof m.height === 'number' && Number.isFinite(m.height) ? Math.max(1, Math.floor(m.height)) : null;
        const durationSeconds =
          typeof m.durationSeconds === 'number' && Number.isFinite(m.durationSeconds) && m.durationSeconds >= 0
            ? Math.floor(m.durationSeconds)
            : null;
        const alt = (m.alt ?? '').trim().slice(0, 500) || null;

        if (source === 'upload') {
          if (!r2Key) throw new BadRequestException('Invalid uploaded media key.');
          const isReusedKey = reusedKeySet.has(r2Key);
          if (kind === 'video') {
            if (!isReusedKey && !allowedVideoPrefixes.some((p) => r2Key.startsWith(p))) {
              throw new BadRequestException('Invalid uploaded video key.');
            }
            if (thumbnailR2Key && !allowedThumbnailPrefixes.some((p) => thumbnailR2Key.startsWith(p))) {
              throw new BadRequestException('Invalid thumbnail key.');
            }
            return {
              source,
              kind,
              r2Key,
              thumbnailR2Key: thumbnailR2Key || undefined,
              url: null,
              mp4Url: null,
              width,
              height,
              durationSeconds,
              alt,
              position: idx,
            };
          }
          if (!isReusedKey && !allowedImagePrefixes.some((p) => r2Key.startsWith(p))) {
            throw new BadRequestException('Invalid uploaded media key.');
          }
          return {
            source,
            kind,
            r2Key,
            thumbnailR2Key: undefined,
            url: null,
            mp4Url: null,
            width,
            height,
            durationSeconds: null,
            alt,
            position: idx,
          };
        }

        if (!url) throw new BadRequestException('Invalid Giphy media URL.');
        return {
          source,
          kind,
          r2Key: null,
          thumbnailR2Key: undefined,
          url,
          mp4Url: mp4Url || null,
          width,
          height,
          durationSeconds: null,
          alt,
          position: idx,
        };
      })
      .filter(Boolean);

    const hashtagTokensRaw = body ? this.parseHashtagsFromBody(body) : [];
    const hashtagTokens = hashtagTokensRaw
      .map((t) => ({ tag: (t.tag ?? '').trim().toLowerCase(), variant: (t.variant ?? '').trim() }))
      .filter((t) => Boolean(t.tag && t.variant));
    hashtagTokens.sort((a, b) => a.tag.localeCompare(b.tag) || a.variant.localeCompare(b.variant));
    const hashtags = hashtagTokens.map((t) => t.tag);
    const hashtagCasings = hashtagTokens.map((t) => t.variant);
    const topics = body ? inferTopicsFromText(body, { hashtags, relatedTopics: [] }) : [];

    const created = await this.prisma.post.create({
      data: {
        userId,
        body,
        visibility: 'onlyMe',
        isDraft: true,
        topics,
        hashtags,
        hashtagCasings,
        ...(cleanedMedia.length
          ? {
              media: {
                create: cleanedMedia,
              },
            }
          : {}),
      },
      include: {
        user: { select: USER_LIST_SELECT },
        media: { orderBy: { position: 'asc' } },
        mentions: {
          include: {
            user: {
              select: MENTION_USER_SELECT,
            },
          },
        },
      },
    });

    return created;
  }

  async updateDraft(params: {
    userId: string;
    draftId: string;
    body?: string;
    media: Array<{
      source: 'upload' | 'giphy';
      kind: 'image' | 'gif' | 'video';
      r2Key?: string;
      thumbnailR2Key?: string;
      url?: string;
      mp4Url?: string;
      width?: number;
      height?: number;
      durationSeconds?: number;
      alt?: string | null;
    }> | null;
  }) {
    const id = (params.draftId ?? '').trim();
    if (!id) throw new NotFoundException('Draft not found.');

    const post = await this.prisma.post.findUnique({
      where: { id },
      include: {
        user: { select: USER_LIST_SELECT },
        media: { orderBy: { position: 'asc' } },
        mentions: { select: { userId: true } },
      },
    });
    if (!post) throw new NotFoundException('Draft not found.');
    if (post.userId !== params.userId) throw new ForbiddenException('Not allowed.');
    if (post.deletedAt) throw new ForbiddenException('Draft not found.');
    if (post.visibility !== 'onlyMe' || !post.isDraft) throw new ForbiddenException('Not a draft.');
    if (post.parentId) throw new ForbiddenException('Not a draft.');

    const user = await this.prisma.user.findUnique({
      where: { id: params.userId },
      select: { premium: true },
    });
    if (!user) throw new NotFoundException('User not found.');

    const nextBody = typeof params.body === 'string' ? params.body.trim() : post.body;
    const maxLen = user.premium ? 1000 : 200;
    if (nextBody.length > maxLen) {
      throw new BadRequestException(
        user.premium
          ? 'Posts are limited to 1000 characters.'
          : 'Posts are limited to 200 characters for non-premium members.',
      );
    }

    const media = params.media === null ? null : (params.media ?? null);
    if (media && media.length > 4) throw new BadRequestException('You can attach up to 4 images, GIFs, or videos.');
    if ((media?.length ?? 0) > 0 && !user.premium) throw new ForbiddenException('Upgrade to premium to post media.');

    // If media is provided, validate/clean; otherwise leave unchanged.
    let cleanedMedia:
      | Array<{
          source: 'upload' | 'giphy';
          kind: 'image' | 'gif' | 'video';
          r2Key?: string | null;
          thumbnailR2Key?: string;
          url?: string | null;
          mp4Url?: string | null;
          width?: number | null;
          height?: number | null;
          durationSeconds?: number | null;
          alt?: string | null;
          position: number;
        }>
      | null = null;

    if (media) {
      const allowedImagePrefixes = [`uploads/${params.userId}/images/`, `dev/uploads/${params.userId}/images/`];
      const allowedVideoPrefixes = [`uploads/${params.userId}/videos/`, `dev/uploads/${params.userId}/videos/`];
      const allowedThumbnailPrefixes = [`uploads/${params.userId}/thumbnails/`, `dev/uploads/${params.userId}/thumbnails/`];
      const uploadKeys = media
        .filter((m) => m.source === 'upload' && (m.r2Key ?? '').trim())
        .map((m) => (m.r2Key ?? '').trim());
      const reusedKeySet = new Set(
        uploadKeys.length
          ? (await this.prisma.mediaContentHash.findMany({ where: { r2Key: { in: uploadKeys } }, select: { r2Key: true } })).map((r) => r.r2Key)
          : [],
      );
      cleanedMedia = media
        .map((m, idx) => {
          const source = m.source;
          const kind = m.kind;
          const r2Key = (m.r2Key ?? '').trim();
          const thumbnailR2Key = (m.thumbnailR2Key ?? '').trim() || null;
          const url = (m.url ?? '').trim();
          const mp4Url = (m.mp4Url ?? '').trim();
          const width = typeof m.width === 'number' && Number.isFinite(m.width) ? Math.max(1, Math.floor(m.width)) : null;
          const height = typeof m.height === 'number' && Number.isFinite(m.height) ? Math.max(1, Math.floor(m.height)) : null;
          const durationSeconds =
            typeof m.durationSeconds === 'number' && Number.isFinite(m.durationSeconds) && m.durationSeconds >= 0
              ? Math.floor(m.durationSeconds)
              : null;
          const alt = (m.alt ?? '').trim().slice(0, 500) || null;

          if (source === 'upload') {
            if (!r2Key) throw new BadRequestException('Invalid uploaded media key.');
            const isReusedKey = reusedKeySet.has(r2Key);
            if (kind === 'video') {
              if (!isReusedKey && !allowedVideoPrefixes.some((p) => r2Key.startsWith(p))) {
                throw new BadRequestException('Invalid uploaded video key.');
              }
              if (thumbnailR2Key && !allowedThumbnailPrefixes.some((p) => thumbnailR2Key.startsWith(p))) {
                throw new BadRequestException('Invalid thumbnail key.');
              }
              return {
                source,
                kind,
                r2Key,
                thumbnailR2Key: thumbnailR2Key || undefined,
                url: null,
                mp4Url: null,
                width,
                height,
                durationSeconds,
                alt,
                position: idx,
              };
            }
            if (!isReusedKey && !allowedImagePrefixes.some((p) => r2Key.startsWith(p))) {
              throw new BadRequestException('Invalid uploaded media key.');
            }
            return {
              source,
              kind,
              r2Key,
              thumbnailR2Key: undefined,
              url: null,
              mp4Url: null,
              width,
              height,
              durationSeconds: null,
              alt,
              position: idx,
            };
          }

          if (!url) throw new BadRequestException('Invalid Giphy media URL.');
          return {
            source,
            kind,
            r2Key: null,
            thumbnailR2Key: undefined,
            url,
            mp4Url: mp4Url || null,
            width,
            height,
            durationSeconds: null,
            alt,
            position: idx,
          };
        })
        .filter(Boolean);
    }

    const hashtagTokensRaw = nextBody ? this.parseHashtagsFromBody(nextBody) : [];
    const hashtagTokens = hashtagTokensRaw
      .map((t) => ({ tag: (t.tag ?? '').trim().toLowerCase(), variant: (t.variant ?? '').trim() }))
      .filter((t) => Boolean(t.tag && t.variant));
    hashtagTokens.sort((a, b) => a.tag.localeCompare(b.tag) || a.variant.localeCompare(b.variant));
    const hashtags = hashtagTokens.map((t) => t.tag);
    const hashtagCasings = hashtagTokens.map((t) => t.variant);
    const topics = nextBody ? inferTopicsFromText(nextBody, { hashtags, relatedTopics: [] }) : [];

    const fromBodyMentions = nextBody ? this.parseMentionsFromBody(nextBody) : [];
    const bodyMentionIds = await this.resolveMentionUsernames(fromBodyMentions);
    const existingMentionIds = Array.isArray((post as any).mentions) ? ((post as any).mentions as Array<{ userId: string }>).map((m) => m.userId) : [];
    const mentionUserIds = Array.from(new Set([...existingMentionIds, ...bodyMentionIds])).filter(Boolean);

    const updated = await this.prisma.$transaction(async (tx) => {
      const next = await tx.post.update({
        where: { id: post.id },
        data: {
          body: nextBody,
          topics,
          hashtags,
          hashtagCasings,
        },
        include: {
          user: { select: USER_LIST_SELECT },
          media: { orderBy: { position: 'asc' } },
          mentions: {
            include: {
              user: {
                select: MENTION_USER_SELECT,
              },
            },
          },
        },
      });

      if (cleanedMedia) {
        await tx.postMedia.deleteMany({ where: { postId: post.id } });
        if (cleanedMedia.length > 0) {
          await tx.postMedia.createMany({
            data: cleanedMedia.map((m) => ({
              postId: post.id,
              source: m.source,
              kind: m.kind,
              r2Key: (m as any).r2Key ?? null,
              thumbnailR2Key: (m as any).thumbnailR2Key ?? null,
              url: (m as any).url ?? null,
              mp4Url: (m as any).mp4Url ?? null,
              width: (m as any).width ?? null,
              height: (m as any).height ?? null,
              durationSeconds: (m as any).durationSeconds ?? null,
              alt: (m as any).alt ?? null,
              position: m.position,
            })),
            skipDuplicates: false,
          });
        }
      }

      await tx.postMention.deleteMany({ where: { postId: post.id } });
      if (mentionUserIds.length > 0) {
        await tx.postMention.createMany({
          data: mentionUserIds.map((uid) => ({ postId: post.id, userId: uid })),
          skipDuplicates: true,
        });
      }

      return next;
    });

    return updated;
  }

  async deleteDraft(params: { userId: string; draftId: string }) {
    const id = (params.draftId ?? '').trim();
    if (!id) throw new NotFoundException('Draft not found.');
    const post = await this.prisma.post.findUnique({ where: { id }, select: { id: true, userId: true, deletedAt: true, visibility: true, isDraft: true } });
    if (!post) throw new NotFoundException('Draft not found.');
    if (post.userId !== params.userId) throw new ForbiddenException('Not allowed.');
    if (post.visibility !== 'onlyMe' || !post.isDraft) throw new ForbiddenException('Not a draft.');
    if (post.deletedAt) return { success: true };
    await this.prisma.post.update({ where: { id }, data: { deletedAt: new Date() } });
    return { success: true };
  }

  async publishFromOnlyMe(params: {
    userId: string;
    sourcePostId: string;
    body: string | null;
    visibility: PostVisibility;
    media?: Array<
      | { source: 'existing'; id: string; alt?: string | null }
      | {
          source: 'upload';
          kind: 'image' | 'gif' | 'video';
          r2Key?: string;
          thumbnailR2Key?: string;
          url?: string;
          mp4Url?: string;
          width?: number;
          height?: number;
          durationSeconds?: number;
          alt?: string | null;
        }
      | {
          source: 'giphy';
          kind: 'gif';
          url: string;
          mp4Url?: string;
          width?: number;
          height?: number;
          alt?: string | null;
        }
    > | null;
  }) {
    const sourceId = (params.sourcePostId ?? '').trim();
    if (!sourceId) throw new NotFoundException('Post not found.');

    const source = await this.prisma.post.findUnique({
      where: { id: sourceId },
      include: { media: { orderBy: { position: 'asc' } } },
    });
    if (!source) throw new NotFoundException('Post not found.');
    if (source.userId !== params.userId) throw new ForbiddenException('Not allowed.');
    if (source.deletedAt) throw new NotFoundException('Post not found.');
    if (source.visibility !== 'onlyMe') throw new ForbiddenException('Not allowed.');
    if (source.parentId) throw new ForbiddenException('Not allowed.');

    const body = (params.body ?? source.body ?? '').trim();

    const sourceMediaSorted = (source.media ?? [])
      .slice()
      .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));

    const requested = (params.media ?? null) as (NonNullable<(typeof params)['media']>) | null;

    const media = requested
      ? requested.map((m) => {
          if (m.source === 'existing') {
            const id = (m.id ?? '').trim();
            if (!id) throw new BadRequestException('Invalid media item.');
            const found = sourceMediaSorted.find((sm) => sm.id === id && !sm.deletedAt);
            if (!found) throw new BadRequestException('Invalid media item.');
            const alt = (m.alt ?? '').trim() || (found.alt ?? '').trim() || null;
            return {
              source: found.source === 'giphy' ? ('giphy' as const) : ('upload' as const),
              kind: found.kind as 'image' | 'gif' | 'video',
              r2Key: found.r2Key ?? undefined,
              thumbnailR2Key: found.thumbnailR2Key ?? undefined,
              url: found.url ?? undefined,
              mp4Url: found.mp4Url ?? undefined,
              width: found.width ?? undefined,
              height: found.height ?? undefined,
              durationSeconds: (found as any).durationSeconds ?? undefined,
              alt,
            };
          }
          if (m.source === 'giphy') {
            return {
              source: 'giphy' as const,
              kind: 'gif' as const,
              url: m.url,
              mp4Url: m.mp4Url ?? undefined,
              width: m.width ?? undefined,
              height: m.height ?? undefined,
              alt: (m.alt ?? '').trim() || null,
            };
          }
          // upload
          return {
            source: 'upload' as const,
            kind: m.kind,
            r2Key: m.r2Key ?? undefined,
            thumbnailR2Key: m.thumbnailR2Key ?? undefined,
            width: m.width ?? undefined,
            height: m.height ?? undefined,
            durationSeconds: (m as any).durationSeconds ?? undefined,
            alt: (m.alt ?? '').trim() || null,
          };
        })
      : sourceMediaSorted.map((m) => ({
          source: m.source === 'giphy' ? ('giphy' as const) : ('upload' as const),
          kind: m.kind as 'image' | 'gif' | 'video',
          r2Key: m.r2Key ?? undefined,
          thumbnailR2Key: m.thumbnailR2Key ?? undefined,
          url: m.url ?? undefined,
          mp4Url: m.mp4Url ?? undefined,
          width: m.width ?? undefined,
          height: m.height ?? undefined,
          durationSeconds: (m as any).durationSeconds ?? undefined,
          alt: (m.alt ?? '').trim() || null,
        }));

    const created = await this.createPost({
      userId: params.userId,
      body,
      visibility: params.visibility,
      parentId: null,
      mentions: null,
      media: media.length ? media : null,
      poll: null,
    });

    // Fetch with mentions for UI consistency.
    const full = await this.prisma.post.findUnique({
      where: { id: created.id },
      include: {
        user: { select: USER_LIST_SELECT },
        media: { orderBy: { position: 'asc' } },
        poll: { include: { options: { orderBy: { position: 'asc' } } } },
        mentions: {
          include: {
            user: {
              select: MENTION_USER_SELECT,
            },
          },
        },
      },
    });
    const out = full ?? created;
    if ((out as any)?.visibility && (out as any).visibility !== 'onlyMe') {
      const topics = Array.isArray((out as any).topics) ? ((out as any).topics as string[]) : [];
      await this.cacheInvalidation.bumpForPostWrite({ topics });
    }
    return out;
  }

  /** Resolve usernames to user ids (case-insensitive, usernameIsSet). Invalid usernames ignored. */
  private async resolveMentionUsernames(usernames: string[]): Promise<string[]> {
    if (usernames.length === 0) return [];
    const normalized = [...new Set(usernames.map((u) => u.trim().slice(0, 120)).filter(Boolean))];
    if (normalized.length === 0) return [];
    const users = await this.prisma.user.findMany({
      where: {
        usernameIsSet: true,
        OR: normalized.map((u) => ({ username: { equals: u, mode: 'insensitive' as const } })),
      },
      select: { id: true, username: true },
    });
    const byLower = new Map<string, string>();
    for (const u of users) {
      if (u.username) byLower.set(u.username.toLowerCase(), u.id);
    }
    const ids: string[] = [];
    const seen = new Set<string>();
    for (const name of normalized) {
      const id = byLower.get(name.toLowerCase());
      if (id && !seen.has(id)) {
        seen.add(id);
        ids.push(id);
      }
    }
    return ids;
  }

  /** Parse @username tokens from body: letter then 0–14 [A-Za-z0-9_] (1–15 chars), not mid-email. */
  private parseMentionsFromBody(body: string): string[] {
    return parseMentionsFromBodyText(body);
  }

  /** Parse #hashtag tokens from body: letter then [A-Za-z0-9_], stored lowercase without '#'. */
  private parseHashtagsFromBody(body: string): HashtagToken[] {
    return parseHashtagTokensFromText(body);
  }

  /** Thread participant role for reply notifications. */
  private static readonly REPLY_TITLE = {
    root_author: "replied to your post",
    reply_author: "replied to your comment",
    mentioned_in_root: "replied to a post you're mentioned in",
    mentioned_in_reply: "replied to a comment you're mentioned in",
  } as const;

  /**
   * Walk parent chain from parentId up to root; return map of userId -> role for thread participants.
   * Used to notify everyone in the thread with the correct label (and to dedupe with @mentions).
   */
  private async getThreadParticipantRoles(parentId: string): Promise<Map<string, keyof typeof PostsService.REPLY_TITLE>> {
    const map = new Map<string, keyof typeof PostsService.REPLY_TITLE>();
    let currentId: string | null = parentId;
    const select = { id: true, parentId: true, userId: true, mentions: { select: { userId: true } } } as const;
    type ThreadPost = Prisma.PostGetPayload<{ select: typeof select }>;
    while (currentId) {
      const post: ThreadPost | null = await this.prisma.post.findFirst({
        where: { id: currentId, ...this.notDeletedWhere() },
        select,
      });
      if (!post) break;
      const isRoot = !post.parentId;
      const authorRole = isRoot ? 'root_author' : 'reply_author';
      const mentionRole = isRoot ? 'mentioned_in_root' : 'mentioned_in_reply';
      map.set(post.userId, authorRole);
      for (const m of post.mentions) {
        if (!map.has(m.userId)) map.set(m.userId, mentionRole);
      }
      currentId = post.parentId;
    }
    return map;
  }

  async createPost(params: {
    userId: string;
    body: string;
    visibility: PostVisibility;
    parentId?: string | null;
    mentions?: string[] | null;
    media: Array<{
      source: 'upload' | 'giphy';
      kind: 'image' | 'gif' | 'video';
      r2Key?: string;
      thumbnailR2Key?: string;
      url?: string;
      mp4Url?: string;
      width?: number;
      height?: number;
      durationSeconds?: number;
      alt?: string | null;
    }> | null;
    poll: {
      endsAt: Date;
      options: Array<{
        text: string;
        image: { r2Key: string; width: number | null; height: number | null; alt: string | null } | null;
      }>;
    } | null;
  }) {
    const { userId, body, visibility: requestedVisibility, parentId, mentions: clientMentions } = params;
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { verifiedStatus: true, premium: true, premiumPlus: true },
    });
    if (!user) throw new NotFoundException('User not found.');
    const viewerIsVerified = Boolean(user.verifiedStatus && user.verifiedStatus !== 'none');

    // Product rule: unverified users cannot create new public feed posts.
    // (UI already hides this, but enforce on the API too.)
    if (!viewerIsVerified && !parentId && requestedVisibility === 'public') {
      throw new ForbiddenException('Verify your account to create public posts.');
    }
    // Creation is gated by current tier: downgraded users can only create within their tier.
    const allowedForCreation = this.allowedVisibilitiesForViewer(user);
    if (requestedVisibility !== 'onlyMe' && !allowedForCreation.includes(requestedVisibility)) {
      if (requestedVisibility === 'verifiedOnly') throw new ForbiddenException('Verify your account to create verified-only posts.');
      if (requestedVisibility === 'premiumOnly') throw new ForbiddenException('Upgrade to premium to create premium-only posts.');
      throw new ForbiddenException('You cannot create posts with that visibility.');
    }

    let visibility: PostVisibility = requestedVisibility;
    let threadParticipantIds: string[] = [];
    let parentAuthorUserId: string | null = null;
    let threadRootId: string | null = null; // Root post ID for thread hierarchy
    let parentTopics: string[] = [];
    let rootTopics: string[] = [];

    if (parentId) {
      const parent = await this.prisma.post.findFirst({
        where: { id: parentId, ...this.notDeletedWhere() },
        select: { id: true, userId: true, visibility: true, rootId: true, topics: true },
      });
      if (!parent) throw new NotFoundException('Post not found.');
      parentAuthorUserId = parent.userId;
      parentTopics = Array.isArray(parent.topics) ? (parent.topics as string[]) : [];
      if (parent.visibility === 'onlyMe') {
        throw new ForbiddenException('Comments are not allowed on only-me posts.');
      }
      if (!viewerIsVerified && parent.visibility === 'public') {
        throw new ForbiddenException('Verify your account to reply publicly.');
      }
      const viewer = await this.viewerContextService.getViewer(userId);
      const allowed = this.allowedVisibilitiesForViewer(viewer);
      const isSelf = parent.userId === userId;
      if (!isSelf) {
        if (!allowed.includes(parent.visibility)) {
          if (parent.visibility === 'verifiedOnly') throw new ForbiddenException('Verify to view verified-only posts.');
          if (parent.visibility === 'premiumOnly') throw new ForbiddenException('Upgrade to premium to view premium-only posts.');
          throw new ForbiddenException('Not allowed to reply to this post.');
        }
      }
      visibility = parent.visibility as PostVisibility;

      // Use parent's rootId if it exists (parent is also a reply), otherwise parent.id is the root
      threadRootId = (parent as { rootId?: string | null }).rootId ?? parent.id;
      if (threadRootId && threadRootId !== parent.id) {
        const root = await this.prisma.post.findFirst({
          where: { id: threadRootId, ...this.notDeletedWhere() },
          select: { topics: true },
        });
        rootTopics = Array.isArray(root?.topics) ? ((root?.topics ?? []) as string[]) : [];
      } else {
        rootTopics = parentTopics;
      }

      // Collect thread participants using rootId for efficient query (works for any thread depth)
      const threadPosts = await this.prisma.post.findMany({
        where: { OR: [{ id: threadRootId }, { rootId: threadRootId }], ...this.notDeletedWhere() },
        select: { userId: true, mentions: { select: { userId: true } } },
      });
      const participantIds = new Set<string>();
      for (const p of threadPosts) {
        participantIds.add(p.userId);
        for (const m of p.mentions) participantIds.add(m.userId);
      }
      threadParticipantIds = Array.from(participantIds);
    }

    // Rate limits (tier-specific). Exclude onlyMe so private notes/drafts don't count.
    // Unverified users can only create onlyMe posts; skip rate limit entirely for them.
    if (viewerIsVerified) {
      const cfg = await this.getSiteConfig();
      const isPremium = Boolean(user.premium);

      const postsPerWindow = isPremium ? cfg.premiumPostsPerWindow : cfg.verifiedPostsPerWindow;
      const windowSeconds = isPremium ? cfg.premiumWindowSeconds : cfg.verifiedWindowSeconds;

      const windowStart = new Date(Date.now() - windowSeconds * 1000);
      const recentCount = await this.prisma.post.count({
        where: { userId, createdAt: { gte: windowStart }, visibility: { not: 'onlyMe' } },
      });
      if (recentCount >= postsPerWindow) {
        const minutes = Math.max(1, Math.round(windowSeconds / 60));
        const minuteLabel = minutes === 1 ? 'minute' : 'minutes';
        throw new HttpException(
          `You are posting too often. You can make up to ${postsPerWindow} posts every ${minutes} ${minuteLabel}.`,
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
    }

    const maxLen = user.premium ? 1000 : 200;
    if (body.length > maxLen) {
      throw new BadRequestException(
        user.premium
          ? 'Posts are limited to 1000 characters.'
          : 'Posts are limited to 200 characters for non-premium members.',
      );
    }

    const media = (params.media ?? []).filter(Boolean);
    if (media.length > 4) throw new BadRequestException('You can attach up to 4 images, GIFs, or videos.');

    const poll = params.poll;
    if (poll && parentId) {
      throw new ForbiddenException('Polls are not allowed on replies.');
    }
    if (poll && media.length > 0) {
      throw new BadRequestException('You cannot attach media to a poll post.');
    }
    // Product rule: polls are Premium/Premium+ only.
    if (poll && !user.premium) {
      throw new ForbiddenException('Upgrade to premium to create polls.');
    }
    if (poll) {
      const endsAtMs = poll.endsAt instanceof Date ? poll.endsAt.getTime() : new Date(poll.endsAt as any).getTime();
      const now = Date.now();
      const maxMs = 7 * 24 * 60 * 60 * 1000;
      if (!Number.isFinite(endsAtMs) || endsAtMs <= now) throw new BadRequestException('Invalid poll duration.');
      if (endsAtMs > now + maxMs) throw new BadRequestException('Poll duration must be 7 days or shorter.');
      const opts = Array.isArray(poll.options) ? poll.options : [];
      if (opts.length < 2 || opts.length > 5) throw new BadRequestException('Poll must include 2 to 5 options.');
    }

    // Product rule: media posts are Premium/Premium+ only (images, GIFs/Giphy, video).
    if (media.length > 0 && !user.premium) {
      throw new ForbiddenException('Upgrade to premium to post media.');
    }

    const hasVideo = media.some((m) => m.kind === 'video');
    if (hasVideo && !user.premium) {
      throw new ForbiddenException('Video posts are for premium members only.');
    }

    const allowedImagePrefixes = [`uploads/${userId}/images/`, `dev/uploads/${userId}/images/`];
    const allowedVideoPrefixes = [`uploads/${userId}/videos/`, `dev/uploads/${userId}/videos/`];
    const allowedThumbnailPrefixes = [`uploads/${userId}/thumbnails/`, `dev/uploads/${userId}/thumbnails/`];

    // Keys that exist in MediaContentHash (reused uploads from any user) are allowed.
    const pollImageKeys = (poll?.options ?? [])
      .map((o) => (o?.image?.r2Key ?? '').trim())
      .filter(Boolean);
    const uploadKeys = [
      ...media
        .filter((m) => m.source === 'upload' && (m.r2Key ?? '').trim())
        .map((m) => (m.r2Key ?? '').trim()),
      ...pollImageKeys,
    ];
    const reusedKeySet = new Set(
      uploadKeys.length
        ? (await this.prisma.mediaContentHash.findMany({ where: { r2Key: { in: uploadKeys } }, select: { r2Key: true } })).map((r) => r.r2Key)
        : [],
    );

    const cleanedMedia = media
      .map((m, idx) => {
        const source = m.source;
        const kind = m.kind;
        const r2Key = (m.r2Key ?? '').trim();
        const thumbnailR2Key = (m.thumbnailR2Key ?? '').trim() || null;
        const url = (m.url ?? '').trim();
        const mp4Url = (m.mp4Url ?? '').trim();
        const width = typeof m.width === 'number' && Number.isFinite(m.width) ? Math.max(1, Math.floor(m.width)) : null;
        const height = typeof m.height === 'number' && Number.isFinite(m.height) ? Math.max(1, Math.floor(m.height)) : null;
        const durationSeconds =
          typeof m.durationSeconds === 'number' && Number.isFinite(m.durationSeconds) && m.durationSeconds >= 0
            ? Math.floor(m.durationSeconds)
            : null;
        const alt = (m.alt ?? '').trim().slice(0, 500) || null;

        if (source === 'upload') {
          if (!r2Key) throw new BadRequestException('Invalid uploaded media key.');
          const isReusedKey = reusedKeySet.has(r2Key);
          if (kind === 'video') {
            if (!isReusedKey && !allowedVideoPrefixes.some((p) => r2Key.startsWith(p))) {
              throw new BadRequestException('Invalid uploaded video key.');
            }
            if (thumbnailR2Key && !allowedThumbnailPrefixes.some((p) => thumbnailR2Key.startsWith(p))) {
              throw new BadRequestException('Invalid thumbnail key.');
            }
            return {
              source,
              kind,
              r2Key,
              thumbnailR2Key: thumbnailR2Key || undefined,
              url: null,
              mp4Url: null,
              width,
              height,
              durationSeconds,
              alt,
              position: idx,
            };
          }
          if (!isReusedKey && !allowedImagePrefixes.some((p) => r2Key.startsWith(p))) {
            throw new BadRequestException('Invalid uploaded media key.');
          }
          return {
            source,
            kind,
            r2Key,
            thumbnailR2Key: undefined,
            url: null,
            mp4Url: null,
            width,
            height,
            durationSeconds: null,
            alt,
            position: idx,
          };
        }

        if (!url) throw new BadRequestException('Invalid Giphy media URL.');
        return {
          source,
          kind,
          r2Key: null,
          thumbnailR2Key: undefined,
          url,
          mp4Url: mp4Url || null,
          width,
          height,
          durationSeconds: null,
          alt,
          position: idx,
        };
      })
      .filter(Boolean);

    const cleanedPollOptions = poll
      ? (poll.options ?? []).map((o, idx) => {
          const text = (o?.text ?? '').trim().slice(0, 30);
          const img = o?.image ?? null;
          if (!text && !img) throw new BadRequestException('Poll option must include text or an image.');
          if (!img) {
            return { text, position: idx, imageR2Key: null as string | null, imageWidth: null as number | null, imageHeight: null as number | null, imageAlt: null as string | null };
          }
          const r2Key = (img.r2Key ?? '').trim();
          if (!r2Key) throw new BadRequestException('Invalid poll option image key.');
          const isReusedKey = reusedKeySet.has(r2Key);
          if (!isReusedKey && !allowedImagePrefixes.some((p) => r2Key.startsWith(p))) {
            throw new BadRequestException('Invalid poll option image key.');
          }
          const width = typeof img.width === 'number' && Number.isFinite(img.width) ? Math.max(1, Math.floor(img.width)) : null;
          const height = typeof img.height === 'number' && Number.isFinite(img.height) ? Math.max(1, Math.floor(img.height)) : null;
          const alt = (img.alt ?? '').trim().slice(0, 500) || null;
          return { text, position: idx, imageR2Key: r2Key, imageWidth: width, imageHeight: height, imageAlt: alt };
        })
      : null;

    // Parse explicit @mentions from body text only (for notification priority)
    const fromBody = this.parseMentionsFromBody(body);
    const bodyMentionIds = await this.resolveMentionUsernames(fromBody);
    const bodyMentionSet = new Set(bodyMentionIds); // Only body mentions determine notification priority

    // Client-provided mentions (thread participants from frontend) - used for PostMention records only
    const clientUsernames = Array.isArray(clientMentions) ? clientMentions.filter((x) => typeof x === 'string' && x.length <= 120) : [];
    const allUsernames = [...new Set([...clientUsernames, ...fromBody])];
    const resolvedFromUsernames = await this.resolveMentionUsernames(allUsernames);

    // All mention IDs for PostMention records (include self so @yourname renders as a link)
    const mentionUserIds = [...new Set([...threadParticipantIds, ...resolvedFromUsernames])];

    const hashtagTokensRaw = this.parseHashtagsFromBody(body);
    const hashtagTokens = hashtagTokensRaw
      .map((t) => ({ tag: (t.tag ?? '').trim().toLowerCase(), variant: (t.variant ?? '').trim() }))
      .filter((t) => Boolean(t.tag && t.variant));
    hashtagTokens.sort((a, b) => a.tag.localeCompare(b.tag) || a.variant.localeCompare(b.variant));
    const hashtags = hashtagTokens.map((t) => t.tag);
    const hashtagCasings = hashtagTokens.map((t) => t.variant);

    let parentCommentCount: number | null = null;
    const post = await this.prisma.$transaction(async (tx) => {
      const relatedTopics = Array.from(new Set([...(parentTopics ?? []), ...(rootTopics ?? [])])).filter(Boolean);
      const topics = inferTopicsFromText(body, { hashtags, relatedTopics });
      const created = await tx.post.create({
        data: {
          body,
          topics,
          hashtags,
          hashtagCasings,
          visibility,
          userId,
          parentId: parentId ?? undefined,
          rootId: threadRootId ?? undefined, // Set root post ID for thread hierarchy
          ...(cleanedMedia.length
            ? {
                media: {
                  create: cleanedMedia,
                },
              }
            : {}),
          ...(poll
            ? {
                poll: {
                  create: {
                    endsAt: poll.endsAt,
                    ...(cleanedPollOptions?.length
                      ? {
                          options: {
                            create: cleanedPollOptions.map((o) => ({
                              text: o.text,
                              position: o.position,
                              imageR2Key: o.imageR2Key ?? undefined,
                              imageWidth: o.imageWidth ?? undefined,
                              imageHeight: o.imageHeight ?? undefined,
                              imageAlt: o.imageAlt ?? undefined,
                            })),
                          },
                        }
                      : {}),
                  },
                },
              }
            : {}),
        },
        include: { user: { select: USER_LIST_SELECT }, media: { orderBy: { position: 'asc' } }, poll: { include: { options: { orderBy: { position: 'asc' } } } } },
      });

      if (parentId) {
        const parentAfter = await tx.post.update({
          where: { id: parentId },
          data: { commentCount: { increment: 1 } },
          select: { commentCount: true },
        });
        parentCommentCount = typeof parentAfter.commentCount === 'number' ? parentAfter.commentCount : null;
      }

      if (mentionUserIds.length > 0) {
        await tx.postMention.createMany({
          data: mentionUserIds.map((uid) => ({ postId: created.id, userId: uid })),
          skipDuplicates: true,
        });
      }

      if (hashtagTokens.length > 0) {
        for (const tok of hashtagTokens) {
          const t = tok.tag;
          const variant = tok.variant;
          await tx.hashtag.upsert({
            where: { tag: t },
            create: { tag: t, usageCount: 1 },
            update: { usageCount: { increment: 1 } },
          });
          await tx.hashtagVariant.upsert({
            where: { tag_variant: { tag: t, variant } },
            create: { tag: t, variant, count: 1 },
            update: { count: { increment: 1 } },
          });
        }
      }

      return created;
    });

    // Versioned read caches: bump after successful create so public reads shift namespaces immediately.
    if ((post as any)?.visibility && (post as any).visibility !== 'onlyMe') {
      const topics = Array.isArray((post as any).topics) ? ((post as any).topics as string[]) : [];
      await this.cacheInvalidation.bumpForPostWrite({ topics });
    }

    // Realtime: bump parent commentCount for live subscribers (best-effort).
    if (parentId) {
      try {
        if (typeof parentCommentCount === 'number') {
          this.presenceRealtime.emitPostsLiveUpdated(parentId, {
            postId: parentId,
            version: new Date().toISOString(),
            reason: 'comment_created',
            patch: { commentCount: parentCommentCount },
          });
        }
      } catch {
        // Best-effort
      }
    }

    // Notifications: parent author + thread participants get "comment" notifications.
    // Only explicit @mentions in body get "mention" notifications (and override "comment" for that user).
    const bodySnippet = body.trim().slice(0, 150);

    if (parentId && parentAuthorUserId !== userId) {
      const threadRoles = await this.getThreadParticipantRoles(parentId);
      const parentRole = threadRoles.get(parentAuthorUserId ?? '');
      const parentTitle =
        parentRole === 'reply_author'
          ? PostsService.REPLY_TITLE.reply_author
          : parentRole === 'root_author'
            ? PostsService.REPLY_TITLE.root_author
            : PostsService.REPLY_TITLE.reply_author;

      // Parent author: one notification. If they're explicitly @mentioned in body, they get only the mention (below).
      // Use parentId as subject so preview shows the post that was replied to (including its media).
      if (parentAuthorUserId && !bodyMentionSet.has(parentAuthorUserId)) {
        this.notifications
          .create({
            recipientUserId: parentAuthorUserId,
            kind: 'comment',
            actorUserId: userId,
            actorPostId: post.id,
            subjectPostId: parentId,
            title: parentTitle,
            body: bodySnippet || undefined,
          })
          .catch((err) => {
            this.logger.warn(`[notifications] Failed to create comment notification: ${err instanceof Error ? err.message : String(err)}`);
          });
      }

      // Other thread participants (excluding parent author and self): one each, unless they're explicitly @mentioned in body.
      for (const [uid, role] of threadRoles) {
        if (uid === userId || uid === parentAuthorUserId || bodyMentionSet.has(uid)) continue;
        const title = PostsService.REPLY_TITLE[role];
        this.notifications
          .create({
            recipientUserId: uid,
            kind: 'comment',
            actorUserId: userId,
            actorPostId: post.id,
            subjectPostId: parentId,
            title,
            body: bodySnippet || undefined,
          })
          .catch((err) => {
            this.logger.warn(`[notifications] Failed to create thread reply notification: ${err instanceof Error ? err.message : String(err)}`);
          });
      }
    }

    // Explicit @mentions in body: one notification each. These take priority over comment notifications.
    const mentionTitle = parentId ? 'mentioned you in a reply' : 'mentioned you in a post';
    for (const uid of bodyMentionIds) {
      if (uid === userId) continue;
      this.notifications
        .create({
          recipientUserId: uid,
          kind: 'mention',
          actorUserId: userId,
          actorPostId: post.id,
          subjectPostId: post.id,
          title: mentionTitle,
          body: bodySnippet || undefined,
        })
        .catch((err) => {
          this.logger.warn(`[notifications] Failed to create mention notification: ${err instanceof Error ? err.message : String(err)}`);
        });
    }

    // Follower notifications: when someone you follow publishes a top-level post.
    // Filter recipients by post visibility so we don't notify followers who can't view it.
    if (!parentId && visibility !== 'onlyMe') {
      try {
        const follows = await this.prisma.follow.findMany({
          where: { followingId: userId },
          select: {
            followerId: true,
            follower: { select: { verifiedStatus: true, premium: true, premiumPlus: true } },
          },
        });

        for (const f of follows) {
          const recipientUserId = f.followerId;
          if (!recipientUserId || recipientUserId === userId) continue;
          // If the follower is explicitly @mentioned, keep only the mention notification.
          if (bodyMentionSet.has(recipientUserId)) continue;

          if (visibility === 'verifiedOnly') {
            const vs = f.follower?.verifiedStatus ?? 'none';
            if (!vs || vs === 'none') continue;
          }
          if (visibility === 'premiumOnly') {
            const isPremium = Boolean(f.follower?.premium || f.follower?.premiumPlus);
            if (!isPremium) continue;
          }

          this.notifications
            .create({
              recipientUserId,
              kind: 'followed_post',
              actorUserId: userId,
              actorPostId: post.id,
              subjectPostId: post.id,
              // Visiting the actor's profile should clear these.
              subjectUserId: userId,
              body: bodySnippet || undefined,
            })
            .catch((err) => {
              this.logger.warn(
                `[notifications] Failed to create followed-post notification: ${err instanceof Error ? err.message : String(err)}`,
              );
            });
        }
      } catch (err) {
        this.logger.warn(
          `[notifications] Failed to query followers for followed-post notifications: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    const withMentions = await this.prisma.post.findUnique({
      where: { id: post.id },
      include: {
        user: { select: USER_LIST_SELECT },
        media: { orderBy: { position: 'asc' } },
        mentions: { include: { user: { select: MENTION_USER_SELECT } } },
        poll: { include: { options: { orderBy: { position: 'asc' } } } },
      },
    });
    return withMentions!;
  }

  async voteOnPoll(params: { userId: string; postId: string; optionId: string }) {
    return await this.polls.voteOnPoll(params);
  }

  private async ensureUserCanBoost(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, usernameIsSet: true, verifiedStatus: true },
    });
    if (!user) throw new NotFoundException('User not found.');
    if (!user.usernameIsSet) throw new ForbiddenException('Set a username to boost posts.');
    // Tier rule: Unverified users are read-only (no meaningful reactions).
    if (!user.verifiedStatus || user.verifiedStatus === 'none') {
      throw new ForbiddenException('Verify your account to boost posts.');
    }
  }

  async boostPost(params: { userId: string; postId: string }) {
    const { userId, postId } = params;
    const id = (postId ?? '').trim();
    if (!id) throw new NotFoundException('Post not found.');

    await this.ensureUserCanBoost(userId);

    const post = await this.getById({ viewerUserId: userId, id });
    if (post.deletedAt) throw new BadRequestException('Deleted posts cannot be boosted.');
    if (post.visibility === 'onlyMe') throw new BadRequestException('Only-me posts cannot be boosted.');

    const res = await this.prisma.$transaction(async (tx) => {
      const created = await tx.boost.createMany({
        data: [{ postId: id, userId }],
        skipDuplicates: true,
      });

      if (created.count === 1) {
        await tx.post.update({
          where: { id },
          data: {
            boostCount: { increment: 1 },
            boostScore: null,
            boostScoreUpdatedAt: null,
          },
        });
      }

      const updated = await tx.post.findUnique({
        where: { id },
        select: { boostCount: true },
      });

      return {
        boostCount: updated?.boostCount ?? 0,
        createdCount: created.count,
      };
    });

    if (post.userId !== userId) {
      const bodySnippet = (post.body ?? '').trim().slice(0, 150) || undefined;
      this.notifications
        .upsertBoostNotification({
          recipientUserId: post.userId,
          actorUserId: userId,
          subjectPostId: id,
          bodySnippet: bodySnippet ?? null,
        })
        .catch(() => {});
    }

    // Realtime post interaction update (post author + actor).
    const recipients = new Set<string>([userId, post.userId].filter(Boolean));
    this.presenceRealtime.emitPostsInteraction(recipients, {
      postId: id,
      actorUserId: userId,
      kind: 'boost',
      active: true,
      boostCount: res.boostCount,
    });

    // Popular/trending/featured feeds are boost-sensitive. Bump so anon caches shift instantly.
    await this.cacheInvalidation.bumpFeedGlobal();

    return { success: true, viewerHasBoosted: true, boostCount: res.boostCount };
  }

  async unboostPost(params: { userId: string; postId: string }) {
    const { userId, postId } = params;
    const id = (postId ?? '').trim();
    if (!id) throw new NotFoundException('Post not found.');

    await this.ensureUserCanBoost(userId);

    const post = await this.getById({ viewerUserId: userId, id });
    if (post.deletedAt) throw new BadRequestException('Deleted posts cannot be boosted.');
    if (post.visibility === 'onlyMe') throw new BadRequestException('Only-me posts cannot be boosted.');

    const res = await this.prisma.$transaction(async (tx) => {
      const deleted = await tx.boost.deleteMany({
        where: { postId: id, userId },
      });

      if (deleted.count === 1) {
        await tx.post.update({
          where: { id },
          data: {
            boostCount: { decrement: 1 },
            boostScore: null,
            boostScoreUpdatedAt: null,
          },
        });
      }

      const updated = await tx.post.findUnique({
        where: { id },
        select: { boostCount: true },
      });

      return {
        boostCount: updated?.boostCount ?? 0,
      };
    });

    if (post.userId !== userId) {
      this.notifications.deleteBoostNotification(post.userId, userId, id).catch(() => {});
    }

    // Realtime post interaction update (post author + actor).
    const recipients = new Set<string>([userId, post.userId].filter(Boolean));
    this.presenceRealtime.emitPostsInteraction(recipients, {
      postId: id,
      actorUserId: userId,
      kind: 'boost',
      active: false,
      boostCount: res.boostCount,
    });

    // Popular/trending/featured feeds are boost-sensitive. Bump so anon caches shift instantly.
    await this.cacheInvalidation.bumpFeedGlobal();

    return { success: true, viewerHasBoosted: false, boostCount: res.boostCount };
  }
}

