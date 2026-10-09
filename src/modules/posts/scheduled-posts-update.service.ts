import { Injectable } from '@nestjs/common';
import { assertPremium, validateScheduledAt } from './scheduled-posts.policy';
import { AppConfigService } from "../app/app-config.service";
import { PrismaService } from "../prisma/prisma.service";
import { findGroupMemberStatus } from "../viewer/group-membership.queries";
import { assertXCrosspostInput } from "../../common/crosspost/x-crosspost-input";
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import type { PostVisibility } from "@prisma/client";
import {
  USER_LIST_SELECT,
  MENTION_USER_SELECT,
} from "../../common/prisma-selects/user.select";
import { toScheduledPostDto } from "../../common/dto/scheduled-post.dto";
import type { ScheduledPostDto } from "../../common/dto/scheduled-post.dto";
import { GROUP_REF_SELECT } from "../../common/prisma-selects/group.select";

import type { ScheduledPostMediaInput, ScheduledPostNewMediaInput, ScheduledPollInput } from './scheduled-posts.types';

@Injectable()
export class ScheduledPostsUpdateService {
  constructor(
    private readonly appConfig: AppConfigService,
    private readonly prisma: PrismaService,
  ) {}

  async updateScheduled(params: {
      userId: string;
      scheduledPostId: string;
      body?: string;
      visibility?: PostVisibility;
      scheduledAt?: Date;
      crosspost?: { pickax?: "link" | "native"; x?: "link" | "native" };
      media?: ScheduledPostMediaInput[] | null;
      poll?: ScheduledPollInput | null;
      communityGroupId?: string | null;
    },
  ): Promise<ScheduledPostDto> {
    const id = (params.scheduledPostId ?? "").trim();
    if (!id) throw new NotFoundException("Scheduled post not found.");

    const post = await this.prisma.post.findUnique({
      where: { id },
      include: {
        user: { select: USER_LIST_SELECT },
        media: { orderBy: { position: "asc" } },
        mentions: { include: { user: { select: MENTION_USER_SELECT } } },
        scheduledCommunityGroup: {
          select: GROUP_REF_SELECT,
        },
      },
    });
    if (!post || post.deletedAt)
      throw new NotFoundException("Scheduled post not found.");
    if (post.userId !== params.userId)
      throw new ForbiddenException("Not allowed.");
    if (!post.isDraft || !post.scheduledAt)
      throw new ForbiddenException("Not a scheduled post.");

    const user = await this.prisma.user.findUnique({
      where: { id: params.userId },
      select: { premium: true, premiumPlus: true, verifiedStatus: true },
    });
    if (!user) throw new NotFoundException("User not found.");
    assertPremium(user);

    const now = new Date();
    const nextScheduledAt = params.scheduledAt ?? post.scheduledAt;
    validateScheduledAt(nextScheduledAt, now);

    const nextBody =
      typeof params.body === "string" ? params.body.trim() : post.body;
    const userIsPremium = Boolean(user.premium || user.premiumPlus);
    const userIsVerified = Boolean(
      user.verifiedStatus && user.verifiedStatus !== "none",
    );
    const maxLen = userIsPremium ? 1000 : 500;
    if (nextBody.length > maxLen) {
      throw new BadRequestException(`Posts are limited to ${maxLen} characters.`);
    }

    const nextVisibility =
      params.visibility ?? post.scheduledVisibility ?? "public";
    if (nextVisibility === "onlyMe") {
      throw new BadRequestException(
        'Scheduled posts cannot have "only me" visibility.',
      );
    }

    // Resolve media: expand 'existing' references using the holding row's current media.
    const rawMedia = params.media === undefined ? null : params.media;
    const media: ScheduledPostNewMediaInput[] | null = rawMedia
      ? rawMedia.map((m): ScheduledPostNewMediaInput => {
          if (m.source !== "existing") return m;
          const id = (m.id ?? "").trim();
          const found = post.media.find((pm) => pm.id === id && !pm.deletedAt);
          if (!found) throw new BadRequestException("Invalid media item.");
          const alt = (m.alt ?? "").trim() || (found.alt ?? "").trim() || null;
          return {
            source:
              found.source === "giphy" ? ("giphy" as const) : ("upload" as const),
            kind: found.kind as "image" | "gif" | "video",
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

    if (media && media.length > 4)
      throw new BadRequestException(
        "You can attach up to 4 images, GIFs, or videos.",
      );
    if (media && media.length > 0) {
      const hasVideo = media.some((m) => m.kind === "video");
      const hasImageOrGif = media.some((m) => m.kind !== "video");
      if (hasImageOrGif && !userIsVerified)
        throw new ForbiddenException(
          "Verify your account to post images and GIFs.",
        );
      if (hasVideo && !userIsPremium)
        throw new ForbiddenException("Video posts are for premium members only.");
    }

    // Validate group.
    const resolvedGroupId =
      params.communityGroupId !== undefined
        ? (params.communityGroupId ?? "").trim() || null
        : post.scheduledCommunityGroupId;
    if (resolvedGroupId) {
      const membership = await findGroupMemberStatus(
        this.prisma,
        resolvedGroupId,
        params.userId,
      );
      if (!userIsVerified)
        throw new ForbiddenException("Verify your account to post in groups.");
      if (membership?.status !== "active")
        throw new ForbiddenException(
          "You must be a member of this group to post in it.",
        );
    }

    // Validate poll if provided.
    let nextPollJson: {
      options: { text: string }[];
      durationHours: number;
    } | null = null;
    if (params.poll !== undefined) {
      if (params.poll) {
        const opts = params.poll.options;
        if (!opts || opts.length < 2 || opts.length > 4)
          throw new BadRequestException("Polls must have 2–4 options.");
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
        nextPollJson = {
          options: params.poll.options.map((o) => ({ text: o.text.trim() })),
          durationHours: params.poll.durationHours,
        };
      } else {
        nextPollJson = null;
      }
    } else {
      nextPollJson = post.scheduledPollJson as {
        options: { text: string }[];
        durationHours: number;
      } | null;
    }

    const crosspost =
      params.crosspost ??
      (post.crosspostChoices as
        | { pickax?: "link" | "native"; x?: "link" | "native" }
        | undefined);
    if (crosspost?.x)
      assertXCrosspostInput(
        {
          crosspost,
          body: nextBody,
          visibility: nextVisibility,
          communityGroupId: resolvedGroupId,
          poll: nextPollJson,
          media: media ?? post.media,
        },
        this.appConfig.integrationBudget().enabled,
      );

    const updated = await this.prisma.$transaction(async (tx) => {
      const next = await tx.post.update({
        where: { id },
        data: {
          body: nextBody,
          scheduledRevision: { increment: 1 },
          scheduledAt: nextScheduledAt,
          crosspostChoices: params.crosspost,
          scheduledVisibility: resolvedGroupId ? "verifiedOnly" : nextVisibility,
          scheduledCommunityGroupId: resolvedGroupId,
          scheduledPollJson: nextPollJson ?? undefined,
          scheduledError: null,
          scheduledFailedAt: null,
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
        media: { orderBy: { position: "asc" } },
        mentions: { include: { user: { select: MENTION_USER_SELECT } } },
        scheduledCommunityGroup: {
          select: GROUP_REF_SELECT,
        },
      },
    });

    return toScheduledPostDto(full ?? updated, (this.appConfig.r2()?.publicBaseUrl ?? null));
  }
}


