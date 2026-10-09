import { NotificationMarvWriterService } from "../notifications";
import { NotificationCreatorService } from "../notifications/notification-creator.service";
import { Injectable, Logger, Optional, Inject } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { PresenceRealtimeService } from "../presence/presence-realtime.service";
import { AppConfigService } from "../app/app-config.service";
import { JobsService } from "../jobs/jobs.service";
import { MarvinBotIdentityService } from "../marvin/services/marvin-bot-identity.service";
import { SideEffectsService } from "../side-effects/side-effects.service";
import type { PostVisibility } from "@prisma/client";
import { toPostDto } from "../../common/dto/post.dto";
import { parseMentionsFromBody } from "../../common/mentions/mention-regex";
import { JOBS } from "../jobs/jobs.constants";
import {
  MarvinAddressingService,
  isAddressedToMarv,
} from "../marvin/services/marvin-addressing.service";
import { FANOUT_CONCURRENCY, runInBatches } from "../side-effects/batch";
import { chunk } from "../../common/arrays/chunk";
import {
  FANOUT_CHUNK_SIZE,
  FANOUT_CHUNK_THRESHOLD,
} from "../side-effects/side-effects.constants";
import { resolveMentionUsernames } from "./posts-mentions.helpers";
import { notDeletedWhere } from "./posts-query-builders";
import {
  findGroupMemberStatus,
  listTierEligibleGroupMemberIds,
} from "../viewer/group-membership.queries";
import {
  type ReplyRole,
  type ThreadPostForRoles,
  type PostWithRelations,
} from "./posts-side-effects.constants";
import { NOT_DELETED } from "../../common/prisma/where";

@Injectable()
export class PostsCreatedEffectsService {
  private readonly logger = new Logger(PostsCreatedEffectsService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(NotificationCreatorService)
    private readonly notificationCreatorService: Pick<
      NotificationCreatorService,
      "create"
    >,
    @Inject(NotificationMarvWriterService)
    private readonly notificationWriterService: Pick<
      NotificationMarvWriterService,
      "upsertMarvNotInGroupNotification"
    >,
    private readonly presenceRealtime: PresenceRealtimeService,
    private readonly appConfig: AppConfigService,
    private readonly jobs: JobsService,
    private readonly marvIdentity: MarvinBotIdentityService,
    private readonly sideEffects: SideEffectsService,
    @Optional() private readonly marvAddressing?: MarvinAddressingService,
  ) {}

  async loadParentAuthorUserId(
    parentId: string | null,
  ): Promise<string | null> {
    if (!parentId) return null;
    const parent = await this.prisma.post.findFirst({
      where: { id: parentId },
      select: { userId: true },
    });
    return parent?.userId ?? null;
  }

  async loadThreadPostsForRoles(
    post: PostWithRelations,
  ): Promise<ThreadPostForRoles[]> {
    if (!post.parentId) return [];
    const rootId = post.rootId ?? post.parentId;
    return await this.prisma.post.findMany({
      where: { OR: [{ id: rootId }, { rootId }], ...notDeletedWhere() },
      select: {
        id: true,
        parentId: true,
        userId: true,
        mentions: { select: { userId: true } },
      },
    });
  }

  async loadBodyMentionIds(body: string): Promise<string[]> {
    const usernames = parseMentionsFromBody(body);
    if (usernames.length === 0) return [];
    const ids = await resolveMentionUsernames(this.prisma, usernames);
    return [...new Set(ids)];
  }

  async loadQuotedInfo(
    quotedPostId: string | null,
  ): Promise<{ quotedAuthorId: string; quotedPostId: string } | null> {
    if (!quotedPostId) return null;
    const quoted = await this.prisma.post.findFirst({
      where: { id: quotedPostId, ...NOT_DELETED },
      select: { id: true, userId: true },
    });
    if (!quoted) return null;
    return { quotedAuthorId: quoted.userId, quotedPostId: quoted.id };
  }

