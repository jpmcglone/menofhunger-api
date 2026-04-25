import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { PostVisibility } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PostsService } from '../posts/posts.service';
import { UsersMeRealtimeService } from '../users/users-me-realtime.service';
import { ViewerContextService } from '../viewer/viewer-context.service';
import { RedisService } from '../redis/redis.service';
import { RedisKeys } from '../redis/redis-keys';
import { CHECKIN_PROMPTS } from './checkin-prompts';
import { dayIndexEastern, easternDayKey, yesterdayEasternDayKey } from '../../common/time/eastern-day-key';
import { PosthogService } from '../../common/posthog/posthog.service';
import { publicAssetUrl } from '../../common/assets/public-asset-url';
import { PresenceRealtimeService } from '../presence/presence-realtime.service';
import { NotificationsService } from '../notifications/notifications.service';

const LEADERBOARD_CACHE_TTL_SECONDS = 60;
const WEEKLY_LEADERBOARD_CACHE_TTL_SECONDS = 120;
const TODAY_STATE_CACHE_TTL_SECONDS = 120;

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
    private readonly redis: RedisService,
    private readonly posthog: PosthogService,
    private readonly presenceRealtime: PresenceRealtimeService,
    private readonly notifications: NotificationsService,
  ) {}

  async getTodayState(params: { userId: string; publicBaseUrl?: string | null; now?: Date }) {
    const now = params.now ?? new Date();
    const { dayKey, prompt } = pickCheckinPrompt(now);
    const publicBaseUrl = params.publicBaseUrl ?? null;

    const cacheKey = RedisKeys.checkinTodayState(params.userId, dayKey);
    try {
      const cached = await this.redis.getJson<Awaited<ReturnType<typeof this._getTodayStateRaw>>>(cacheKey);
      if (cached) return cached;
    } catch {
      // Redis unavailable — fall through to DB.
    }

    const result = await this._getTodayStateRaw(params.userId, now, dayKey, prompt, publicBaseUrl);
    void this.redis.setJson(cacheKey, result, { ttlSeconds: TODAY_STATE_CACHE_TTL_SECONDS }).catch(() => undefined);
    return result;
  }

  private async _getTodayStateRaw(
    userId: string,
    now: Date,
    dayKey: string,
    prompt: string,
    publicBaseUrl: string | null,
  ) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
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
        where: { userId, kind: 'checkin', checkinDayKey: dayKey, deletedAt: null },
        select: { id: true },
      }),
    );

    // Recommend visibilities the user can actually create.
    const allowedForCreation = this.viewerContext.allowedPostVisibilities(user);

    const allowedCheckinVisibilities = (['verifiedOnly', 'premiumOnly'] as const).filter((v) => allowedForCreation.includes(v));

    this.posthog.capture(userId, 'checkin_prompt_viewed', { prompt_key: dayKey });

    const crew = await this.buildCrewBlock({ userId, dayKey, publicBaseUrl });

    const socialProof = await this.getTodayAnswered({
      viewerUserId: userId,
      publicBaseUrl,
      now,
    });

    return {
      dayKey,
      prompt,
      hasCheckedInToday,
      coins: user.coins ?? 0,
      checkinStreakDays: user.checkinStreakDays ?? 0,
      allowedVisibilities: allowedCheckinVisibilities,
      crew,
      socialProof,
    };
  }

  /**
   * Crew block returned alongside `GET /checkins/today` when the viewer is in a
   * crew. Tells the UI to reframe the hero ("Your crew's question today") and
   * renders the 5-member status row that powers the "your brothers are waiting
   * on you" feeling.
   */
  private async buildCrewBlock(params: { userId: string; dayKey: string; publicBaseUrl: string | null }) {
    const membership = await this.prisma.crewMember.findUnique({
      where: { userId: params.userId },
      select: { crewId: true },
    });
    if (!membership) return null;

    const crew = await this.prisma.crew.findUnique({
      where: { id: membership.crewId },
      select: {
        id: true,
        slug: true,
        name: true,
        deletedAt: true,
        currentStreakDays: true,
        longestStreakDays: true,
        lastCompletedDayKey: true,
        members: {
          orderBy: [{ role: 'asc' }, { createdAt: 'asc' }],
          select: {
            user: {
              select: {
                id: true,
                username: true,
                name: true,
                avatarKey: true,
                avatarUpdatedAt: true,
              },
            },
          },
        },
      },
    });
    if (!crew || crew.deletedAt) return null;

    const memberIds = crew.members.map((m) => m.user.id);
    const checkedIn = await this.prisma.post.findMany({
      where: {
        kind: 'checkin',
        checkinDayKey: params.dayKey,
        deletedAt: null,
        userId: { in: memberIds },
      },
      select: { userId: true },
    });
    const checkedInSet = new Set(checkedIn.map((p) => p.userId));

    const memberStatus = crew.members.map((m) => ({
      userId: m.user.id,
      username: m.user.username,
      displayName: (m.user.name ?? m.user.username ?? '').trim() || null,
      avatarUrl: publicAssetUrl({
        publicBaseUrl: params.publicBaseUrl,
        key: m.user.avatarKey,
        updatedAt: m.user.avatarUpdatedAt,
      }),
      answeredToday: checkedInSet.has(m.user.id),
      isViewer: m.user.id === params.userId,
    }));

    return {
      id: crew.id,
      slug: crew.slug,
      name: crew.name,
      promptFraming: 'crew' as const,
      currentStreakDays: crew.currentStreakDays ?? 0,
      longestStreakDays: crew.longestStreakDays ?? 0,
      lastCompletedDayKey: crew.lastCompletedDayKey,
      memberStatus,
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

    // Bust the today-state cache so the next GET /checkins/today reflects
    // the completed check-in, updated coins, and new streak.
    void this.redis.del(RedisKeys.checkinTodayState(params.userId, dayKey)).catch(() => undefined);

    // Strict crew streak: if this check-in completes the crew's day, bump the
    // streak and bust other members' cached today-state so their member-status
    // row reflects the new check. Failures here are non-fatal — the user's own
    // check-in already succeeded; we just won't have moved the crew counter.
    void this.handleCrewSideEffectsOnCheckin({ userId: params.userId, dayKey, now }).catch(() => undefined);

    return {
      post,
      checkin: { dayKey, prompt },
      coinsAwarded,
      bonusCoinsAwarded,
      checkinStreakDays: after.checkinStreakDays ?? 0,
    };
  }

  /**
   * Side effects on a single check-in for a user in a crew:
   *  1) Bust the cached `today` state for all other crew members so their
   *     member-status row reflects the new check by next request.
   *  2) Try to advance the strict crew streak (no-op unless this check-in
   *     completes the day).
   */
  private async handleCrewSideEffectsOnCheckin(params: { userId: string; dayKey: string; now: Date }): Promise<void> {
    const membership = await this.prisma.crewMember.findUnique({
      where: { userId: params.userId },
      select: { crewId: true },
    });
    if (!membership) return;

    const crew = await this.prisma.crew.findUnique({
      where: { id: membership.crewId },
      select: {
        id: true,
        slug: true,
        name: true,
        deletedAt: true,
        memberCount: true,
        currentStreakDays: true,
        longestStreakDays: true,
        lastCompletedDayKey: true,
        members: { select: { userId: true } },
      },
    });
    if (!crew || crew.deletedAt) return;

    const memberIds = crew.members.map((m) => m.userId);
    // Bust today-state cache for every other crew member so the next /checkins/today
    // reflects this check-in in the member-status row.
    for (const otherId of memberIds) {
      if (otherId === params.userId) continue;
      void this.redis.del(RedisKeys.checkinTodayState(otherId, params.dayKey)).catch(() => undefined);
    }

    await this.tryAdvanceCrewStreakInternal({ crew, memberIds, dayKey: params.dayKey, now: params.now });
  }

  private async tryAdvanceCrewStreakInternal(params: {
    crew: {
      id: string;
      slug: string;
      name: string | null;
      currentStreakDays: number | null;
      longestStreakDays: number | null;
      lastCompletedDayKey: string | null;
    };
    memberIds: string[];
    dayKey: string;
    now: Date;
  }): Promise<void> {
    const { crew, memberIds, dayKey, now } = params;

    if (memberIds.length === 0) return;
    // Already advanced for today — nothing to do (e.g. last member of a 3-person crew
    // and someone else triggered the advance via a race).
    if (crew.lastCompletedDayKey === dayKey) return;

    // Count distinct members who have a non-deleted check-in for this dayKey.
    // We rely on the one-checkin-per-user-per-day invariant enforced by PostsService.
    const checkedInCount = await this.prisma.post.count({
      where: {
        kind: 'checkin',
        checkinDayKey: dayKey,
        deletedAt: null,
        userId: { in: memberIds },
      },
    });

    if (checkedInCount < memberIds.length) return;

    const yesterdayKey = yesterdayEasternDayKey(now);
    const continuedStreak = crew.lastCompletedDayKey === yesterdayKey;
    const nextCurrent = continuedStreak ? (crew.currentStreakDays ?? 0) + 1 : 1;
    const nextLongest = Math.max(crew.longestStreakDays ?? 0, nextCurrent);

    // Conditional update guards against a concurrent advance for the same day.
    const updated = await this.prisma.crew.updateMany({
      where: {
        id: crew.id,
        // Only flip if no one else has already completed this day.
        OR: [{ lastCompletedDayKey: null }, { lastCompletedDayKey: { not: dayKey } }],
      },
      data: {
        currentStreakDays: nextCurrent,
        longestStreakDays: nextLongest,
        lastCompletedDayKey: dayKey,
      },
    });
    if (updated.count === 0) return;

    this.presenceRealtime.emitCrewStreakAdvanced(memberIds, {
      crewId: crew.id,
      dayKey,
      currentStreakDays: nextCurrent,
      longestStreakDays: nextLongest,
    });

    // Highest-signal push in the product. Gated by per-user pushCrewStreak pref
    // inside NotificationsService. Fire-and-forget — the streak is already advanced.
    void this.notifications
      .sendCrewStreakAdvancedPush({
        recipientUserIds: memberIds,
        crewId: crew.id,
        crewSlug: crew.slug,
        crewName: crew.name,
        currentStreakDays: nextCurrent,
        memberCount: memberIds.length,
      })
      .catch(() => undefined);
  }

  /**
   * Social proof for "today's question": how many people have already answered today,
   * with up to 5 recent answerers biased toward people the viewer follows.
   *
   * Returns a stable shape regardless of viewer auth state — anon viewers get the same
   * total + a generic "recent answerers" list with no follow weighting.
   */
  async getTodayAnswered(params: {
    viewerUserId: string | null;
    publicBaseUrl: string | null;
    now?: Date;
  }) {
    const now = params.now ?? new Date();
    const dayKey = easternDayKey(now);

    // Total: cheap count over today's check-ins (one row per user per day).
    // We deliberately exclude `onlyMe` posts since they aren't part of the social signal.
    const totalToday = await this.prisma.post.count({
      where: {
        kind: 'checkin',
        checkinDayKey: dayKey,
        deletedAt: null,
        visibility: { not: 'onlyMe' },
      },
    });

    // Pre-load followed userIds for follow-biased ordering. Followers go to the front;
    // remaining slots fill from the most-recent answerers globally.
    let followedSet: Set<string> = new Set();
    if (params.viewerUserId) {
      const follows = await this.prisma.follow.findMany({
        where: { followerId: params.viewerUserId },
        select: { followingId: true },
        take: 5000,
      });
      followedSet = new Set(follows.map((f) => f.followingId));
    }

    // Pull a small recent window — enough to reorder by follow bias without needing
    // a complex SQL window function.
    const recentLimit = 5;
    const candidatePool = await this.prisma.post.findMany({
      where: {
        kind: 'checkin',
        checkinDayKey: dayKey,
        deletedAt: null,
        visibility: { not: 'onlyMe' },
        // Exclude the viewer themselves so they don't see their own face in the proof row.
        ...(params.viewerUserId ? { userId: { not: params.viewerUserId } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: {
        createdAt: true,
        user: {
          select: {
            id: true,
            username: true,
            name: true,
            avatarKey: true,
            avatarUpdatedAt: true,
            verifiedStatus: true,
            premium: true,
            premiumPlus: true,
          },
        },
      },
    });

    // De-dupe by user id (one face per person), then partition into followed / others.
    const seen = new Set<string>();
    const followed: typeof candidatePool = [];
    const others: typeof candidatePool = [];
    for (const row of candidatePool) {
      const uid = row.user?.id;
      if (!uid || seen.has(uid)) continue;
      seen.add(uid);
      if (followedSet.has(uid)) followed.push(row);
      else others.push(row);
    }
    const ordered = [...followed, ...others].slice(0, recentLimit);

    const recentAnswerers = ordered.map((row) => ({
      id: row.user.id,
      username: row.user.username,
      displayName: (row.user.name ?? row.user.username ?? '').trim() || null,
      avatarUrl: publicAssetUrl({
        publicBaseUrl: params.publicBaseUrl,
        key: row.user.avatarKey,
        updatedAt: row.user.avatarUpdatedAt,
      }),
      answeredAt: row.createdAt.toISOString(),
      isFollowed: followedSet.has(row.user.id),
    }));

    return {
      dayKey,
      totalToday,
      recentAnswerers,
    };
  }

  async getLeaderboard(params: { publicBaseUrl: string | null; limit?: number; viewerUserId?: string | null }) {
    const take = Math.min(Math.max(1, params.limit ?? 25), 50);
    const cacheKey = RedisKeys.checkinLeaderboard(take);

    // Try to serve the top-N list from cache. Viewer rank is always computed fresh
    // since it depends on the calling user and is only needed for out-of-top-N viewers.
    type LeaderboardUser = {
      id: string; username: string | null; name: string | null; premium: boolean; premiumPlus: boolean;
      isOrganization: boolean; stewardBadgeEnabled: boolean; verifiedStatus: string; avatarUrl: string | null;
      checkinStreakDays: number; longestStreakDays: number;
    };
    let cachedUsers: LeaderboardUser[] | null = null;
    try {
      cachedUsers = await this.redis.getJson<LeaderboardUser[]>(cacheKey);
    } catch { /* Redis unavailable */ }

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

    const toDto = (u: {
      id: string; username: string | null; name: string | null; premium: boolean; premiumPlus: boolean;
      isOrganization: boolean; stewardBadgeEnabled: boolean; verifiedStatus: string;
      avatarKey: string | null; avatarUpdatedAt: Date | null; checkinStreakDays: number | null; longestStreakDays: number | null;
    }): LeaderboardUser => ({
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

    let users: LeaderboardUser[];
    if (cachedUsers) {
      users = cachedUsers;
    } else {
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

      users = topUsers.map(toDto);
      void this.redis
        .setJson(cacheKey, users, { ttlSeconds: LEADERBOARD_CACHE_TTL_SECONDS })
        .catch(() => undefined);
    }

    // If a viewer is authenticated and not already in the top-N list, find their rank.
    // The count query for ranking can be expensive, so cache it per viewer for the same
    // TTL as the top list.
    let viewerRank: { rank: number; user: LeaderboardUser } | null = null;
    if (params.viewerUserId && !users.some((u) => u.id === params.viewerUserId)) {
      const rankCacheKey = RedisKeys.checkinLeaderboardViewerRank(params.viewerUserId, take);
      try {
        const cached = await this.redis.getJson<{ v: { rank: number; user: LeaderboardUser } | null }>(rankCacheKey);
        if (cached) {
          viewerRank = cached.v;
          return { users, viewerRank };
        }
      } catch { /* Redis unavailable */ }

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
      void this.redis
        .setJson(rankCacheKey, { v: viewerRank }, { ttlSeconds: LEADERBOARD_CACHE_TTL_SECONDS })
        .catch(() => undefined);
    }

    return { users, viewerRank };
  }

  /**
   * Best-streak leaderboard: ranks by highest longestStreakDays ever achieved.
   * Returns up to `take` users, plus the viewer's own rank if they are not in the top-N.
   */
  async getBestStreakLeaderboard(params: { publicBaseUrl: string | null; limit?: number; viewerUserId?: string | null }) {
    const take = Math.min(Math.max(1, params.limit ?? 25), 50);
    const cacheKey = RedisKeys.checkinBestStreakLeaderboard(take);

    type LeaderboardUser = {
      id: string; username: string | null; name: string | null; premium: boolean; premiumPlus: boolean;
      isOrganization: boolean; stewardBadgeEnabled: boolean; verifiedStatus: string; avatarUrl: string | null;
      checkinStreakDays: number; longestStreakDays: number;
    };
    let cachedUsers: LeaderboardUser[] | null = null;
    try {
      cachedUsers = await this.redis.getJson<LeaderboardUser[]>(cacheKey);
    } catch { /* Redis unavailable */ }

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

    const toDto = (u: {
      id: string; username: string | null; name: string | null; premium: boolean; premiumPlus: boolean;
      isOrganization: boolean; stewardBadgeEnabled: boolean; verifiedStatus: string;
      avatarKey: string | null; avatarUpdatedAt: Date | null; checkinStreakDays: number | null; longestStreakDays: number | null;
    }): LeaderboardUser => ({
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

    let users: LeaderboardUser[];
    if (cachedUsers) {
      users = cachedUsers;
    } else {
      const topUsers = await this.prisma.user.findMany({
        where: {
          bannedAt: null,
          OR: [{ checkinStreakDays: { gt: 0 } }, { longestStreakDays: { gt: 0 } }],
        },
        orderBy: [{ longestStreakDays: 'desc' }, { checkinStreakDays: 'desc' }, { createdAt: 'asc' }],
        take,
        select: userSelect,
      });

      users = topUsers.map(toDto);
      void this.redis
        .setJson(cacheKey, users, { ttlSeconds: LEADERBOARD_CACHE_TTL_SECONDS })
        .catch(() => undefined);
    }

    let viewerRank: { rank: number; user: LeaderboardUser } | null = null;
    if (params.viewerUserId && !users.some((u) => u.id === params.viewerUserId)) {
      const rankCacheKey = RedisKeys.checkinLeaderboardViewerRank(params.viewerUserId, take, 'best');
      try {
        const cached = await this.redis.getJson<{ v: { rank: number; user: LeaderboardUser } | null }>(rankCacheKey);
        if (cached) {
          viewerRank = cached.v;
          return { users, viewerRank };
        }
      } catch { /* Redis unavailable */ }

      const viewerRow = await this.prisma.user.findUnique({
        where: { id: params.viewerUserId },
        select: userSelect,
      });
      if (viewerRow) {
        const effectiveLongest = Math.max(viewerRow.longestStreakDays ?? 0, viewerRow.checkinStreakDays ?? 0);
        const aheadCount = await this.prisma.user.count({
          where: {
            bannedAt: null,
            OR: [{ checkinStreakDays: { gt: 0 } }, { longestStreakDays: { gt: 0 } }],
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
        .setJson(rankCacheKey, { v: viewerRank }, { ttlSeconds: LEADERBOARD_CACHE_TTL_SECONDS })
        .catch(() => undefined);
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

    const weeklyCacheKey = RedisKeys.checkinWeeklyLeaderboard(take, weekStart.toISOString());

    type WeeklyLeaderboardUser = {
      id: string; username: string | null; name: string | null; premium: boolean; premiumPlus: boolean;
      isOrganization: boolean; stewardBadgeEnabled: boolean; verifiedStatus: string; avatarUrl: string | null;
      checkinStreakDays: number; longestStreakDays: number; daysThisWeek: number;
    };

    const cachedWeekly = await this.redis.getJson<{
      users: WeeklyLeaderboardUser[];
      viewerRankForId: Record<string, { rank: number; user: WeeklyLeaderboardUser } | null>;
    }>(weeklyCacheKey).catch(() => null);

    if (cachedWeekly) {
      const viewerRank = params.viewerUserId ? (cachedWeekly.viewerRankForId[params.viewerUserId] ?? null) : null;
      return { users: cachedWeekly.users, viewerRank, weekStart };
    }

    // Count distinct ET posting days per user in the current ET week using a raw query.
    // AT TIME ZONE on the createdAt converts to ET; date_trunc extracts the ET calendar day.
    const rows = await this.prisma.$queryRaw<Array<{ userId: string; daysPosted: bigint }>>`
      SELECT
        p."userId",
        COUNT(DISTINCT date_trunc('day', p."createdAt" AT TIME ZONE 'America/New_York')) AS "daysPosted"
      FROM "Post" p
      WHERE
        p."deletedAt" IS NULL
        AND p."isDraft" = false
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
    let viewerRank: { rank: number; user: WeeklyLeaderboardUser } | null = null;
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

    // Cache the result including the viewer rank so repeat calls for the same viewer are fast.
    void this.redis.setJson(
      weeklyCacheKey,
      {
        users,
        viewerRankForId: params.viewerUserId ? { [params.viewerUserId]: viewerRank } : {},
      },
      { ttlSeconds: WEEKLY_LEADERBOARD_CACHE_TTL_SECONDS },
    ).catch(() => undefined);

    return { users, viewerRank, weekStart };
  }
}

