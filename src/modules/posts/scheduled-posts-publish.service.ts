import { Injectable, Logger } from '@nestjs/common';
import { notDeletedWhere } from './posts-query-builders';
import { revalidateForPublish } from './scheduled-posts.policy';
import { AppConfigService } from '../app/app-config.service';
import { PickaxCrosspostService } from "../pickax/pickax-crosspost.service";
import { PostsMutationWriteService } from "./posts-mutation-write.service";
import { PresenceRealtimeService } from "../presence/presence-realtime.service";
import { PrismaService } from "../prisma/prisma.service";
import { XCrosspostService } from "../x/x-crosspost.service";
import type { PostVisibility } from "@prisma/client";
import { toPostDto } from "../../common/dto/post.dto";
import { NOT_DELETED } from '../../common/prisma/where';


/** Max rows processed across all users per cron sweep. */
const SWEEP_GLOBAL_LIMIT = 50;
/** Max rows processed per user per cron sweep — prevents one user monopolising a sweep. */
const SWEEP_PER_USER_LIMIT = 10;

@Injectable()
export class ScheduledPostsPublishService {
  private readonly logger = new Logger(ScheduledPostsPublishService.name);

  constructor(
    private readonly appConfig: AppConfigService,
    private readonly write: PostsMutationWriteService,
    private readonly pickax: PickaxCrosspostService,
    private readonly prisma: PrismaService,
    private readonly realtime: PresenceRealtimeService,
    private readonly x: XCrosspostService,
  ) {}

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
        media: { orderBy: { position: "asc" } },
      },
      orderBy: [{ scheduledAt: "asc" }, { id: "asc" }],
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

  async publishOne(post: Awaited<ReturnType<typeof this.prisma.post.findMany>>[0] & {
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
      select: {
        premium: true,
        premiumPlus: true,
        verifiedStatus: true,
        bannedAt: true,
      },
    });

    const revalError = revalidateForPublish(author, post);
    if (revalError) {
      this.logger.warn(`Scheduled post ${scheduledId} ineligible: ${revalError}`);
      const isFirstFailure = !post.scheduledError;
      await this.prisma.post.update({
        where: { id: scheduledId },
        data: {
          scheduledError: revalError.slice(0, 500),
          scheduledFailedAt: now,
        },
      });
      if (isFirstFailure) {
        this.realtime.emitScheduledPostFailed(userId, {
          scheduledId,
          error: revalError,
        });
      }
      return;
    }

    try {
      const visibility = (post.scheduledVisibility ?? "public") as PostVisibility;
      const communityGroupId = post.scheduledCommunityGroupId ?? null;

      // Build poll from stored JSON.
      const pollJson = post.scheduledPollJson as {
        options: { text: string }[];
        durationHours: number;
      } | null;
      let poll: {
        endsAt: Date;
        options: Array<{ text: string; image: null }>;
      } | null = null;
      if (pollJson?.options?.length) {
        const endsAt = new Date(
          now.getTime() + (pollJson.durationHours ?? 24) * 60 * 60 * 1000,
        );
        poll = {
          endsAt,
          options: pollJson.options.map((o) => ({ text: o.text, image: null })),
        };
      }

      // Replay createPost pipeline.
      const bundle = await this.write.createPost({
        scheduledSource: { id: scheduledId, revision: post.scheduledRevision },
        crosspost: (post.crosspostChoices ?? undefined) as
          | { pickax?: "link" | "native"; x?: "link" | "native" }
          | undefined,
        userId,
        body: post.body,
        visibility,
        parentId: null,
        mentions: null,
        communityGroupId,
        media: post.media.length
          ? post.media.map((m) => ({
              source:
                m.source === "giphy" ? ("giphy" as const) : ("upload" as const),
              kind: m.kind as "image" | "gif" | "video",
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

      // Men of Hunger owns the schedule: Pickax and X are queued only now, at fire time.
      // Failures here must not undo or fail the committed publication.
      const choices = post.crosspostChoices as {
        pickax?: "link" | "native";
        x?: "link" | "native";
      } | null;
      if (choices?.pickax) {
        await this.pickax
          .requestPostCrosspost(userId, bundle.post.id, choices.pickax)
          .catch((e) =>
            this.logger.warn(`Scheduled Pickax crosspost ${scheduledId}: ${e}`),
          );
      }
      if (choices?.x) {
        await this.x
          .requestPostCrosspost(userId, bundle.post.id, choices.x)
          .catch((e) =>
            this.logger.warn(`Scheduled X crosspost ${scheduledId}: ${e}`),
          );
      }

      // Notify the author that the post went live.
      const postDto = toPostDto(bundle.post, (this.appConfig.r2()?.publicBaseUrl ?? null));
      this.realtime.emitScheduledPostPublished(userId, {
        scheduledId,
        post: postDto,
      });

      this.logger.log(
        `Scheduled post ${scheduledId} published as ${bundle.post.id}`,
      );
    } catch (err) {
      // A committed publication or another worker's claim must never be restored.
      const current = await this.prisma.post.findUnique({
        where: { id: scheduledId },
        select: { deletedAt: true, scheduledPublishedPostId: true },
      });
      if (!current || current.deletedAt || current.scheduledPublishedPostId)
        return;
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `Failed to publish scheduled post ${scheduledId}: ${errorMsg}`,
      );

      // The atomic publication rolled back; retain its due date for recovery.
      await this.prisma.post.updateMany({
        where: {
          id: scheduledId,
          ...NOT_DELETED,
          scheduledPublishedPostId: null,
          scheduledRevision: post.scheduledRevision,
        },
        data: {
          scheduledError: errorMsg.slice(0, 500),
          scheduledFailedAt: now,
        },
      });

      this.realtime.emitScheduledPostFailed(userId, {
        scheduledId,
        error: errorMsg,
      });
    }
  }
}

