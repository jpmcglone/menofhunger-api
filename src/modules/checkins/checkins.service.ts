import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { PostVisibility } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PostsService } from '../posts/posts.service';
import { UsersMeRealtimeService } from '../users/users-me-realtime.service';
import { ViewerContextService } from '../viewer/viewer-context.service';
import { CHECKIN_PROMPTS } from './checkin-prompts';
import { dayIndexEastern, easternDayKey } from '../../common/time/eastern-day-key';

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
    const post = await this.posts.createPost({
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
}

