import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AppConfigService } from '../app/app-config.service';
import { ArticlesService } from '../articles/articles.service';
import { PrismaService } from '../prisma/prisma.service';
import type { LandingSnapshotDto } from '../../common/dto/landing.dto';
import { toPostDto, toUserListDto, type UserListRow } from '../../common/dto';
import { POST_WITH_POLL_INCLUDE } from '../../common/prisma-includes/post.include';
import { USER_LIST_SELECT } from '../../common/prisma-selects/user.select';

type TopPostRow = {
  id: string;
  weekly_views: bigint;
  root_id: string;
  author_id: string;
};

const TOP_POSTS_SCAN_LIMIT = 40;
const TOP_POSTS_POOL_SIZE = 14;
const TOP_POSTS_MAX_PER_AUTHOR = 2;
const TOP_POSTS_MAX_PER_ROOT = 2;

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

    const [
      statsRows,
      recentlyActiveRows,
      topPostRows,
      trendingArticles,
    ] = await Promise.all([
      this.prisma.$queryRaw<Array<{ public_post_count: bigint; verified_men_count: bigint }>>`
        SELECT
          (SELECT COUNT(*)::bigint
           FROM "Post"
           WHERE "deletedAt" IS NULL
             AND "isDraft" = false
             AND "kind" = 'regular'
             AND "visibility" = 'public') AS public_post_count,
          (SELECT COUNT(*)::bigint
           FROM "User"
           WHERE "bannedAt" IS NULL
             AND "usernameIsSet" = true
             AND "isOrganization" = false
             AND "verifiedStatus" != 'none') AS verified_men_count
      `,
      this.prisma.user.findMany({
        where: {
          bannedAt: null,
          usernameIsSet: true,
          isOrganization: false,
          verifiedStatus: { not: 'none' },
          OR: [
            { lastOnlineAt: { not: null } },
            { lastSeenAt: { not: null } },
          ],
        },
        select: USER_LIST_SELECT,
        orderBy: [
          { lastSeenAt: 'desc' },
          { lastOnlineAt: 'desc' },
          { createdAt: 'desc' },
        ],
        take: 10,
      }),
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
        WHERE p."deletedAt" IS NULL
          AND p."isDraft" = false
          AND p."kind" = 'regular'
          AND p."visibility" = 'public'
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

    // Diversity pass: from the ranked 40 build a pool of up to 14, capped per author
    // and per thread root so one prolific author or one hot thread can't crowd out
    // the variety the client needs to pick 3 distinct users.
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

    // Backfill from skipped entries (relaxed caps) if pool is still small.
    for (const row of skipped) {
      if (poolRows.length >= TOP_POSTS_POOL_SIZE) break;
      const ac = authorCount.get(row.author_id) ?? 0;
      const rc = rootCount.get(row.root_id) ?? 0;
      poolRows.push(row);
      authorCount.set(row.author_id, ac + 1);
      rootCount.set(row.root_id, rc + 1);
    }

    // Last-resort fallback: if the weekly-views query returned nothing (e.g. fresh dev db
    // with no PostView rows), pull the most-engaged public posts of all time so the
    // section is never empty.
    if (poolRows.length === 0) {
      const fallbackPosts = await this.prisma.post.findMany({
        where: { deletedAt: null, isDraft: false, kind: 'regular', visibility: 'public' },
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
          include: POST_WITH_POLL_INCLUDE,
        })
      : [];
    const topPostsById = new Map(topPosts.map((post) => [post.id, post]));
    const weeklyViewsById = new Map(poolRows.map((row) => [row.id, Number(row.weekly_views)]));
    const stats = statsRows[0];

    return {
      stats: {
        publicPostCount: Number(stats?.public_post_count ?? 0),
        verifiedMenCount: Number(stats?.verified_men_count ?? 0),
      },
      recentlyActiveMen: recentlyActiveRows.map((user) => toUserListDto(user as UserListRow, this.publicBaseUrl)),
      topPostsThisWeek: poolRows
        .map((row) => {
          const post = topPostsById.get(row.id);
          if (!post) return null;
          return {
            ...toPostDto(post, this.publicBaseUrl, { viewerCanAccess: true }),
            weeklyViewCount: weeklyViewsById.get(row.id) ?? 0,
          };
        })
        .filter((post): post is NonNullable<typeof post> => post != null),
      trendingArticles,
      asOf: now.toISOString(),
    };
  }
}
