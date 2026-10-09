import { PUBLISHED_POST_SQL } from "../../common/sql/post-eligibility.sql";
import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { RedisService } from "../redis/redis.service";
import { NOT_BANNED_USER_WHERE } from "../../common/prisma-selects/user.where";
import { USER_BRIEF_SELECT } from "../../common/prisma-selects/user.select";
import { toAvatarVideoDto } from "../../common/dto/avatar-video.dto";
import type { AvatarVideoDto } from "../../common/dto/avatar-video.dto";
import { RedisKeys } from "../redis/redis-keys";
import { publicAssetUrl } from "../../common/assets/public-asset-url";

export const WEEKLY_LEADERBOARD_CACHE_TTL_SECONDS = 120;

export const LEADERBOARD_CACHE_TTL_SECONDS = 60;

export type LeaderboardUser = {
  id: string;
  username: string | null;
  name: string | null;
  premium: boolean;
  premiumPlus: boolean;
  isOrganization: boolean;
  verifiedStatus: string;
  avatarUrl: string | null;
  avatarVideo?: AvatarVideoDto | null;
  checkinStreakDays: number;
  longestStreakDays: number;
};

export type WeeklyLeaderboardUser = LeaderboardUser & { daysThisWeek: number };

export type LeaderboardUserRow = {
  id: string;
  username: string | null;
  name: string | null;
  premium: boolean;
  premiumPlus: boolean;
  isOrganization: boolean;
  verifiedStatus: string;
  avatarKey: string | null;
  avatarVideoKey?: string | null;
  avatarVideoDurationMs?: number | null;
  avatarUpdatedAt: Date | null;
  checkinStreakDays: number | null;
  longestStreakDays: number | null;
};

const LEADERBOARD_USER_SELECT = {
  id: true,
  username: true,
  name: true,
  premium: true,
  premiumPlus: true,
  isOrganization: true,
  verifiedStatus: true,
  avatarKey: true,
  avatarVideoKey: true,
  avatarVideoDurationMs: true,
  avatarUpdatedAt: true,
  checkinStreakDays: true,
  longestStreakDays: true,
  createdAt: true,
} as const;

function toLeaderboardUser(
  u: LeaderboardUserRow,
  publicBaseUrl: string | null,
): LeaderboardUser {
  return {
    id: u.id,
    username: u.username,
    name: u.name,
    premium: u.premium,
    premiumPlus: u.premiumPlus,
    isOrganization: Boolean(u.isOrganization),
    verifiedStatus: u.verifiedStatus as string,
    avatarUrl: publicAssetUrl({
      publicBaseUrl,
      key: u.avatarKey ?? null,
      updatedAt: u.avatarUpdatedAt ?? null,
    }),
    avatarVideo: toAvatarVideoDto(u, publicBaseUrl),
    checkinStreakDays: u.checkinStreakDays ?? 0,
    longestStreakDays: Math.max(
      u.longestStreakDays ?? 0,
      u.checkinStreakDays ?? 0,
    ),
  };
}

