import { Inject } from '@nestjs/common';
import { PostsMutationWriteService } from '../posts/posts-mutation-write.service';
import { USER_BRIEF_SELECT } from '../../common/prisma-selects/user.select';
import { toAvatarVideoDto } from '../../common/dto/avatar-video.dto';
import { BadRequestException, Injectable, NotFoundException, type OnModuleInit } from '@nestjs/common';
import type { PostVisibility } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

import { UsersMeRealtimeService } from '../users/users-me-realtime.service';
import { ViewerContextService } from '../viewer/viewer-context.service';
import { findCrewIdForUser } from '../viewer/crew-membership.queries';
import { RedisService } from '../redis/redis.service';
import { RedisKeys } from '../redis/redis-keys';
import { CHECKIN_PROMPTS } from './checkin-prompts';
import { americanDay } from '../../common/time/american-day';
import { dayIndexEastern, easternDayKey, yesterdayEasternDayKey } from '../../common/time/eastern-day-key';
import { PosthogService } from '../../common/posthog/posthog.service';
import { publicAssetUrl } from '../../common/assets/public-asset-url';
import { PresenceRealtimeService } from '../presence/presence-realtime.service';
import { SideEffectsRegistry } from '../side-effects/side-effects.registry';
import { SideEffectsService } from '../side-effects/side-effects.service';

import { checkinSchedule, isCheckinOpen, CHECKIN_CLOSED_MESSAGE } from './checkin-schedule';

import { PostsReadService } from '../posts-read/posts-read.service';
import { CheckinLeaderboardsService } from './checkin-leaderboards.service';
import { NOT_DELETED } from '../../common/prisma/where';
const TODAY_STATE_CACHE_TTL_SECONDS = 120;

function pickCheckinPrompt(now: Date): { dayKey: string; prompt: string } {
  const list = CHECKIN_PROMPTS.filter(Boolean);
  const fallback = "How are you doing today?";
  const dayKey = easternDayKey(now);
  const holiday = americanDay(now)?.prompt;
  if (holiday) return { dayKey, prompt: holiday };
  if (list.length === 0) return { dayKey, prompt: fallback };

  // Deterministic rotation by ET day index.
  const dayIndex = dayIndexEastern(now) + 1;
  const i = ((dayIndex % list.length) + list.length) % list.length;
  return { dayKey, prompt: list[i] ?? fallback };
}

