import { findGroupMemberStatus } from '../viewer/group-membership.queries';
import { assertXCrosspostInput } from "../../common/crosspost/x-crosspost-input";
import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { PostVisibility } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { AppConfigService } from "../app/app-config.service";
import { USER_LIST_SELECT, MENTION_USER_SELECT } from "../../common/prisma-selects/user.select";
import { notDeletedWhere } from "./posts-query-builders";
import { toScheduledPostDto } from "../../common/dto/scheduled-post.dto";
import type { ScheduledPostDto } from "../../common/dto/scheduled-post.dto";
import { toPage, clampLimit } from '../../common/pagination/page';
import { GROUP_REF_SELECT } from '../../common/prisma-selects/group.select';
import type { ScheduledPollInput, ScheduledPostMediaInput, ScheduledPostNewMediaInput } from './scheduled-posts.types';
import { assertPremium, validateScheduledAt } from './scheduled-posts.policy';
import { ScheduledPostsUpdateService } from './scheduled-posts-update.service';
import { ScheduledPostsPublishService } from './scheduled-posts-publish.service';

/** Max pending scheduled posts per user. Conservative to limit holding-row abuse. */
const MAX_QUEUED_SCHEDULED_POSTS = 25;

@Injectable()
export class ScheduledPostsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly appConfig: AppConfigService,
    private readonly updater: ScheduledPostsUpdateService,
    private readonly publisher: ScheduledPostsPublishService,
  ) {}

  publishDue(now: Date = new Date()): Promise<void> {
    return this.publisher.publishDue(now);
  }

  async createScheduled(params: {
    userId: string;
    body: string;
    visibility: PostVisibility;
    scheduledAt: Date;
    crosspost?: { pickax?: "link" | "native"; x?: "link" | "native" };
    media: ScheduledPostNewMediaInput[] | null;
    poll: ScheduledPollInput | null;
    communityGroupId: string | null;
  }): Promise<ScheduledPostDto> {
    if (params.crosspost?.x)
      assertXCrosspostInput(params, this.appConfig.integrationBudget().enabled);
    const { userId } = params;
    const body = (params.body ?? "").trim();
    const now = new Date();

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { premium: true, premiumPlus: true, verifiedStatus: true },
    });
    if (!user) throw new NotFoundException("User not found.");
    assertPremium(user);

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

    validateScheduledAt(params.scheduledAt, now);

    const visibility = params.visibility;
    // Scheduled posts cannot be replies, quotes, or onlyMe.
    if (visibility === "onlyMe") {
      throw new BadRequestException(
        'Scheduled posts cannot have "only me" visibility.',
      );
    }

    const userIsVerified = Boolean(
      user.verifiedStatus && user.verifiedStatus !== "none",
    );
    const userIsPremium = Boolean(user.premium || user.premiumPlus);

    const maxLen = userIsPremium ? 1000 : 500;
    if (body.length > maxLen) {
      throw new BadRequestException(
        `Posts are limited to ${maxLen} characters.`,
      );
    }

    const media = (params.media ?? []).filter(Boolean);
    if (media.length > 4)
      throw new BadRequestException(
        "You can attach up to 4 images, GIFs, or videos.",
      );
    const hasVideo = media.some((m) => m.kind === "video");
    const hasImageOrGif = media.some((m) => m.kind !== "video");
    if (hasImageOrGif && !userIsVerified)
      throw new ForbiddenException(
        "Verify your account to post images and GIFs.",
      );
    if (hasVideo && !userIsPremium)
      throw new ForbiddenException("Video posts are for premium members only.");

    // Validate poll.
    if (params.poll) {
      const opts = params.poll.options;
      if (!opts || opts.length < 2 || opts.length > 4) {
        throw new BadRequestException("Polls must have 2–4 options.");
      }
      for (const opt of opts) {
        const text = (opt.text ?? "").trim();
        if (!text)
          throw new BadRequestException("Poll options cannot be empty.");
        if (text.length > 80)
          throw new BadRequestException(
            "Poll options are limited to 80 characters.",
          );
      }
      if (params.poll.durationHours < 1 || params.poll.durationHours > 168) {
        throw new BadRequestException(
          "Poll duration must be between 1 and 168 hours.",
        );
      }
    }

    // Validate community group membership if group post.
    const resolvedGroupId = (params.communityGroupId ?? "").trim() || null;
    if (resolvedGroupId) {
      const membership = await findGroupMemberStatus(this.prisma, resolvedGroupId, userId);
      if (!userIsVerified)
        throw new ForbiddenException("Verify your account to post in groups.");
      if (membership?.status !== "active")
        throw new ForbiddenException(
          "You must be a member of this group to post in it.",
        );
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
        visibility: "onlyMe",
        isDraft: true,
        scheduledAt: params.scheduledAt,
        crosspostChoices: params.crosspost,
        scheduledVisibility: resolvedGroupId ? "verifiedOnly" : visibility,
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
        media: { orderBy: { position: "asc" } },
        mentions: { include: { user: { select: MENTION_USER_SELECT } } },
        scheduledCommunityGroup: {
          select: GROUP_REF_SELECT,
        },
      },
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return toScheduledPostDto(holding, (this.appConfig.r2()?.publicBaseUrl ?? null));
  }

  async listScheduled(params: {
    userId: string;
    cursor: string | null;
    limit?: number;
  }): Promise<{
    items: ScheduledPostDto[];
    nextCursor: string | null;
  }> {
    const limit = clampLimit(params.limit, { default: 30, max: 50 });

    const rows = await this.prisma.post.findMany({
      where: {
        AND: [
          notDeletedWhere(),
          { userId: params.userId },
          { isDraft: true },
          { scheduledAt: { not: null } },
          ...(params.cursor
            ? [{ scheduledAt: { gt: new Date(params.cursor) } }]
            : []),
        ],
      },
      include: {
        user: { select: USER_LIST_SELECT },
        media: { orderBy: { position: "asc" } },
        mentions: { include: { user: { select: MENTION_USER_SELECT } } },
        scheduledCommunityGroup: {
          select: GROUP_REF_SELECT,
        },
      },
      orderBy: [{ scheduledAt: "asc" }, { id: "asc" }],
      take: limit + 1,
    });

    const { items: slice, nextCursor: pageCursor } = toPage(rows, limit, (r) => r.scheduledAt?.toISOString() ?? '');
    const nextCursor = pageCursor || null;

    const r2 = (this.appConfig.r2()?.publicBaseUrl ?? null);
    return { items: slice.map((p) => toScheduledPostDto(p, r2)), nextCursor };
  }

  async updateScheduled(params: { userId: string; scheduledPostId: string; body?: string; visibility?: PostVisibility; scheduledAt?: Date; crosspost?: { pickax?: "link" | "native"; x?: "link" | "native" }; media?: ScheduledPostMediaInput[] | null; poll?: ScheduledPollInput | null; communityGroupId?: string | null }) : Promise<ScheduledPostDto> {
    return this.updater.updateScheduled(params);
  }

  async deleteScheduled(params: {
    userId: string;
    scheduledPostId: string;
  }): Promise<{ success: boolean }> {
    const id = (params.scheduledPostId ?? "").trim();
    if (!id) throw new NotFoundException("Scheduled post not found.");

    const post = await this.prisma.post.findUnique({
      where: { id },
      select: {
        id: true,
        userId: true,
        deletedAt: true,
        isDraft: true,
        scheduledAt: true,
      },
    });
    if (!post || post.deletedAt)
      throw new NotFoundException("Scheduled post not found.");
    if (post.userId !== params.userId)
      throw new ForbiddenException("Not allowed.");
    if (!post.isDraft || !post.scheduledAt)
      throw new ForbiddenException("Not a scheduled post.");

    await this.prisma.post.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
    return { success: true };
  }

}
