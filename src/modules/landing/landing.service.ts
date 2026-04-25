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
};

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
          AND p."createdAt" >= ${sevenDaysAgo}::timestamptz
        GROUP BY p.id
        ORDER BY weekly_views DESC, p."viewerCount" DESC, p."createdAt" DESC
        LIMIT 3
      `),
      this.articles.listTrending({ viewerUserId: null, limit: 3 }),
    ]);

    const topPostIds = topPostRows.map((row) => row.id);
    const topPosts = topPostIds.length
      ? await this.prisma.post.findMany({
          where: { id: { in: topPostIds } },
          include: POST_WITH_POLL_INCLUDE,
        })
      : [];
    const topPostsById = new Map(topPosts.map((post) => [post.id, post]));
    const weeklyViewsById = new Map(topPostRows.map((row) => [row.id, Number(row.weekly_views)]));
    const stats = statsRows[0];

    return {
      stats: {
        publicPostCount: Number(stats?.public_post_count ?? 0),
        verifiedMenCount: Number(stats?.verified_men_count ?? 0),
      },
      recentlyActiveMen: recentlyActiveRows.map((user) => toUserListDto(user as UserListRow, this.publicBaseUrl)),
      topPostsThisWeek: topPostIds
        .map((id) => {
          const post = topPostsById.get(id);
          if (!post) return null;
          return {
            ...toPostDto(post, this.publicBaseUrl, { viewerCanAccess: true }),
            weeklyViewCount: weeklyViewsById.get(id) ?? 0,
          };
        })
        .filter((post): post is NonNullable<typeof post> => post != null),
      trendingArticles,
      asOf: now.toISOString(),
    };
  }
}