  async emitTierScopedGroupNewPost(post: PostWithRelations): Promise<void> {
    const groupId = post.communityGroupId ?? null;
    const visibility = post.visibility as string;
    if (
      post.parentId ||
      !groupId ||
      visibility === "public" ||
      visibility === "verifiedOnly"
    )
      return;

    const tierScoped =
      visibility === "premiumOnly" || visibility === "verifiedOnly";
    if (!tierScoped) return;

    try {
      const eligible = await listTierEligibleGroupMemberIds(
        this.prisma,
        groupId,
        visibility,
      );
      if (eligible.length === 0) return;

      const groupPostDto = toPostDto(
        post,
        this.appConfig.r2()?.publicBaseUrl ?? null,
        {
          viewerHasBoosted: false,
          includeInternal: false,
        },
      );
      this.presenceRealtime.emitGroupNewPost(
        groupId,
        { groupId, post: groupPostDto },
        { eligibleMemberUserIds: eligible },
      );
    } catch (err) {
      this.logger.warn(
        `[groups] Failed tier-scoped groups:newPost for post ${post.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  computeThreadRolesFromPosts(
    threadPosts: ThreadPostForRoles[],
    parentId: string,
  ): Map<string, ReplyRole> {
    const map = new Map<string, ReplyRole>();
    const byId = new Map(threadPosts.map((p) => [p.id, p]));
    let currentId: string | null = parentId;
    while (currentId) {
      const post = byId.get(currentId);
      if (!post) break;
      const isRoot = !post.parentId;
      const authorRole: ReplyRole = isRoot ? "root_author" : "reply_author";
      const mentionRole: ReplyRole = isRoot
        ? "mentioned_in_root"
        : "mentioned_in_reply";
      if (!map.has(post.userId)) map.set(post.userId, authorRole);
      for (const m of post.mentions) {
        if (!map.has(m.userId)) map.set(m.userId, mentionRole);
      }
      currentId = post.parentId;
    }
    return map;
  }

  async fanOutFollowerPostNotifications(args: {
    recipientUserIds: string[];
    kind: "followed_post" | "checkin_post";
    actorUserId: string;
    postId: string;
    bodySnippet: string;
  }): Promise<void> {
    const { recipientUserIds, kind, actorUserId, postId, bodySnippet } = args;
    if (recipientUserIds.length === 0) return;

    if (recipientUserIds.length > FANOUT_CHUNK_THRESHOLD) {
      for (const slice of chunk(recipientUserIds, FANOUT_CHUNK_SIZE)) {
        this.sideEffects.dispatch("notification.fanout.chunk", {
          kind,
          recipientUserIds: slice,
          actorUserId,
          actorPostId: postId,
          subjectPostId: postId,
          subjectUserId: actorUserId,
          subjectArticleId: null,
          subjectGroupId: null,
          title: null,
          body: bodySnippet || null,
        });
      }
      return;
    }

    await runInBatches(
      recipientUserIds,
      FANOUT_CONCURRENCY,
      async (recipientUserId) => {
        await this.notificationCreatorService
          .create({
            recipientUserId,
            kind,
            actorUserId,
            actorPostId: postId,
            subjectPostId: postId,
            subjectUserId: actorUserId,
            body: bodySnippet || undefined,
          })
          .catch((err) => {
            this.logger.warn(
              `[notifications] Failed to create followed-post notification: ${err instanceof Error ? err.message : String(err)}`,
            );
          });
      },
    );
  }

  async clearCheckinReminder(userId: string): Promise<void> {
    const existing = await this.prisma.notification.findMany({
      where: { kind: "checkin_reminder", recipientUserId: userId },
      select: { id: true, deliveredAt: true },
    });
    if (existing.length === 0) return;

    await this.prisma.notification.deleteMany({
      where: { kind: "checkin_reminder", recipientUserId: userId },
    });

    const unreadCount = existing.filter((n) => n.deliveredAt === null).length;
    if (unreadCount > 0) {
      await this.prisma.user.update({
        where: { id: userId },
        data: { undeliveredNotificationCount: { decrement: unreadCount } },
      });
    }

    const undeliveredCount = await this.prisma.notification
      .count({ where: { recipientUserId: userId, deliveredAt: null } })
      .catch(() => 0);
    this.presenceRealtime.emitNotificationsUpdated(userId, {
      undeliveredCount,
    });
    this.presenceRealtime.emitNotificationsDeleted(userId, {
      notificationIds: existing.map((n) => n.id),
    });
  }

  async maybeEnqueueMarvReply(args: {
    post: PostWithRelations;
    actorUserId: string;
    bodySnippet: string;
    visibility: PostVisibility;
    requestedMarvMode: "fast" | "regular" | "smart" | null;
    addedMentionIds?: string[];
  }): Promise<void> {
    const { post, actorUserId, bodySnippet, visibility, requestedMarvMode } =
      args;
    try {
      const marvCfg = this.appConfig.marvBot();
      if (!marvCfg.enabled) {
        this.logger.log(
          `[marv] mention-detect post=${post.id} skip reason=marv_disabled`,
        );
        return;
      }

      const marvUsernameLower = marvCfg.username.trim().toLowerCase();
      const bodyMentions = parseMentionsFromBody(post.body ?? "").map((u) =>
        u.trim().toLowerCase(),
      );
      const bodyMentionUsernamesLower = new Set(bodyMentions);
      let resolvedMarvId =
        this.marvIdentity.cachedMarvUserId() ?? marvCfg.userId ?? null;
      const mentionsMarv = bodyMentionUsernamesLower.has(marvUsernameLower);

      if (post.kind === "board") {
        resolvedMarvId ??= await this.marvIdentity
          .getMarvUserId()
          .catch(() => null);
        const resolvedMention = post.mentions?.some(
          (mention) => mention.user.id === resolvedMarvId,
        );
        if (
          !mentionsMarv ||
          !resolvedMarvId ||
          !resolvedMention ||
          (args.addedMentionIds &&
            !args.addedMentionIds.includes(resolvedMarvId))
        )
          return;
      }

      let addressedByJev = false;
      if (!mentionsMarv) {
        addressedByJev =
          post.kind !== "board" &&
          (await this.isUntaggedAddressToMarv(
            post,
            actorUserId,
            resolvedMarvId,
          ));
        if (!addressedByJev) {
          this.logger.log(
            `[marv] mention-detect post=${post.id} skip reason=no_mention`,
          );
          return;
        }
      }

      const actorIsMarv = Boolean(
        resolvedMarvId && actorUserId === resolvedMarvId,
      );
      if (actorIsMarv) {
        this.logger.log(
          `[marv] mention-detect post=${post.id} skip reason=actor_is_marv`,
        );
        return;
      }

      const rootPostId = post.rootId ?? post.id;
      const postGroupId = post.communityGroupId ?? null;

      // If this post is inside a community group, check whether Marv is an active member.
      // If he isn't, send a one-time informational notification instead of a reply.
      if (postGroupId) {
        const marvId =
          resolvedMarvId ?? (await this.marvIdentity.getMarvUserId());
        if (marvId) {
          const marvMembership = await findGroupMemberStatus(
            this.prisma,
            postGroupId,
            marvId,
          );
          if (marvMembership?.status !== "active") {
            this.logger.log(
              `[marv] mention-detect post=${post.id} skip reason=marv_not_in_group groupId=${postGroupId}`,
            );
            await this.notificationWriterService
              .upsertMarvNotInGroupNotification({
                recipientUserId: actorUserId,
                marvUserId: marvId,
                postId: post.id,
                groupId: postGroupId,
              })
              .catch(() => undefined);
            return;
          }
        }
      }

      this.logger.log(
        `[marv] mention-detect post=${post.id} HIT enqueueing root=${rootPostId} actor=${actorUserId} requestedMode=${requestedMarvMode ?? "null"}`,
      );
      await this.jobs
        .enqueue(
          JOBS.marvinReplyPublic,
          {
            postId: post.id,
            rootPostId,
            requestingUserId: actorUserId,
            requestedMode: requestedMarvMode,
            bodySnippet,
            visibility,
            ...(addressedByJev ? { addressedBy: "jev" as const } : {}),
          },
          {
            // Stable job id per post so a retried side-effect job doesn't enqueue Marv twice.
            jobId: `marv-public-${post.id}`,
            removeOnComplete: true,
            removeOnFail: false,
            attempts: 3,
            backoff: { type: "exponential" as const, delay: 5000 },
          },
        )
        .then(() => {
          this.logger.log(`[marv] mention-detect post=${post.id} enqueued ok`);
        })
        .catch((err) => {
          this.logger.warn(
            `[marv] Failed to enqueue public reply job for post=${post.id}: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
    } catch (err) {
      this.logger.warn(
        `[marv] mention-detection during side-effects failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async isUntaggedAddressToMarv(
    post: PostWithRelations,
    actorUserId: string,
    marvId: string | null,
  ): Promise<boolean> {
    const addressing = this.marvAddressing;
    if (!addressing?.available() || !post.body?.trim()) return false;
    if (actorUserId === marvId) return false;

    const parent = post.parentId
      ? await this.prisma.post.findFirst({
          where: { id: post.parentId, ...NOT_DELETED },
          select: {
            body: true,
            userId: true,
            user: { select: { username: true, name: true } },
          },
        })
      : null;
    const parentIsMarv = Boolean(parent && marvId && parent.userId === marvId);
    if (!MarvinAddressingService.isCandidate(post.body, parentIsMarv))
      return false;

    // A person named Marv in this conversation: the parent's author, or someone @-tagged here.
    const otherMarvs = [
      ...(parent?.user && !parentIsMarv ? [parent.user] : []),
      ...(post.mentions ?? [])
        .filter((m) => m.user.id !== marvId)
        .map((m) => m.user),
    ]
      .filter((u) => MarvinAddressingService.namedLikeMarv(u))
      .map((u) => u.username ?? "");

    const probability = await addressing.addressedToMarvProbability({
      text: post.body,
      otherMarvs,
      parent: parent
        ? {
            text: parent.body ?? "",
            authorIsMarv: parentIsMarv,
            authorIsSpeaker: parent.userId === actorUserId,
          }
        : null,
    });
    this.logger.log(
      `[marv] addressing post=${post.id} parentIsMarv=${parentIsMarv} p=${probability ?? "n/a"}`,
    );
    return isAddressedToMarv(probability, otherMarvs);
  }
}
