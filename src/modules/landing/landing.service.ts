import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AppConfigService } from '../app/app-config.service';
import { ArticlesService } from '../articles/articles.service';
import { PrismaService } from '../prisma/prisma.service';
import { CacheService } from '../redis/cache.service';
import { CacheTtl } from '../redis/cache-ttl';
import { RedisKeys } from '../redis/redis-keys';
import type { LandingSnapshotDto } from '../../common/dto/landing.dto';
import { toPostDto, toUserListDto, type UserListRow } from '../../common/dto';
import type { PostWithAuthorAndMedia } from '../../common/dto/post.dto';
import { POST_WITH_POLL_INCLUDE } from '../../common/prisma-includes/post.include';
import { MENTION_USER_SELECT, USER_LIST_SELECT } from '../../common/prisma-selects/user.select';
import { ACTIVITY_WINDOW_DAYS, scoreActiveMan } from './landing-score';

/** Extends the standard poll include with a shallow parent for "Replying to @username". */
const LANDING_POST_INCLUDE = {
  ...POST_WITH_POLL_INCLUDE,
  parent: {
    include: {
      user: { select: USER_LIST_SELECT },
      media: { orderBy: { position: 'asc' as const } },
      mentions: { include: { user: { select: MENTION_USER_SELECT } } },
    },
  },
} as const;

type TopPostRow = {
  id: string;
  weekly_views: bigint;
  root_id: string;
  author_id: string;
};

type CandidateManRow = {
  id: string;
  last_active_at: Date | null;
  recent_post_count: bigint;
};

type StatsRow = {
  public_posts: bigint;
  verified_posts: bigint;
  premium_posts: bigint;
  original_posts: bigint;
  reply_posts: bigint;
  premium_men: bigint;
  verified_men: bigint;
  contributors: bigint;
  original_authors: bigint;
  top_author_posts: bigint;
  top5_posts: bigint;
  median_posts: number | null;
  public_articles: bigint;
  verified_articles: bigint;
  premium_articles: bigint;
  article_authors: bigint;
  article_views: bigint;
  total_views: bigint;
  premium_views: bigint;
  verified_views: bigint;
  unverified_views: bigint;
};

const TOP_POSTS_SCAN_LIMIT = 40;
const TOP_POSTS_POOL_SIZE = 14;
const TOP_POSTS_MAX_PER_AUTHOR = 2;
const TOP_POSTS_MAX_PER_ROOT = 2;

const AVATAR_STRIP_TARGET = 8;