@Injectable()
export class CheckinsService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(PostsMutationWriteService) private readonly postsMutationWrite: Pick<PostsMutationWriteService, 'createPost'>,
    private readonly usersMeRealtime: UsersMeRealtimeService,
    private readonly viewerContext: ViewerContextService,
    private readonly redis: RedisService,
    private readonly posthog: PosthogService,
    private readonly presenceRealtime: PresenceRealtimeService,
    private readonly sideEffects: SideEffectsService,
    private readonly registry: SideEffectsRegistry,
    private readonly postsRead: PostsReadService,
    private readonly leaderboards: CheckinLeaderboardsService,
  ) {}

  onModuleInit(): void {
    this.registry.register('crew.checkin.recorded', (payload) =>
      this.handleCrewSideEffectsOnCheckin({
        userId: payload.userId,
        dayKey: payload.dayKey,
        now: new Date(payload.nowIso),
      }),
    );
  }

  async getTodayState(params: { userId: string; publicBaseUrl?: string | null; now?: Date }) {
    const now = params.now ?? new Date();
    const { dayKey, prompt } = pickCheckinPrompt(now);
    const publicBaseUrl = params.publicBaseUrl ?? null;

    const schedule = checkinSchedule(now);
    const withSchedule = (data: Awaited<ReturnType<typeof this._getTodayStateRaw>>) => ({
      ...data,
      ...schedule,
      // Do not reveal today's question before its 5pm release.
      prompt: schedule.isOpen ? prompt : '',
    });
    const cacheKey = RedisKeys.checkinTodayState(params.userId, dayKey);
    try {
      const cached = await this.redis.getJson<Awaited<ReturnType<typeof this._getTodayStateRaw>>>(cacheKey);
      if (cached) return withSchedule(cached);
    } catch {
      // Redis unavailable — fall through to DB.
    }

    const result = await this._getTodayStateRaw(params.userId, now, dayKey, prompt, publicBaseUrl);
    void this.redis.setJson(cacheKey, result, { ttlSeconds: TODAY_STATE_CACHE_TTL_SECONDS }).catch(() => undefined);
    return withSchedule(result);
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
      await this.postsRead.findFirst({
        where: { userId, kind: 'checkin', checkinDayKey: dayKey, ...NOT_DELETED },
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
   * renders the 5-member status row that powers the "your men are waiting
   * on you" feeling.
   */
  private async buildCrewBlock(params: { userId: string; dayKey: string; publicBaseUrl: string | null }) {
    const crewId = await findCrewIdForUser(this.prisma, params.userId);
    if (!crewId) return null;

    const crew = await this.prisma.crew.findUnique({
      where: { id: crewId },
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
                ...USER_BRIEF_SELECT,
                avatarKey: true, avatarVideoKey: true, avatarVideoDurationMs: true,
                avatarUpdatedAt: true,
              },
            },
          },
        },
      },
    });
    if (!crew || crew.deletedAt) return null;

    const memberIds = crew.members.map((m) => m.user.id);
    const checkedIn = await this.postsRead.findMany({
      where: {
        kind: 'checkin',
        checkinDayKey: params.dayKey,
        ...NOT_DELETED,
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
      }), avatarVideo: toAvatarVideoDto(m.user, params.publicBaseUrl),
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

  async createTodayCheckin(params: { userId: string; body: string; visibility: PostVisibility; clientPrompt?: string; now?: Date }) {
    const now = params.now ?? new Date();
    if (!isCheckinOpen(now)) throw new BadRequestException(CHECKIN_CLOSED_MESSAGE);
    const { dayKey, prompt } = pickCheckinPrompt(now);
    if (params.clientPrompt && params.clientPrompt !== prompt) {
      throw new BadRequestException("Today's check-in prompt has changed. Please close the composer and try again.");
    }

    if (params.visibility !== 'verifiedOnly' && params.visibility !== 'premiumOnly') {
      throw new BadRequestException('Check-ins must be verified-only or premium-only.');
    }

    const before = await this.prisma.user.findUnique({
      where: { id: params.userId },
      select: { coins: true, checkinStreakDays: true, lastCheckinDayKey: true },
    });
    if (!before) throw new NotFoundException('User not found.');

    // Note: reward + one-per-day enforcement is handled inside PostsMutationWriteService.createPost when kind=checkin.
    const { post } = await this.postsMutationWrite.createPost({
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

    // The member's check-in is already committed. Crew cache busts and the shared
    // streak run on the queue so a process exit or a thrown error retries them.
    this.sideEffects.dispatch('crew.checkin.recorded', {
      userId: params.userId,
      dayKey,
      nowIso: now.toISOString(),
    });

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
    const crewId = await findCrewIdForUser(this.prisma, params.userId);
    if (!crewId) return;

    const crew = await this.prisma.crew.findUnique({
      where: { id: crewId },
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
    // We rely on the one-checkin-per-user-per-day invariant enforced by PostsMutationWriteService.
    const checkedInCount = await this.postsRead.count({
      where: {
        kind: 'checkin',
        checkinDayKey: dayKey,
        ...NOT_DELETED,
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

    // Highest-signal push in the product, so it goes on the queue and gets retries rather
    // than being lost if this process dies between the streak write and the APNs call.
    this.sideEffects.dispatch('crew.streak.advanced', {
      crewId: crew.id,
      dayKey,
      currentStreakDays: nextCurrent,
    });
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
    const totalToday = await this.postsRead.count({
      where: {
        kind: 'checkin',
        checkinDayKey: dayKey,
        ...NOT_DELETED,
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
    const candidatePool = await this.postsRead.findMany({
      where: {
        kind: 'checkin',
        checkinDayKey: dayKey,
        ...NOT_DELETED,
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
            ...USER_BRIEF_SELECT,
            avatarKey: true, avatarVideoKey: true, avatarVideoDurationMs: true,
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
      }), avatarVideo: toAvatarVideoDto(row.user, params.publicBaseUrl),
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
    return this.leaderboards.getLeaderboard(params);
  }

  async getBestStreakLeaderboard(params: { publicBaseUrl: string | null; limit?: number; viewerUserId?: string | null }) {
    return this.leaderboards.getBestStreakLeaderboard(params);
  }

  async getWeeklyLeaderboard(params: { publicBaseUrl: string | null; limit?: number; viewerUserId?: string | null }) {
    return this.leaderboards.getWeeklyLeaderboard(params);
  }
}

