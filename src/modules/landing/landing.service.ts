import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AppConfigService } from '../app/app-config.service';
import { ArticlesService } from '../articles/articles.service';
import { PrismaService } from '../prisma/prisma.service';
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
  premium_men: bigint;
  verified_men: bigint;
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
  ) {}

  private get publicBaseUrl(): string | null {
    return this.appConfig.r2()?.publicBaseUrl ?? null;
  }

  async getSnapshot(now = new Date()): Promise<LandingSnapshotDto> {
    const sevenDaysAgo = new Date(now.getTime() - 7 * 86400000);
    const windowStart = new Date(now.getTime() - ACTIVITY_WINDOW_DAYS * 86400000);

    const [statsRows, candidateRows, topPostRows, trendingArticles] = await Promise.all([
      this.prisma.$queryRaw<StatsRow[]>(Prisma.sql`
        SELECT posts.public_posts,
               posts.verified_posts,
               posts.premium_posts,
               men.premium_men,
               men.verified_men
        FROM (
          SELECT
            COUNT(*) FILTER (WHERE p."visibility" = 'public')       AS public_posts,
            COUNT(*) FILTER (WHERE p."visibility" = 'verifiedOnly') AS verified_posts,
            COUNT(*) FILTER (WHERE p."visibility" = 'premiumOnly')  AS premium_posts
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
    const premiumMen = Number(stats?.premium_men ?? 0);
    const verifiedMen = Number(stats?.verified_men ?? 0);

    return {
      stats: {
        men: {
          premium: premiumMen,
          verified: verifiedMen,
          total: premiumMen + verifiedMen,
        },
        posts: {
          public: publicPosts,
          verified: verifiedPosts,
          premium: premiumPosts,
          total: publicPosts + verifiedPosts + premiumPosts,
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