@Injectable()
export class LandingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly appConfig: AppConfigService,
    private readonly articles: ArticlesService,
    private readonly cache: CacheService,
  ) {}

  private get publicBaseUrl(): string | null {
    return this.appConfig.r2()?.publicBaseUrl ?? null;
  }

  async getSnapshot(now = new Date()): Promise<LandingSnapshotDto> {
    // Marketing homepage is CDN-cached for 60s; Redis avoids re-running the heavy
    // PostView tier aggregate on every origin hit within that window.
    return this.cache.getOrSetJson<LandingSnapshotDto>({
      enabled: true,
      key: RedisKeys.landingSnapshot(),
      ttlSeconds: CacheTtl.landingSnapshotSeconds,
      compute: () => this.computeSnapshot(now),
    });
  }

  private async computeSnapshot(now: Date): Promise<LandingSnapshotDto> {
    const sevenDaysAgo = new Date(now.getTime() - 7 * 86400000);
    const windowStart = new Date(now.getTime() - ACTIVITY_WINDOW_DAYS * 86400000);

    const [statsRows, candidateRows, topPostRows, trendingArticles] = await Promise.all([
      this.prisma.$queryRaw<StatsRow[]>(Prisma.sql`
        SELECT posts.public_posts,
               posts.verified_posts,
               posts.premium_posts,
               posts.original_posts,
               posts.reply_posts,
               men.premium_men,
               men.verified_men,
               concentration.contributors,
               concentration.original_authors,
               concentration.top_author_posts,
               concentration.top5_posts,
               concentration.median_posts,
               articles.public_articles,
               articles.verified_articles,
               articles.premium_articles,
               articles.article_authors,
               articles.article_views,
               view_totals.total_views,
               view_tiers.premium_views,
               view_tiers.verified_views,
               view_tiers.unverified_views
        FROM (
          SELECT
            COUNT(*) FILTER (WHERE p."visibility" = 'public')       AS public_posts,
            COUNT(*) FILTER (WHERE p."visibility" = 'verifiedOnly') AS verified_posts,
            COUNT(*) FILTER (WHERE p."visibility" = 'premiumOnly')  AS premium_posts,
            COUNT(*) FILTER (
              WHERE p."parentId" IS NULL
                AND p."visibility" IN ('public', 'verifiedOnly', 'premiumOnly')
            ) AS original_posts,
            COUNT(*) FILTER (
              WHERE p."parentId" IS NOT NULL
                AND p."visibility" IN ('public', 'verifiedOnly', 'premiumOnly')
            ) AS reply_posts
          FROM "Post" p
          JOIN "User" u ON u.id = p."userId"
          WHERE p."deletedAt" IS NULL
            AND p."isDraft" = false
            AND p."kind" = 'regular'
            AND u."bannedAt" IS NULL
            AND u."isOrganization" = false
            AND u."verifiedStatus" != 'none'
        ) posts
        CROSS JOIN (
          SELECT
            COUNT(*) FILTER (WHERE u.premium OR u."premiumPlus")        AS premium_men,
            COUNT(*) FILTER (WHERE NOT (u.premium OR u."premiumPlus"))  AS verified_men
          FROM "User" u
          WHERE u."bannedAt" IS NULL
            AND u."usernameIsSet" = true
            AND u."isOrganization" = false
            AND u."verifiedStatus" != 'none'
        ) men
        CROSS JOIN (
          -- Authorship concentration over landing-eligible content.
          WITH eligible AS (
            SELECT p."userId", p."parentId"
            FROM "Post" p
            JOIN "User" u ON u.id = p."userId"
            WHERE p."deletedAt" IS NULL
              AND p."isDraft" = false
              AND p."kind" = 'regular'
              AND p."visibility" IN ('public', 'verifiedOnly', 'premiumOnly')
              AND u."bannedAt" IS NULL
              AND u."usernameIsSet" = true
              AND u."isOrganization" = false
              AND u."verifiedStatus" != 'none'
          ),
          author_totals AS (
            SELECT
              e."userId",
              COUNT(*)::int AS posts,
              COUNT(*) FILTER (WHERE e."parentId" IS NULL)::int AS roots
            FROM eligible e
            GROUP BY e."userId"
          ),
          ranked AS (
            SELECT posts, ROW_NUMBER() OVER (ORDER BY posts DESC, "userId") AS rn
            FROM author_totals
          )
          SELECT
            (SELECT COUNT(*)::bigint FROM author_totals) AS contributors,
            (SELECT COUNT(*)::bigint FROM author_totals WHERE roots > 0) AS original_authors,
            (SELECT COALESCE(MAX(posts), 0)::bigint FROM ranked WHERE rn = 1) AS top_author_posts,
            (SELECT COALESCE(SUM(posts), 0)::bigint FROM ranked WHERE rn <= 5) AS top5_posts,
            (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY posts) FROM author_totals) AS median_posts
        ) concentration
        CROSS JOIN (
          -- Published articles by landing-eligible authors.
          SELECT
            COUNT(*) FILTER (WHERE a."visibility" = 'public')       AS public_articles,
            COUNT(*) FILTER (WHERE a."visibility" = 'verifiedOnly') AS verified_articles,
            COUNT(*) FILTER (WHERE a."visibility" = 'premiumOnly')  AS premium_articles,
            COUNT(DISTINCT a."authorId")::bigint AS article_authors,
            COALESCE(SUM(a."viewCount"), 0)::bigint AS article_views
          FROM "Article" a
          JOIN "User" u ON u.id = a."authorId"
          WHERE a."deletedAt" IS NULL
            AND a."isDraft" = false
            AND a."publishedAt" IS NOT NULL
            AND a."visibility" IN ('public', 'verifiedOnly', 'premiumOnly')
            AND u."bannedAt" IS NULL
            AND u."usernameIsSet" = true
            AND u."isOrganization" = false
            AND u."verifiedStatus" != 'none'
        ) articles
        CROSS JOIN (
          -- Denormalized unique viewers (person×post), same semantics as Post.viewerCount.
          SELECT COALESCE(SUM(p."viewerCount"), 0)::bigint AS total_views
          FROM "Post" p
          JOIN "User" u ON u.id = p."userId"
          WHERE p."deletedAt" IS NULL
            AND p."isDraft" = false
            AND p."kind" = 'regular'
            AND p."visibility" IN ('public', 'verifiedOnly', 'premiumOnly')
            AND u."bannedAt" IS NULL
            AND u."isOrganization" = false
            AND u."verifiedStatus" != 'none'
        ) view_totals
        CROSS JOIN (
          -- Authenticated unique views by tier (PostView is 1 row per user×post).
          SELECT
            COUNT(*) FILTER (WHERE vu.premium OR vu."premiumPlus") AS premium_views,
            COUNT(*) FILTER (
              WHERE vu."verifiedStatus" != 'none'
                AND NOT (vu.premium OR vu."premiumPlus")
            ) AS verified_views,
            COUNT(*) FILTER (
              WHERE vu."verifiedStatus" = 'none'
                AND NOT (vu.premium OR vu."premiumPlus")
            ) AS unverified_views
          FROM "PostView" pv
          JOIN "Post" p ON p.id = pv."postId"
          JOIN "User" author ON author.id = p."userId"
          JOIN "User" vu ON vu.id = pv."userId"
          WHERE p."deletedAt" IS NULL
            AND p."isDraft" = false
            AND p."kind" = 'regular'
            AND p."visibility" IN ('public', 'verifiedOnly', 'premiumOnly')
            AND author."bannedAt" IS NULL
            AND author."isOrganization" = false
            AND author."verifiedStatus" != 'none'
        ) view_tiers
      `),
      // Pass 1: active in the last 30 days with an avatar.
      this.prisma.$queryRaw<CandidateManRow[]>(Prisma.sql`
        SELECT
          u.id,
          GREATEST(
            COALESCE(u."lastOnlineAt", u."lastSeenAt"),
            COALESCE(u."lastSeenAt",  u."lastOnlineAt")
          ) AS last_active_at,
          COUNT(p.id)::bigint AS recent_post_count
        FROM "User" u
        LEFT JOIN "Post" p ON p."userId" = u.id
          AND p."deletedAt" IS NULL
          AND p."isDraft" = false
          AND p."kind" = 'regular'
          AND p."visibility" != 'onlyMe'
          AND p."createdAt" >= ${windowStart}::timestamptz
        WHERE u."bannedAt" IS NULL
          AND u."usernameIsSet" = true
          AND u."isOrganization" = false
          AND u."isBot" = false
          AND u."verifiedStatus" != 'none'
          AND u."avatarKey" IS NOT NULL
          AND GREATEST(
            COALESCE(u."lastOnlineAt", u."lastSeenAt"),
            COALESCE(u."lastSeenAt",  u."lastOnlineAt")
          ) >= ${windowStart}::timestamptz
        GROUP BY u.id
        ORDER BY last_active_at DESC
        LIMIT 60
      `),
      this.prisma.$queryRaw<TopPostRow[]>(Prisma.sql`
        SELECT
          p.id,
          COALESCE(p."rootId", p.id) AS root_id,
          p."userId" AS author_id,
          (
            COUNT(DISTINCT pv."userId")
            + COUNT(DISTINCT pav."anonId")
          )::bigint AS weekly_views
        FROM "Post" p
        LEFT JOIN "PostView" pv
          ON pv."postId" = p.id
          AND pv."lastSeenAt" >= ${sevenDaysAgo}::timestamptz
        LEFT JOIN "PostAnonView" pav
          ON pav."postId" = p.id
          AND pav."lastViewedAt" >= ${sevenDaysAgo}::timestamptz
        JOIN "User" u ON u.id = p."userId"
        WHERE p."deletedAt" IS NULL
          AND p."isDraft" = false
          AND p."kind" = 'regular'
          AND p."visibility" = 'public'
          AND p."communityGroupId" IS NULL
          AND u."isBot" = false
          AND u."bannedAt" IS NULL
        GROUP BY p.id
        ORDER BY
          (CASE WHEN p."commentCount" > 0 OR p."parentId" IS NOT NULL THEN 1 ELSE 0 END) DESC,
          weekly_views DESC,
          p."viewerCount" DESC,
          p."createdAt" DESC
        LIMIT ${TOP_POSTS_SCAN_LIMIT}
      `),
      this.articles.listTrending({ viewerUserId: null, limit: 3 }),
    ]);

    // ── Score and rank the avatar strip ──────────────────────────────────────
    const scoredIds = this.buildScoredStripIds(candidateRows, now);

    // Top-up pass 2: avatar required, no 30-day window restriction.
    let topUpRows2: CandidateManRow[] = [];
    if (scoredIds.length < AVATAR_STRIP_TARGET) {
      topUpRows2 = await this.prisma.$queryRaw<CandidateManRow[]>(Prisma.sql`
        SELECT
          u.id,
          GREATEST(
            COALESCE(u."lastOnlineAt", u."lastSeenAt"),
            COALESCE(u."lastSeenAt",  u."lastOnlineAt")
          ) AS last_active_at,
          COUNT(p.id)::bigint AS recent_post_count
        FROM "User" u
        LEFT JOIN "Post" p ON p."userId" = u.id
          AND p."deletedAt" IS NULL
          AND p."isDraft" = false
          AND p."kind" = 'regular'
          AND p."visibility" != 'onlyMe'
        WHERE u."bannedAt" IS NULL
          AND u."usernameIsSet" = true
          AND u."isOrganization" = false
          AND u."isBot" = false
          AND u."verifiedStatus" != 'none'
          AND u."avatarKey" IS NOT NULL
          AND u.id != ALL(${scoredIds})
        GROUP BY u.id
        ORDER BY last_active_at DESC NULLS LAST
        LIMIT 60
      `);
    }

    const afterPass2 = this.appendScored(scoredIds, topUpRows2, now);

    // Top-up pass 3: drop avatar requirement entirely.
    let topUpRows3: CandidateManRow[] = [];
    if (afterPass2.length < AVATAR_STRIP_TARGET) {
      topUpRows3 = await this.prisma.$queryRaw<CandidateManRow[]>(Prisma.sql`
        SELECT
          u.id,
          GREATEST(
            COALESCE(u."lastOnlineAt", u."lastSeenAt"),
            COALESCE(u."lastSeenAt",  u."lastOnlineAt")
          ) AS last_active_at,
          COUNT(p.id)::bigint AS recent_post_count
        FROM "User" u
        LEFT JOIN "Post" p ON p."userId" = u.id
          AND p."deletedAt" IS NULL
          AND p."isDraft" = false
          AND p."kind" = 'regular'
          AND p."visibility" != 'onlyMe'
        WHERE u."bannedAt" IS NULL
          AND u."usernameIsSet" = true
          AND u."isOrganization" = false
          AND u."isBot" = false
          AND u."verifiedStatus" != 'none'
          AND u.id != ALL(${afterPass2})
        GROUP BY u.id
        ORDER BY last_active_at DESC NULLS LAST
        LIMIT 60
      `);
    }

    const finalIds = this.appendScored(afterPass2, topUpRows3, now).slice(0, 10);

    // Hydrate DTOs in scored order.
    const recentlyActiveMen: LandingSnapshotDto['recentlyActiveMen'] = [];
    if (finalIds.length > 0) {
      const userRows = await this.prisma.user.findMany({
        where: { id: { in: finalIds } },
        select: USER_LIST_SELECT,
      });
      const byId = new Map(userRows.map((u) => [u.id, u]));
      for (const id of finalIds) {
        const u = byId.get(id);
        if (u) recentlyActiveMen.push(toUserListDto(u as UserListRow, this.publicBaseUrl));
      }
    }

    // ── Top-posts pool ────────────────────────────────────────────────────────
    const poolRows: TopPostRow[] = [];
    const authorCount = new Map<string, number>();
    const rootCount = new Map<string, number>();
    const skipped: TopPostRow[] = [];

    for (const row of topPostRows) {
      if (poolRows.length >= TOP_POSTS_POOL_SIZE) break;
      const ac = authorCount.get(row.author_id) ?? 0;
      const rc = rootCount.get(row.root_id) ?? 0;
      if (ac < TOP_POSTS_MAX_PER_AUTHOR && rc < TOP_POSTS_MAX_PER_ROOT) {
        poolRows.push(row);
        authorCount.set(row.author_id, ac + 1);
        rootCount.set(row.root_id, rc + 1);
      } else {
        skipped.push(row);
      }
    }

    for (const row of skipped) {
      if (poolRows.length >= TOP_POSTS_POOL_SIZE) break;
      const ac = authorCount.get(row.author_id) ?? 0;
      const rc = rootCount.get(row.root_id) ?? 0;
      poolRows.push(row);
      authorCount.set(row.author_id, ac + 1);
      rootCount.set(row.root_id, rc + 1);
    }

    if (poolRows.length === 0) {
      const fallbackPosts = await this.prisma.post.findMany({
        where: {
          deletedAt: null,
          isDraft: false,
          kind: 'regular',
          visibility: 'public',
          communityGroupId: null,
          user: { isBot: false, bannedAt: null },
        },
        orderBy: [{ commentCount: 'desc' }, { viewerCount: 'desc' }, { createdAt: 'desc' }],
        take: TOP_POSTS_SCAN_LIMIT,
        select: { id: true, userId: true, rootId: true, parentId: true },
      });
      for (const p of fallbackPosts) {
        if (poolRows.length >= TOP_POSTS_POOL_SIZE) break;
        const authorId = p.userId;
        const rootId = p.rootId ?? p.id;
        const ac = authorCount.get(authorId) ?? 0;
        const rc = rootCount.get(rootId) ?? 0;
        if (ac < TOP_POSTS_MAX_PER_AUTHOR && rc < TOP_POSTS_MAX_PER_ROOT) {
          poolRows.push({ id: p.id, weekly_views: 0n, author_id: authorId, root_id: rootId });
          authorCount.set(authorId, ac + 1);
          rootCount.set(rootId, rc + 1);
        }
      }
    }

    const topPostIds = poolRows.map((row) => row.id);
    const topPosts = topPostIds.length
      ? await this.prisma.post.findMany({
          where: { id: { in: topPostIds } },
          include: LANDING_POST_INCLUDE,
        })
      : [];
    const topPostsById = new Map(topPosts.map((post) => [post.id, post]));
    const weeklyViewsById = new Map(poolRows.map((row) => [row.id, Number(row.weekly_views)]));

    const stats = statsRows[0];
    const publicPosts = Number(stats?.public_posts ?? 0);
    const verifiedPosts = Number(stats?.verified_posts ?? 0);
    const premiumPosts = Number(stats?.premium_posts ?? 0);
    const originalPosts = Number(stats?.original_posts ?? 0);
    const replyPosts = Number(stats?.reply_posts ?? 0);
    const premiumMen = Number(stats?.premium_men ?? 0);
    const verifiedMen = Number(stats?.verified_men ?? 0);
    const contributors = Number(stats?.contributors ?? 0);
    const originalAuthors = Number(stats?.original_authors ?? 0);
    const topAuthorPosts = Number(stats?.top_author_posts ?? 0);
    const top5Posts = Number(stats?.top5_posts ?? 0);
    const medianPostsRaw = Number(stats?.median_posts ?? 0);
    const publicArticles = Number(stats?.public_articles ?? 0);
    const verifiedArticles = Number(stats?.verified_articles ?? 0);
    const premiumArticles = Number(stats?.premium_articles ?? 0);
    const articleAuthors = Number(stats?.article_authors ?? 0);
    const articleViews = Math.max(0, Math.floor(Number(stats?.article_views ?? 0)));
    const totalViews = Math.max(0, Math.floor(Number(stats?.total_views ?? 0)));
    const premiumViews = Math.max(0, Math.floor(Number(stats?.premium_views ?? 0)));
    const verifiedViews = Math.max(0, Math.floor(Number(stats?.verified_views ?? 0)));
    const unverifiedViews = Math.max(0, Math.floor(Number(stats?.unverified_views ?? 0)));
    const guestViews = Math.max(0, totalViews - (premiumViews + verifiedViews + unverifiedViews));
    const menTotal = premiumMen + verifiedMen;
    const postsTotal = publicPosts + verifiedPosts + premiumPosts;
    const articlesTotal = publicArticles + verifiedArticles + premiumArticles;
    const sharePercent = (part: number) =>
      postsTotal > 0 ? Math.min(100, Math.max(0, Math.round((100 * part) / postsTotal))) : 0;

    return {
      stats: {
        men: {
          premium: premiumMen,
          verified: verifiedMen,
          total: menTotal,
          contributors: Math.min(Math.max(0, contributors), menTotal),
          originalAuthors: Math.min(Math.max(0, originalAuthors), menTotal),
          topAuthorSharePercent: sharePercent(topAuthorPosts),
          top5SharePercent: sharePercent(top5Posts),
          medianPostsPerContributor:
            contributors > 0 ? Math.max(0, Math.round(Number.isFinite(medianPostsRaw) ? medianPostsRaw : 0)) : 0,
        },
        posts: {
          public: publicPosts,
          verified: verifiedPosts,
          premium: premiumPosts,
          original: originalPosts,
          replies: replyPosts,
          total: postsTotal,
        },
        articles: {
          public: publicArticles,
          verified: verifiedArticles,
          premium: premiumArticles,
          total: articlesTotal,
          authors: Math.max(0, articleAuthors),
          views: articleViews,
        },
        views: {
          premium: premiumViews,
          verified: verifiedViews,
          unverified: unverifiedViews,
          guest: guestViews,
          total: totalViews,
        },
      },
      recentlyActiveMen,
      topPostsThisWeek: poolRows
        .map((row) => {
          const post = topPostsById.get(row.id);
          if (!post) return null;
          const dto = toPostDto(post as unknown as PostWithAuthorAndMedia, this.publicBaseUrl, {
            viewerCanAccess: true,
          });
          const parentRaw = (post as { parent?: PostWithAuthorAndMedia | null }).parent;
          if (parentRaw?.user) {
            (dto as { parent?: ReturnType<typeof toPostDto> }).parent = toPostDto(
              parentRaw,
              this.publicBaseUrl,
              { viewerCanAccess: true },
            );
          }
          return { ...dto, weeklyViewCount: weeklyViewsById.get(row.id) ?? 0 };
        })
        .filter((post): post is NonNullable<typeof post> => post != null),
      trendingArticles,
      asOf: now.toISOString(),
    };
  }

  private buildScoredStripIds(rows: CandidateManRow[], now: Date): string[] {
    return rows
      .map((r) => ({
        id: r.id,
        score: scoreActiveMan(
          { lastActiveAt: r.last_active_at, recentPostCount: Number(r.recent_post_count) },
          now,
        ),
        recentPostCount: Number(r.recent_post_count),
      }))
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        if (b.recentPostCount !== a.recentPostCount) return b.recentPostCount - a.recentPostCount;
        return a.id.localeCompare(b.id);
      })
      .map((r) => r.id);
  }

  private appendScored(existing: string[], newRows: CandidateManRow[], now: Date): string[] {
    const existingSet = new Set(existing);
    const additions = this.buildScoredStripIds(newRows, now).filter((id) => !existingSet.has(id));
    return [...existing, ...additions];
  }
}
