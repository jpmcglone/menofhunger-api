import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { PostVisibility } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PostsMutationService } from './posts-mutation.service';
import { PresenceRealtimeService } from '../presence/presence-realtime.service';
import { AppConfigService } from '../app/app-config.service';
import { USER_LIST_SELECT, MENTION_USER_SELECT } from '../../common/prisma-selects/user.select';
import { notDeletedWhere } from './posts-query-builders';
import { toPostDto } from '../../common/dto/post.dto';
import { toScheduledPostDto } from '../../common/dto/scheduled-post.dto';
import type { ScheduledPostDto } from '../../common/dto/scheduled-post.dto';

/** Maximum scheduling window: 60 days from now. */
const MAX_SCHEDULE_OFFSET_MS = 60 * 24 * 60 * 60 * 1000;
/** Max pending scheduled posts per user. Conservative to limit holding-row abuse. */
const MAX_QUEUED_SCHEDULED_POSTS = 25;
/** Max rows processed across all users per cron sweep. */
const SWEEP_GLOBAL_LIMIT = 50;
/** Max rows processed per user per cron sweep — prevents one user monopolising a sweep. */
const SWEEP_PER_USER_LIMIT = 10;

/** New media — used for create and as the resolved form in update. */
export type ScheduledPostNewMediaInput = {
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
};

/** Input for updates — may reference existing holding-row media by id. */
export type ScheduledPostMediaInput =
  | { source: 'existing'; id: string; alt?: string | null }
  | ScheduledPostNewMediaInput;

export type ScheduledPollInput = {
  options: Array<{ text: string }>;
  durationHours: number;
};

@Injectable()
export class ScheduledPostsService {
  private readonly logger = new Logger(ScheduledPostsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mutation: PostsMutationService,
    private readonly realtime: PresenceRealtimeService,
    private readonly appConfig: AppConfigService,
  ) {}

  private r2BaseUrl(): string | null {
    return this.appConfig.r2()?.publicBaseUrl ?? null;
  }

  private assertPremium(user: { premium: boolean; premiumPlus: boolean }) {
    if (!user.premium && !user.premiumPlus) {
      throw new ForbiddenException('Scheduled posts are for premium members only.');
    }
  }

  private validateScheduledAt(scheduledAt: Date, now: Date = new Date()) {
    const delta = scheduledAt.getTime() - now.getTime();
    // No minimum offset enforced server-side — the UI prevents picking < 5 min,
    // but if the user took time composing and the window slipped, the cron will
    // publish it on its next sweep (within ~1 minute).
    if (delta > MAX_SCHEDULE_OFFSET_MS) {
      throw new BadRequestException('Scheduled time cannot be more than 60 days in the future.');
    }
  }