@Injectable()
export class CheckinLeaderboardsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  async getLeaderboard(params: {
    publicBaseUrl: string | null;
    limit?: number;
    viewerUserId?: string | null;
  }) {
    const take = Math.min(Math.max(1, params.limit ?? 25), 50);
    const cacheKey = RedisKeys.checkinLeaderboard(take);

    // Try to serve the top-N list from cache. Viewer rank is always computed fresh
    // since it depends on the calling user and is only needed for out-of-top-N viewers.
    let cachedUsers: LeaderboardUser[] | null = null;
    try {
      cachedUsers = await this.redis.getJson<LeaderboardUser[]>(cacheKey);
    } catch {
      /* Redis unavailable */
    }

    const toDto = (u: LeaderboardUserRow) =>
      toLeaderboardUser(u, params.publicBaseUrl);

    let users: LeaderboardUser[];
    if (cachedUsers) {
      users = cachedUsers;
    } else {
      const topUsers = await this.prisma.user.findMany({
        where: {
          ...NOT_BANNED_USER_WHERE,
          // Include members with either an active streak OR historical streak record.
          // This keeps the leaderboard useful even on days where few/no users are currently streaking.
          OR: [
            { checkinStreakDays: { gt: 0 } },
            { longestStreakDays: { gt: 0 } },
          ],
        },
        // Active streak ranks first, then best-ever streak for tie-break/fallback, then older account first.
        orderBy: [
          { checkinStreakDays: "desc" },
          { longestStreakDays: "desc" },
          { createdAt: "asc" },
        ],
        take,
        select: LEADERBOARD_USER_SELECT,
      });

      users = topUsers.map(toDto);
      void this.redis
        .setJson(cacheKey, users, { ttlSeconds: LEADERBOARD_CACHE_TTL_SECONDS })
        .catch(() => undefined);
    }

    // If a viewer is authenticated and not already in the top-N list, find their rank.
    // The count query for ranking can be expensive, so cache it per viewer for the same
    // TTL as the top list.
    let viewerRank: { rank: number; user: LeaderboardUser } | null = null;
    if (
      params.viewerUserId &&
      !users.some((u) => u.id === params.viewerUserId)
    ) {
      const rankCacheKey = RedisKeys.checkinLeaderboardViewerRank(
        params.viewerUserId,
        take,
      );
      try {
        const cached = await this.redis.getJson<{
          v: { rank: number; user: LeaderboardUser } | null;
        }>(rankCacheKey);
        if (cached) {
          viewerRank = cached.v;
          return { users, viewerRank };
        }
      } catch {
        /* Redis unavailable */
      }

      const viewerRow = await this.prisma.user.findUnique({
        where: { id: params.viewerUserId },
        select: LEADERBOARD_USER_SELECT,
      });
      if (viewerRow) {
        const aheadCount = await this.prisma.user.count({
          where: {
            ...NOT_BANNED_USER_WHERE,
            OR: [
              { checkinStreakDays: { gt: 0 } },
              { longestStreakDays: { gt: 0 } },
            ],
            AND: [
              {
                OR: [
                  {
                    checkinStreakDays: { gt: viewerRow.checkinStreakDays ?? 0 },
                  },
                  {
                    checkinStreakDays: viewerRow.checkinStreakDays ?? 0,
                    longestStreakDays: { gt: viewerRow.longestStreakDays ?? 0 },
                  },
                  {
                    checkinStreakDays: viewerRow.checkinStreakDays ?? 0,
                    longestStreakDays: viewerRow.longestStreakDays ?? 0,
                    createdAt: { lt: viewerRow.createdAt ?? new Date() },
                  },
                ],
              },
            ],
          },
        });
        viewerRank = { rank: aheadCount + 1, user: toDto(viewerRow) };
      }
      void this.redis
        .setJson(
          rankCacheKey,
          { v: viewerRank },
          { ttlSeconds: LEADERBOARD_CACHE_TTL_SECONDS },
        )
        .catch(() => undefined);
    }

    return { users, viewerRank };
  }

  async getBestStreakLeaderboard(params: {
    publicBaseUrl: string | null;
    limit?: number;
    viewerUserId?: string | null;
  }) {
    const take = Math.min(Math.max(1, params.limit ?? 25), 50);
    const cacheKey = RedisKeys.checkinBestStreakLeaderboard(take);

    let cachedUsers: LeaderboardUser[] | null = null;
    try {
      cachedUsers = await this.redis.getJson<LeaderboardUser[]>(cacheKey);
    } catch {
      /* Redis unavailable */
    }

    const toDto = (u: LeaderboardUserRow) =>
      toLeaderboardUser(u, params.publicBaseUrl);

    let users: LeaderboardUser[];
    if (cachedUsers) {
      users = cachedUsers;
    } else {
      const topUsers = await this.prisma.user.findMany({
        where: {
          ...NOT_BANNED_USER_WHERE,
          OR: [
            { checkinStreakDays: { gt: 0 } },
            { longestStreakDays: { gt: 0 } },
          ],
        },
        orderBy: [
          { longestStreakDays: "desc" },
          { checkinStreakDays: "desc" },
          { createdAt: "asc" },
        ],
        take,
        select: LEADERBOARD_USER_SELECT,
      });

      users = topUsers.map(toDto);
      void this.redis
        .setJson(cacheKey, users, { ttlSeconds: LEADERBOARD_CACHE_TTL_SECONDS })
        .catch(() => undefined);
    }

    let viewerRank: { rank: number; user: LeaderboardUser } | null = null;
    if (
      params.viewerUserId &&
      !users.some((u) => u.id === params.viewerUserId)
    ) {
      const rankCacheKey = RedisKeys.checkinLeaderboardViewerRank(
        params.viewerUserId,
        take,
        "best",
      );
      try {
        const cached = await this.redis.getJson<{
          v: { rank: number; user: LeaderboardUser } | null;
        }>(rankCacheKey);
        if (cached) {
          viewerRank = cached.v;
          return { users, viewerRank };
        }
      } catch {
        /* Redis unavailable */
      }

      const viewerRow = await this.prisma.user.findUnique({
        where: { id: params.viewerUserId },
        select: LEADERBOARD_USER_SELECT,
      });
      if (viewerRow) {
        const effectiveLongest = Math.max(
          viewerRow.longestStreakDays ?? 0,
          viewerRow.checkinStreakDays ?? 0,
        );
        const aheadCount = await this.prisma.user.count({
          where: {
            ...NOT_BANNED_USER_WHERE,
            OR: [
              { checkinStreakDays: { gt: 0 } },
              { longestStreakDays: { gt: 0 } },
            ],
            AND: [
              {
                OR: [
                  { longestStreakDays: { gt: effectiveLongest } },
                  {
                    longestStreakDays: effectiveLongest,
                    checkinStreakDays: { gt: viewerRow.checkinStreakDays ?? 0 },
                  },
                  {
                    longestStreakDays: effectiveLongest,
                    checkinStreakDays: viewerRow.checkinStreakDays ?? 0,
                    createdAt: { lt: viewerRow.createdAt ?? new Date() },
                  },
                ],
              },
            ],
          },
        });
        viewerRank = { rank: aheadCount + 1, user: toDto(viewerRow) };
      }
      void this.redis
        .setJson(
          rankCacheKey,
          { v: viewerRank },
          { ttlSeconds: LEADERBOARD_CACHE_TTL_SECONDS },
        )
        .catch(() => undefined);
    }

    return { users, viewerRank };
  }

  async getWeeklyLeaderboard(params: {
    publicBaseUrl: string | null;
    limit?: number;
    viewerUserId?: string | null;
  }) {
    const take = Math.min(Math.max(1, params.limit ?? 25), 50);

    // Compute the UTC boundaries for the current Mon-Sun ET week.
    const now = new Date();
    const ET_ZONE = "America/New_York";
    const etDateStr = new Intl.DateTimeFormat("en-CA", {
      timeZone: ET_ZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(now);
    const [etYear, etMonth, etDay] = etDateStr.split("-").map(Number) as [
      number,
      number,
      number,
    ];
    // JS getDay(): 0=Sun, 1=Mon ... 6=Sat. ET Monday of current week.
    const etDate = new Date(Date.UTC(etYear, etMonth - 1, etDay, 12, 0, 0)); // noon UTC ~ ET day
    const dayOfWeek = new Date(`${etDateStr}T12:00:00Z`).getUTCDay(); // 0=Sun..6=Sat
    const daysFromMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
    const mondayUtcNoon = new Date(
      etDate.getTime() - daysFromMonday * 86400000,
    );
    // Midnight ET Monday = mondayUtcNoon minus 12h, then adjusted for ET offset.
    // Simpler: use midnight UTC of that day since we use AT TIME ZONE in the query.
    const weekStart = new Date(
      Date.UTC(
        mondayUtcNoon.getUTCFullYear(),
        mondayUtcNoon.getUTCMonth(),
        mondayUtcNoon.getUTCDate(),
        0,
        0,
        0,
      ),
    );

    const weeklyCacheKey = RedisKeys.checkinWeeklyLeaderboard(
      take,
      weekStart.toISOString(),
    );

    const cachedWeekly = await this.redis
      .getJson<{
        users: WeeklyLeaderboardUser[];
        viewerRankForId: Record<
          string,
          { rank: number; user: WeeklyLeaderboardUser } | null
        >;
      }>(weeklyCacheKey)
      .catch(() => null);

    if (cachedWeekly) {
      const viewerRank = params.viewerUserId
        ? (cachedWeekly.viewerRankForId[params.viewerUserId] ?? null)
        : null;
      return { users: cachedWeekly.users, viewerRank, weekStart };
    }

    // Count distinct ET posting days per user in the current ET week using a raw query.
    // AT TIME ZONE on the createdAt converts to ET; date_trunc extracts the ET calendar day.
    const rows = await this.prisma.$queryRaw<
      Array<{ userId: string; daysPosted: bigint }>
    >`
    SELECT
      p."userId",
      COUNT(DISTINCT date_trunc('day', p."createdAt" AT TIME ZONE 'America/New_York')) AS "daysPosted"
    FROM "Post" p
    WHERE
      ${PUBLISHED_POST_SQL}
      AND p."visibility" != 'onlyMe'
      AND p."createdAt" >= ${weekStart}
    GROUP BY p."userId"
    ORDER BY "daysPosted" DESC, MIN(p."createdAt") ASC
    LIMIT ${take * 4}
  `;

    if (rows.length === 0) {
      return { users: [], viewerRank: null, weekStart };
    }

    // Fetch user details for the ranked users.
    const userIds = rows.map((r) => r.userId);
    const userRows = await this.prisma.user.findMany({
      where: { id: { in: userIds }, ...NOT_BANNED_USER_WHERE },
      select: {
        ...USER_BRIEF_SELECT,
        premium: true,
        premiumPlus: true,
        isOrganization: true,
        verifiedStatus: true,
        avatarKey: true,
        avatarVideoKey: true,
        avatarVideoDurationMs: true,
        avatarUpdatedAt: true,
        checkinStreakDays: true,
        longestStreakDays: true,
        createdAt: true,
      },
    });

    const userMap = new Map(userRows.map((u) => [u.id, u]));
    const rankedList = rows
      .map((r) => {
        const u = userMap.get(r.userId);
        if (!u) return null;
        return {
          ...u,
          daysThisWeek: Number(r.daysPosted),
        };
      })
      .filter(Boolean)
      .slice(0, take) as Array<
      (typeof userRows)[number] & { daysThisWeek: number }
    >;

    const toWeeklyDto = (u: (typeof rankedList)[number]) => ({
      ...toLeaderboardUser(u, params.publicBaseUrl),
      daysThisWeek: u.daysThisWeek,
    });

    const users = rankedList.map(toWeeklyDto);

    // Viewer rank (if not in top-N).
    let viewerRank: { rank: number; user: WeeklyLeaderboardUser } | null = null;
    if (
      params.viewerUserId &&
      !users.some((u) => u.id === params.viewerUserId)
    ) {
      const viewerRow = await this.prisma.user.findUnique({
        where: { id: params.viewerUserId },
        select: {
          ...USER_BRIEF_SELECT,
          premium: true,
          premiumPlus: true,
          isOrganization: true,
          verifiedStatus: true,
          avatarKey: true,
          avatarVideoKey: true,
          avatarVideoDurationMs: true,
          avatarUpdatedAt: true,
          checkinStreakDays: true,
          longestStreakDays: true,
          createdAt: true,
        },
      });
      if (viewerRow) {
        const viewerDaysRow = rows.find(
          (r) => r.userId === params.viewerUserId,
        );
        const viewerDays = viewerDaysRow ? Number(viewerDaysRow.daysPosted) : 0;
        const aheadCount = rows.filter(
          (r) => Number(r.daysPosted) > viewerDays,
        ).length;
        viewerRank = {
          rank: aheadCount + 1,
          user: toWeeklyDto({ ...viewerRow, daysThisWeek: viewerDays }),
        };
      }
    }

    // Cache the result including the viewer rank so repeat calls for the same viewer are fast.
    void this.redis
      .setJson(
        weeklyCacheKey,
        {
          users,
          viewerRankForId: params.viewerUserId
            ? { [params.viewerUserId]: viewerRank }
            : {},
        },
        { ttlSeconds: WEEKLY_LEADERBOARD_CACHE_TTL_SECONDS },
      )
      .catch(() => undefined);

    return { users, viewerRank, weekStart };
  }
}
