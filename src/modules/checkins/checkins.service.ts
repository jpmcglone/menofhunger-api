import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { PostVisibility } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PostsService } from '../posts/posts.service';
import { UsersMeRealtimeService } from '../users/users-me-realtime.service';
import { ViewerContextService } from '../viewer/viewer-context.service';
import { CHECKIN_PROMPTS } from './checkin-prompts';
import { dayIndexEastern, easternDayKey } from '../../common/time/eastern-day-key';
import { PosthogService } from '../../common/posthog/posthog.service';
import { publicAssetUrl } from '../../common/assets/public-asset-url';

function pickCheckinPrompt(now: Date): { dayKey: string; prompt: string } {
  const list = CHECKIN_PROMPTS.filter(Boolean);
  const fallback = "How are you doing today?";
  const dayKey = easternDayKey(now);
  if (list.length === 0) return { dayKey, prompt: fallback };

  // Deterministic rotation by ET day index.
  const dayIndex = dayIndexEastern(now) + 1;
  const i = ((dayIndex % list.length) + list.length) % list.length;
  return { dayKey, prompt: list[i] ?? fallback };
}

@Injectable()
export class CheckinsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly posts: PostsService,
    private readonly usersMeRealtime: UsersMeRealtimeService,
    private readonly viewerContext: ViewerContextService,
    private readonly posthog: PosthogService,
  ) {}

  async getTodayState(params: { userId: string; now?: Date }) {
    const now = params.now ?? new Date();
    const { dayKey, prompt } = pickCheckinPrompt(now);

    const user = await this.prisma.user.findUnique({
      where: { id: params.userId },
      select: {
        id: true,
        coins: true,
        checkinStreakDays: true,
        verifiedStatus: true,
        premium: true,
        premiumPlus: true,
      },
    });
    if (!user) throw new NotFoundException('User not found.');

    const hasCheckedInToday = Boolean(
      await this.prisma.post.findFirst({
        where: { userId: params.userId, kind: 'checkin', checkinDayKey: dayKey, deletedAt: null },
        select: { id: true },
      }),
    );

    // Recommend visibilities the user can actually create.
    const allowedForCreation = this.viewerContext.allowedPostVisibilities(user);

    const allowedCheckinVisibilities = (['verifiedOnly', 'premiumOnly'] as const).filter((v) => allowedForCreation.includes(v));

    this.posthog.capture(params.userId, 'checkin_prompt_viewed', { prompt_key: dayKey });

    return {
      dayKey,
      prompt,
      hasCheckedInToday,
      coins: user.coins ?? 0,
      checkinStreakDays: user.checkinStreakDays ?? 0,
      allowedVisibilities: allowedCheckinVisibilities,
    };
  }

  async createTodayCheckin(params: { userId: string; body: string; visibility: PostVisibility; now?: Date }) {
    const now = params.now ?? new Date();
    const { dayKey, prompt } = pickCheckinPrompt(now);

    if (params.visibility !== 'verifiedOnly' && params.visibility !== 'premiumOnly') {
      throw new BadRequestException('Check-ins must be verified-only or premium-only.');
    }

    const before = await this.prisma.user.findUnique({
      where: { id: params.userId },
      select: { coins: true, checkinStreakDays: true, lastCheckinDayKey: true },
    });
    if (!before) throw new NotFoundException('User not found.');

    // Note: reward + one-per-day enforcement is handled inside PostsService.createPost when kind=checkin.
    const { post } = await this.posts.createPost({
      userId: params.userId,
      body: params.body,
      visibility: params.visibility,
      parentId: null,
      mentions: null,
      media: null,
      poll: null,
      kind: 'checkin',
      checkinDayKey: dayKey,
      checkinPrompt: prompt,
    });

    const after = await this.prisma.user.findUnique({
      where: { id: params.userId },
      select: { coins: true, checkinStreakDays: true, lastCheckinDayKey: true },
    });
    if (!after) throw new NotFoundException('User not found.');
    const coinsAwarded = Math.max(0, (after.coins ?? 0) - (before.coins ?? 0));
    const bonusCoinsAwarded = Math.max(0, coinsAwarded - 1);

    // Keep self state in sync across tabs (coins/streak + completion).
    void this.usersMeRealtime.emitMeUpdated(params.userId, 'checkin_completed');

    return {
      post,
      checkin: { dayKey, prompt },
      coinsAwarded,
      bonusCoinsAwarded,
      checkinStreakDays: after.checkinStreakDays ?? 0,
    };
  }

  async getLeaderboard(params: { publicBaseUrl: string | null; limit?: number; viewerUserId?: string | null }) {
    const take = Math.min(Math.max(1, params.limit ?? 25), 50);
    const userSelect = {
      id: true,
      username: true,
      name: true,
      premium: true,
      premiumPlus: true,
      isOrganization: true,
      stewardBadgeEnabled: true,
      verifiedStatus: true,
      avatarKey: true,
      avatarUpdatedAt: true,
      checkinStreakDays: true,
      longestStreakDays: true,
      createdAt: true,
    } as const;

    const topUsers = await this.prisma.user.findMany({
      where: {
        bannedAt: null,
        // Include members with either an active streak OR historical streak record.
        // This keeps the leaderboard useful even on days where few/no users are currently streaking.
        OR: [{ checkinStreakDays: { gt: 0 } }, { longestStreakDays: { gt: 0 } }],
      },
      // Active streak ranks first, then best-ever streak for tie-break/fallback, then older account first.
      orderBy: [{ checkinStreakDays: 'desc' }, { longestStreakDays: 'desc' }, { createdAt: 'asc' }],
      take,
      select: userSelect,
    });

    const toDto = (u: typeof topUsers[number]) => ({
      id: u.id,
      username: u.username,
      name: u.name,
      premium: u.premium,
      premiumPlus: u.premiumPlus,
      isOrganization: Boolean(u.isOrganization),
      stewardBadgeEnabled: Boolean(u.stewardBadgeEnabled),
      verifiedStatus: u.verifiedStatus as string,
      avatarUrl: publicAssetUrl({
        publicBaseUrl: params.publicBaseUrl,
        key: u.avatarKey ?? null,
        updatedAt: u.avatarUpdatedAt ?? null,
      }),
      checkinStreakDays: u.checkinStreakDays ?? 0,
      longestStreakDays: Math.max(u.longestStreakDays ?? 0, u.checkinStreakDays ?? 0),
    });

    const users = topUsers.map(toDto);

    // If a viewer is authenticated and not already in the top-N list, find their rank.
    let viewerRank: { rank: number; user: ReturnType<typeof toDto> } | null = null;
    if (params.viewerUserId && !users.some((u) => u.id === params.viewerUserId)) {
      // Count how many users rank higher than the viewer.
      const viewerRow = await this.prisma.user.findUnique({
        where: { id: params.viewerUserId },
        select: userSelect,
      });
      if (viewerRow) {
        const aheadCount = await this.prisma.user.count({
          where: {
            bannedAt: null,
            OR: [{ checkinStreakDays: { gt: 0 } }, { longestStreakDays: { gt: 0 } }],
            AND: [
              {
                OR: [
                  { checkinStreakDays: { gt: viewerRow.checkinStreakDays ?? 0 } },
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
    }

    return { users, viewerRank };
  }

  /**
   * Weekly leaderboard: ranks by distinct posting days in the current Mon-Sun ET week.
   * Returns up to `take` users, plus the viewer's own rank if they are not in the top-N.
   */
  async getWeeklyLeaderboard(params: { publicBaseUrl: string | null; limit?: number; viewerUserId?: string | null }) {
    const take = Math.min(Math.max(1, params.limit ?? 25), 50);

    // Compute the UTC boundaries for the current Mon-Sun ET week.
    const now = new Date();
    const ET_ZONE = 'America/New_York';
    const etDateStr = new Intl.DateTimeFormat('en-CA', {
      timeZone: ET_ZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(now);
    const [etYear, etMonth, etDay] = etDateStr.split('-').map(Number) as [number, number, number];
    // JS getDay(): 0=Sun, 1=Mon ... 6=Sat. ET Monday of current week.
    const etDate = new Date(Date.UTC(etYear, etMonth - 1, etDay, 12, 0, 0)); // noon UTC ~ ET day
    const dayOfWeek = (new Date(`${etDateStr}T12:00:00Z`)).getUTCDay(); // 0=Sun..6=Sat
    const daysFromMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
    const mondayUtcNoon = new Date(etDate.getTime() - daysFromMonday * 86400000);
    // Midnight ET Monday = mondayUtcNoon minus 12h, then adjusted for ET offset.
    // Simpler: use midnight UTC of that day since we use AT TIME ZONE in the query.
    const weekStart = new Date(Date.UTC(
      mondayUtcNoon.getUTCFullYear(),
      mondayUtcNoon.getUTCMonth(),
      mondayUtcNoon.getUTCDate(),
      0, 0, 0,
    ));

    // Count distinct ET posting days per user in the current ET week using a raw query.
    // AT TIME ZONE on the createdAt converts to ET; date_trunc extracts the ET calendar day.
    const rows = await this.prisma.$queryRaw<Array<{ userId: string; daysPosted: bigint }>>`
      SELECT
        p."userId",
        COUNT(DISTINCT date_trunc('day', p."createdAt" AT TIME ZONE 'America/New_York')) AS "daysPosted"
      FROM "Post" p
      WHERE
        p."deletedAt" IS NULL
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
      where: { id: { in: userIds }, bannedAt: null },
      select: {
        id: true,
        username: true,
        name: true,
        premium: true,
        premiumPlus: true,
        isOrganization: true,
        stewardBadgeEnabled: true,
        verifiedStatus: true,
        avatarKey: true,
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
      .slice(0, take) as Array<(typeof userRows)[number] & { daysThisWeek: number }>;

    const toWeeklyDto = (u: typeof rankedList[number]) => ({
      id: u.id,
      username: u.username,
      name: u.name,
      premium: u.premium,
      premiumPlus: u.premiumPlus,
      isOrganization: Boolean(u.isOrganization),
      stewardBadgeEnabled: Boolean(u.stewardBadgeEnabled),
      verifiedStatus: u.verifiedStatus as string,
      avatarUrl: publicAssetUrl({
        publicBaseUrl: params.publicBaseUrl,
        key: u.avatarKey ?? null,
        updatedAt: u.avatarUpdatedAt ?? null,
      }),
      checkinStreakDays: u.checkinStreakDays ?? 0,
      longestStreakDays: Math.max(u.longestStreakDays ?? 0, u.checkinStreakDays ?? 0),
      daysThisWeek: u.daysThisWeek,
    });

    const users = rankedList.map(toWeeklyDto);

    // Viewer rank (if not in top-N).
    let viewerRank: { rank: number; user: ReturnType<typeof toWeeklyDto> } | null = null;
    if (params.viewerUserId && !users.some((u) => u.id === params.viewerUserId)) {
      const viewerRow = await this.prisma.user.findUnique({
        where: { id: params.viewerUserId },
        select: {
          id: true,
          username: true,
          name: true,
          premium: true,
          premiumPlus: true,
          isOrganization: true,
          stewardBadgeEnabled: true,
          verifiedStatus: true,
          avatarKey: true,
          avatarUpdatedAt: true,
          checkinStreakDays: true,
          longestStreakDays: true,
          createdAt: true,
        },
      });
      if (viewerRow) {
        const viewerDaysRow = rows.find((r) => r.userId === params.viewerUserId);
        const viewerDays = viewerDaysRow ? Number(viewerDaysRow.daysPosted) : 0;
        const aheadCount = rows.filter((r) => Number(r.daysPosted) > viewerDays).length;
        viewerRank = {
          rank: aheadCount + 1,
          user: toWeeklyDto({ ...viewerRow, daysThisWeek: viewerDays }),
        };
      }
    }

    return { users, viewerRank, weekStart };
  }
}