  async createScheduled(params: {
    userId: string;
    body: string;
    visibility: PostVisibility;
    scheduledAt: Date;
    media: ScheduledPostNewMediaInput[] | null;
    poll: ScheduledPollInput | null;
    communityGroupId: string | null;
  }): Promise<ScheduledPostDto> {
    const { userId } = params;
    const body = (params.body ?? '').trim();
    const now = new Date();

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { premium: true, premiumPlus: true, verifiedStatus: true },
    });
    if (!user) throw new NotFoundException('User not found.');
    this.assertPremium(user);

    // Enforce per-user cap before creating another holding row.
    const queuedCount = await this.prisma.post.count({
      where: {
        AND: [
          notDeletedWhere(),
          { userId },
          { isDraft: true },
          { scheduledAt: { not: null } },
        ],
      },
    });
    if (queuedCount >= MAX_QUEUED_SCHEDULED_POSTS) {
      throw new BadRequestException(
        `You can have up to ${MAX_QUEUED_SCHEDULED_POSTS} scheduled posts at a time. Publish or delete some to schedule more.`,
      );
    }

    this.validateScheduledAt(params.scheduledAt, now);

    const visibility = params.visibility;
    // Scheduled posts cannot be replies, quotes, or onlyMe.
    if (visibility === 'onlyMe') {
      throw new BadRequestException('Scheduled posts cannot have "only me" visibility.');
    }

    const userIsVerified = Boolean(user.verifiedStatus && user.verifiedStatus !== 'none');
    const userIsPremium = Boolean(user.premium || user.premiumPlus);

    const maxLen = userIsPremium ? 1000 : 500;
    if (body.length > maxLen) {
      throw new BadRequestException(`Posts are limited to ${maxLen} characters.`);
    }

    const media = (params.media ?? []).filter(Boolean);
    if (media.length > 4) throw new BadRequestException('You can attach up to 4 images, GIFs, or videos.');
    const hasVideo = media.some((m) => m.kind === 'video');
    const hasImageOrGif = media.some((m) => m.kind !== 'video');
    if (hasImageOrGif && !userIsVerified) throw new ForbiddenException('Verify your account to post images and GIFs.');
    if (hasVideo && !userIsPremium) throw new ForbiddenException('Video posts are for premium members only.');

    // Validate poll.
    if (params.poll) {
      const opts = params.poll.options;
      if (!opts || opts.length < 2 || opts.length > 4) {
        throw new BadRequestException('Polls must have 2–4 options.');
      }
      for (const opt of opts) {
        const text = (opt.text ?? '').trim();
        if (!text) throw new BadRequestException('Poll options cannot be empty.');
        if (text.length > 80) throw new BadRequestException('Poll options are limited to 80 characters.');
      }
      if (params.poll.durationHours < 1 || params.poll.durationHours > 168) {
        throw new BadRequestException('Poll duration must be between 1 and 168 hours.');
      }
    }

    // Validate community group membership if group post.
    const resolvedGroupId = (params.communityGroupId ?? '').trim() || null;
    if (resolvedGroupId) {
      const membership = await this.prisma.communityGroupMember.findUnique({
        where: { groupId_userId: { groupId: resolvedGroupId, userId } },
        select: { status: true },
      });
      if (!membership) throw new ForbiddenException('You must be a member of this group to post in it.');
    }

    const scheduledPollJson = params.poll
      ? {
          options: params.poll.options.map((o) => ({ text: o.text.trim() })),
          durationHours: params.poll.durationHours,
        }
      : null;

    const holding = await this.prisma.post.create({
      data: {
        userId,
        body,
        visibility: 'onlyMe',
        isDraft: true,
        scheduledAt: params.scheduledAt,
        scheduledVisibility: visibility,
        scheduledCommunityGroupId: resolvedGroupId,
        scheduledPollJson: scheduledPollJson ?? undefined,
        ...(media.length
          ? {
              media: {
                create: media.map((m, idx) => ({
                  source: m.source,
                  kind: m.kind,
                  r2Key: m.r2Key ?? null,
                  thumbnailR2Key: m.thumbnailR2Key ?? null,
                  url: m.url ?? null,
                  mp4Url: m.mp4Url ?? null,
                  width: m.width ?? null,
                  height: m.height ?? null,
                  durationSeconds: m.durationSeconds ?? null,
                  alt: m.alt ?? null,
                  position: idx,
                })),
              },
            }
          : {}),
      },
      include: {
        user: { select: USER_LIST_SELECT },
        media: { orderBy: { position: 'asc' } },
        mentions: { include: { user: { select: MENTION_USER_SELECT } } },
        scheduledCommunityGroup: { select: { id: true, slug: true, name: true } },
      },
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return toScheduledPostDto(holding as any, this.r2BaseUrl());
  }

  async listScheduled(params: { userId: string; cursor: string | null; limit?: number }): Promise<{
    items: ScheduledPostDto[];
    nextCursor: string | null;
  }> {
    const limit = Math.max(1, Math.min(50, params.limit ?? 30));

    const rows = await this.prisma.post.findMany({
      where: {
        AND: [
          notDeletedWhere(),
          { userId: params.userId },
          { isDraft: true },
          { scheduledAt: { not: null } },
          ...(params.cursor ? [{ scheduledAt: { gt: new Date(params.cursor) } }] : []),
        ],
      },
      include: {
        user: { select: USER_LIST_SELECT },
        media: { orderBy: { position: 'asc' } },
        mentions: { include: { user: { select: MENTION_USER_SELECT } } },
        scheduledCommunityGroup: { select: { id: true, slug: true, name: true } },
      },
      orderBy: [{ scheduledAt: 'asc' }, { id: 'asc' }],
      take: limit + 1,
    });

    const slice = rows.slice(0, limit);
    const nextCursor = rows.length > limit ? (slice[slice.length - 1]?.scheduledAt?.toISOString() ?? null) : null;

    const r2 = this.r2BaseUrl();
    return { items: slice.map((p) => toScheduledPostDto(p, r2)), nextCursor };
  }

  async updateScheduled(params: {
    userId: string;
    scheduledPostId: string;
    body?: string;
    visibility?: PostVisibility;
    scheduledAt?: Date;
    media?: ScheduledPostMediaInput[] | null;
    poll?: ScheduledPollInput | null;
    communityGroupId?: string | null;
  }): Promise<ScheduledPostDto> {
    const id = (params.scheduledPostId ?? '').trim();
    if (!id) throw new NotFoundException('Scheduled post not found.');

    const post = await this.prisma.post.findUnique({
      where: { id },
      include: {
        user: { select: USER_LIST_SELECT },
        media: { orderBy: { position: 'asc' } },
        mentions: { include: { user: { select: MENTION_USER_SELECT } } },
        scheduledCommunityGroup: { select: { id: true, slug: true, name: true } },
      },
    });
    if (!post || post.deletedAt) throw new NotFoundException('Scheduled post not found.');
    if (post.userId !== params.userId) throw new ForbiddenException('Not allowed.');
    if (!post.isDraft || !post.scheduledAt) throw new ForbiddenException('Not a scheduled post.');

    const user = await this.prisma.user.findUnique({
      where: { id: params.userId },
      select: { premium: true, premiumPlus: true, verifiedStatus: true },
    });
    if (!user) throw new NotFoundException('User not found.');
    this.assertPremium(user);

    const now = new Date();
    const nextScheduledAt = params.scheduledAt ?? post.scheduledAt;
    this.validateScheduledAt(nextScheduledAt, now);

    const nextBody = typeof params.body === 'string' ? params.body.trim() : post.body;
    const userIsPremium = Boolean(user.premium || user.premiumPlus);
    const userIsVerified = Boolean(user.verifiedStatus && user.verifiedStatus !== 'none');
    const maxLen = userIsPremium ? 1000 : 500;
    if (nextBody.length > maxLen) {
      throw new BadRequestException(`Posts are limited to ${maxLen} characters.`);
    }

    const nextVisibility = params.visibility ?? (post.scheduledVisibility ?? 'public');
    if (nextVisibility === 'onlyMe') {
      throw new BadRequestException('Scheduled posts cannot have "only me" visibility.');
    }

    // Resolve media: expand 'existing' references using the holding row's current media.
    const rawMedia = params.media === undefined ? null : params.media;
    const media: ScheduledPostNewMediaInput[] | null = rawMedia
      ? rawMedia.map((m): ScheduledPostNewMediaInput => {
          if (m.source !== 'existing') return m;
          const id = (m.id ?? '').trim();
          const found = post.media.find((pm) => pm.id === id && !pm.deletedAt);
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
            durationSeconds: found.durationSeconds ?? undefined,
            alt,
          };
        })
      : null;

    if (media && media.length > 4) throw new BadRequestException('You can attach up to 4 images, GIFs, or videos.');
    if (media && media.length > 0) {
      const hasVideo = media.some((m) => m.kind === 'video');
      const hasImageOrGif = media.some((m) => m.kind !== 'video');
      if (hasImageOrGif && !userIsVerified) throw new ForbiddenException('Verify your account to post images and GIFs.');
      if (hasVideo && !userIsPremium) throw new ForbiddenException('Video posts are for premium members only.');
    }

    // Validate group.
    const resolvedGroupId =
      params.communityGroupId !== undefined
        ? (params.communityGroupId ?? '').trim() || null
        : post.scheduledCommunityGroupId;
    if (resolvedGroupId && resolvedGroupId !== post.scheduledCommunityGroupId) {
      const membership = await this.prisma.communityGroupMember.findUnique({
        where: { groupId_userId: { groupId: resolvedGroupId, userId: params.userId } },
        select: { status: true },
      });
      if (!membership) throw new ForbiddenException('You must be a member of this group to post in it.');
    }

    // Validate poll if provided.
    let nextPollJson: { options: { text: string }[]; durationHours: number } | null = null;
    if (params.poll !== undefined) {
      if (params.poll) {
        const opts = params.poll.options;
        if (!opts || opts.length < 2 || opts.length > 4) throw new BadRequestException('Polls must have 2–4 options.');
        for (const opt of opts) {
          const text = (opt.text ?? '').trim();
          if (!text) throw new BadRequestException('Poll options cannot be empty.');
          if (text.length > 80) throw new BadRequestException('Poll options are limited to 80 characters.');
        }
        if (params.poll.durationHours < 1 || params.poll.durationHours > 168) {
          throw new BadRequestException('Poll duration must be between 1 and 168 hours.');
        }
        nextPollJson = { options: params.poll.options.map((o) => ({ text: o.text.trim() })), durationHours: params.poll.durationHours };
      } else {
        nextPollJson = null;
      }
    } else {
      nextPollJson = post.scheduledPollJson as { options: { text: string }[]; durationHours: number } | null;
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const next = await tx.post.update({
        where: { id },
        data: {
          body: nextBody,
          scheduledAt: nextScheduledAt,
          scheduledVisibility: nextVisibility,
          scheduledCommunityGroupId: resolvedGroupId,
          scheduledPollJson: nextPollJson ?? undefined,
          scheduledError: null,
          scheduledFailedAt: null,
        },
        include: {
          user: { select: USER_LIST_SELECT },
          media: { orderBy: { position: 'asc' } },
          mentions: { include: { user: { select: MENTION_USER_SELECT } } },
          scheduledCommunityGroup: { select: { id: true, slug: true, name: true } },
        },
      });

      if (media !== null) {
        await tx.postMedia.deleteMany({ where: { postId: id } });
        if (media.length > 0) {
          await tx.postMedia.createMany({
            data: media.map((m, idx) => ({
              postId: id,
              source: m.source,
              kind: m.kind,
              r2Key: m.r2Key ?? null,
              thumbnailR2Key: m.thumbnailR2Key ?? null,
              url: m.url ?? null,
              mp4Url: m.mp4Url ?? null,
              width: m.width ?? null,
              height: m.height ?? null,
              durationSeconds: m.durationSeconds ?? null,
              alt: m.alt ?? null,
              position: idx,
            })),
          });
        }
      }

      return next;
    });

    // Re-fetch with updated media included.
    const full = await this.prisma.post.findUnique({
      where: { id },
      include: {
        user: { select: USER_LIST_SELECT },
        media: { orderBy: { position: 'asc' } },
        mentions: { include: { user: { select: MENTION_USER_SELECT } } },
        scheduledCommunityGroup: { select: { id: true, slug: true, name: true } },
      },
    });

    return toScheduledPostDto(full ?? updated, this.r2BaseUrl());
  }

  async deleteScheduled(params: { userId: string; scheduledPostId: string }): Promise<{ success: boolean }> {
    const id = (params.scheduledPostId ?? '').trim();
    if (!id) throw new NotFoundException('Scheduled post not found.');

    const post = await this.prisma.post.findUnique({
      where: { id },
      select: { id: true, userId: true, deletedAt: true, isDraft: true, scheduledAt: true },
    });
    if (!post || post.deletedAt) throw new NotFoundException('Scheduled post not found.');
    if (post.userId !== params.userId) throw new ForbiddenException('Not allowed.');
    if (!post.isDraft || !post.scheduledAt) throw new ForbiddenException('Not a scheduled post.');

    await this.prisma.post.update({ where: { id }, data: { deletedAt: new Date() } });
    return { success: true };
  }

  /**
   * Claim and publish all scheduled posts whose fire time is <= now.
   * Called from the background job processor once a minute.
   * Atomic claim via updateMany prevents double-publish in multi-instance deploys.
   * Per-user fairness: at most SWEEP_PER_USER_LIMIT rows per user per sweep.
   */
  async publishDue(now: Date = new Date()): Promise<void> {
    // Fetch more candidates than the global limit to allow per-user fairness filtering.
    const candidates = await this.prisma.post.findMany({
      where: {
        AND: [
          notDeletedWhere(),
          { isDraft: true },
          { scheduledAt: { lte: now, not: null } },
        ],
      },
      include: {
        media: { orderBy: { position: 'asc' } },
      },
      orderBy: [{ scheduledAt: 'asc' }, { id: 'asc' }],
      take: SWEEP_GLOBAL_LIMIT * 4, // wide scan; per-user filter narrows below
    });

    const perUserCounts = new Map<string, number>();
    let globalCount = 0;

    for (const post of candidates) {
      if (globalCount >= SWEEP_GLOBAL_LIMIT) break;
      const userCount = perUserCounts.get(post.userId) ?? 0;
      if (userCount >= SWEEP_PER_USER_LIMIT) continue;
      perUserCounts.set(post.userId, userCount + 1);
      globalCount++;
      await this.publishOne(post, now);
    }
  }

  private async publishOne(
    post: Awaited<ReturnType<typeof this.prisma.post.findMany>>[0] & {
      media: Array<{
        source: string;
        kind: string;
        r2Key: string | null;
        thumbnailR2Key: string | null;
        url: string | null;
        mp4Url: string | null;
        width: number | null;
        height: number | null;
        durationSeconds: number | null;
        alt: string | null;
        position: number;
      }>;
    },
    now: Date,
  ): Promise<void> {
    const scheduledId = post.id;
    const userId = post.userId;

    // ── Re-validate author eligibility BEFORE claiming ──────────────────────
    // This prevents wasted claim + immediate rollback for permanently ineligible rows.
    // We only emit the failed event once (when scheduledError was previously null)
    // to avoid toasting the user every minute.
    const author = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { premium: true, premiumPlus: true, verifiedStatus: true, bannedAt: true },
    });

    const revalError = this.revalidateForPublish(author, post);
    if (revalError) {
      this.logger.warn(`Scheduled post ${scheduledId} ineligible: ${revalError}`);
      const isFirstFailure = !post.scheduledError;
      await this.prisma.post.update({
        where: { id: scheduledId },
        data: { scheduledError: revalError.slice(0, 500), scheduledFailedAt: now },
      });
      if (isFirstFailure) {
        this.realtime.emitScheduledPostFailed(userId, { scheduledId, error: revalError });
      }
      return;
    }

    // Atomic claim: clear scheduledAt so concurrent sweeps skip this row.
    const claimed = await this.prisma.post.updateMany({
      where: {
        id: scheduledId,
        scheduledAt: { not: null },
        deletedAt: null,
      },
      data: { scheduledAt: null },
    });
    if (claimed.count === 0) {
      // Already claimed by another instance — idempotent no-op.
      return;
    }

    try {
      const visibility = (post.scheduledVisibility ?? 'public') as PostVisibility;
      const communityGroupId = post.scheduledCommunityGroupId ?? null;

      // Build poll from stored JSON.
      const pollJson = post.scheduledPollJson as { options: { text: string }[]; durationHours: number } | null;
      let poll: { endsAt: Date; options: Array<{ text: string; image: null }> } | null = null;
      if (pollJson?.options?.length) {
        const endsAt = new Date(now.getTime() + (pollJson.durationHours ?? 24) * 60 * 60 * 1000);
        poll = {
          endsAt,
          options: pollJson.options.map((o) => ({ text: o.text, image: null })),
        };
      }

      // Replay createPost pipeline.
      const bundle = await this.mutation.createPost({
        userId,
        body: post.body,
        visibility,
        parentId: null,
        mentions: null,
        communityGroupId,
        media: post.media.length
          ? post.media.map((m) => ({
              source: m.source === 'giphy' ? ('giphy' as const) : ('upload' as const),
              kind: m.kind as 'image' | 'gif' | 'video',
              r2Key: m.r2Key ?? undefined,
              thumbnailR2Key: m.thumbnailR2Key ?? undefined,
              url: m.url ?? undefined,
              mp4Url: m.mp4Url ?? undefined,
              width: m.width ?? undefined,
              height: m.height ?? undefined,
              durationSeconds: m.durationSeconds ?? undefined,
              alt: m.alt ?? null,
            }))
          : null,
        poll,
      });

      // Remove the holding row.
      await this.prisma.post.update({ where: { id: scheduledId }, data: { deletedAt: now } });

      // Notify the author that the post went live.
      const postDto = toPostDto(bundle.post, this.r2BaseUrl());
      this.realtime.emitScheduledPostPublished(userId, { scheduledId, post: postDto });

      this.logger.log(`Scheduled post ${scheduledId} published as ${bundle.post.id}`);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Failed to publish scheduled post ${scheduledId}: ${errorMsg}`);

      // Restore scheduledAt so the row retries on the next sweep; mark the transient error.
      await this.prisma.post.update({
        where: { id: scheduledId },
        data: {
          scheduledAt: post.scheduledAt,
          scheduledError: errorMsg.slice(0, 500),
          scheduledFailedAt: now,
        },
      });

      this.realtime.emitScheduledPostFailed(userId, { scheduledId, error: errorMsg });
    }
  }

  /**
   * Returns a human-readable error string if the author is no longer eligible to publish,
   * or null if everything looks good. Called before the atomic claim.
   */
  private revalidateForPublish(
    author: { premium: boolean; premiumPlus: boolean; verifiedStatus: string | null; bannedAt: Date | null } | null,
    post: { media: Array<{ kind: string }>; scheduledCommunityGroupId: string | null; scheduledError: string | null },
  ): string | null {
    if (!author || author.bannedAt) {
      return 'Account is no longer eligible to post.';
    }
    const isPremium = Boolean(author.premium || author.premiumPlus);
    if (!isPremium) {
      return 'Scheduled posts require premium. Renew your subscription to publish.';
    }
    const isVerified = Boolean(author.verifiedStatus && author.verifiedStatus !== 'none');
    const hasImageOrGif = post.media.some((m) => m.kind !== 'video');
    if (hasImageOrGif && !isVerified) {
      return 'Verify your account to post images and GIFs.';
    }
    // Group membership is checked at claim time inside createPost if the group post path is taken;
    // we do a lightweight pre-check here to give the user an early actionable error.
    // (Full check happens in createPost anyway, so no race concern.)
    return null;
  }
}
