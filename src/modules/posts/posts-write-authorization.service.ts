import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma, type PostVisibility } from "@prisma/client";
import { assertPublishableText } from "../../common/moderation/content-filter";
import { findGroupMemberStatus } from "../viewer/group-membership.queries";
import { requireAiConsent } from "../marvin/services/ai-consent";
import { PrismaService } from "../prisma/prisma.service";
import { ViewerContextService } from "../viewer/viewer-context.service";
import { AppConfigService } from "../app/app-config.service";
import { SiteConfigService } from "../site-config/site-config.service";
import { PostsViewerEnrichmentService } from "./posts-viewer-enrichment.service";
import { PostsMutationSupportService } from "./posts-mutation-support.service";
import { PostsCheckinWriteService } from "./posts-checkin-write.service";
import { PostsBoardWritePolicy } from "./posts-board-write.policy";
import { notDeletedWhere } from "./posts-query-builders";
import {
  postRateLimitFor,
  postRateLimitMessage,
  type PostRateLimit,
} from "./posts-rate-limit";
import type { CreatePostParams } from "./posts-mutation.types";

type PostWriteRateLimit = PostRateLimit & {
  windowStart: Date;
  where: Prisma.PostWhereInput;
};

/** Resolve who may publish, into which audience and thread, before opening a write transaction. */
@Injectable()
export class PostsWriteAuthorizationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly appConfig: AppConfigService,
    private readonly viewerContextService: ViewerContextService,
    @Inject(PostsViewerEnrichmentService)
    private readonly enrichment: Pick<
      PostsViewerEnrichmentService,
      "allowedVisibilitiesForViewer"
    >,
    private readonly siteConfig: SiteConfigService,
    @Inject(PostsMutationSupportService)
    private readonly support: Pick<
      PostsMutationSupportService,
      "parseMentionsFromBody"
    >,
    private readonly board: PostsBoardWritePolicy,
    private readonly checkins: PostsCheckinWriteService,
  ) {}

  async assertMarvAuthor(botUserId: string): Promise<void> {
    const cfg = this.appConfig.marvBot();
    const bot = await this.prisma.user.findUnique({
      where: { id: botUserId },
      select: { isBot: true, botType: true, username: true },
    });
    const matchesIdentity = cfg.userId
      ? cfg.userId === botUserId
      : bot?.username?.toLowerCase() === cfg.username.trim().toLowerCase();
    if (!bot?.isBot || bot.botType !== "marvin" || !matchesIdentity) {
      throw new ForbiddenException("Invalid Marv reply author.");
    }
  }

  async authorize(
    params: CreatePostParams,
    now: Date,
    marvRequesterId?: string,
  ) {
    const { userId, body, visibility: requestedVisibility, parentId } = params;
    assertPublishableText(
      body,
      params.checkinPrompt,
      params.board?.title,
      ...(params.poll?.options?.map((option) =>
        typeof option === "string" ? option : option.text,
      ) ?? []),
    );
    if (
      !marvRequesterId &&
      this.support
        .parseMentionsFromBody(body)
        .some(
          (username) =>
            username.toLowerCase() ===
            this.appConfig.marvBot().username.trim().toLowerCase(),
        )
    )
      await requireAiConsent(this.prisma, userId);
    const requestedCommunityGroupId =
      (params.communityGroupId ?? "").trim() || null;
    const requestedKind = params.kind ?? "regular";
    const checkinDayKeyRaw = (params.checkinDayKey ?? null)?.trim() || null;
    const checkinPromptRaw = (params.checkinPrompt ?? null)?.trim() || null;

    if (requestedKind === "checkin")
      this.checkins.validate(
        {
          visibility: requestedVisibility,
          communityGroupId: requestedCommunityGroupId,
          parentId,
          dayKey: checkinDayKeyRaw,
          prompt: checkinPromptRaw,
        },
        now,
      );

    if (requestedKind === "status") {
      if (requestedCommunityGroupId) {
        throw new BadRequestException(
          "Status posts cannot be posted inside a community group.",
        );
      }
      if (parentId)
        throw new BadRequestException("Status posts must be top-level.");
    }

    // Fetch viewer context (request-cached) and parent post in parallel.
    // Using viewerContextService populates the per-request cache so subsequent
    // `getViewer(userId)` calls (incl. the controller's `viewerContext()`) are free.
    const [author, parentPost] = await Promise.all([
      this.viewerContextService.getViewer(userId),
      parentId
        ? this.prisma.post.findFirst({
            where: { id: parentId, ...notDeletedWhere() },
            select: {
              id: true,
              body: true,
              mentions: { select: { userId: true } },
              userId: true,
              visibility: true,
              rootId: true,
              topics: true,
              communityGroupId: true,
              kind: true,
              articleId: true,
              user: { select: { isBot: true } },
            },
          })
        : Promise.resolve(null),
    ]);
    if (!author) throw new NotFoundException("User not found.");
    this.viewerContextService.assertNotBanned(author);
    const viewer = marvRequesterId
      ? await this.viewerContextService.getViewer(marvRequesterId)
      : author;
    if (!viewer) throw new NotFoundException("Requesting user not found.");
    this.viewerContextService.assertNotBanned(viewer);
    if (
      marvRequesterId &&
      (!parentPost || parentPost.userId !== marvRequesterId)
    ) {
      throw new ForbiddenException(
        "Marv can only reply to the requesting member’s post.",
      );
    }
    if (parentId && !parentPost) throw new NotFoundException("Post not found.");
    const { kind, boardOnly } = this.board.resolve(
      params,
      parentPost,
      marvRequesterId,
    );
    const user = {
      verifiedStatus: viewer.verifiedStatus,
      premium: viewer.premium,
      premiumPlus: viewer.premiumPlus,
    };
    const viewerIsVerified = Boolean(
      viewer.verifiedStatus && viewer.verifiedStatus !== "none",
    );

    // Product rule: unverified users cannot create new public feed posts.
    // (UI already hides this, but enforce on the API too.)
    if (
      !viewerIsVerified &&
      !parentId &&
      requestedVisibility === "public" &&
      !requestedCommunityGroupId
    ) {
      throw new ForbiddenException(
        "Verify your account to create public posts.",
      );
    }
    // Creation is gated by current tier: downgraded users can only create within their tier.
    const allowedForCreation =
      this.enrichment.allowedVisibilitiesForViewer(viewer);
    const skipTierVisibilityForCommunityGroupRoot = Boolean(
      !parentId && requestedCommunityGroupId,
    );
    if (
      requestedVisibility !== "onlyMe" &&
      !allowedForCreation.includes(requestedVisibility)
    ) {
      if (!skipTierVisibilityForCommunityGroupRoot) {
        if (requestedVisibility === "verifiedOnly")
          throw new ForbiddenException(
            "Verify your account to create verified-only posts.",
          );
        if (requestedVisibility === "premiumOnly")
          throw new ForbiddenException(
            "Upgrade to premium to create premium-only posts.",
          );
        throw new ForbiddenException(
          "You cannot create posts with that visibility.",
        );
      }
    }

    if (
      (requestedCommunityGroupId || parentPost?.communityGroupId) &&
      !viewerIsVerified
    ) {
      throw new ForbiddenException("Verify your account to post in groups.");
    }

    let visibility: PostVisibility = requestedVisibility;
    let resolvedCommunityGroupId: string | null = null;
    let threadParticipantIds: string[] = [];
    let parentAuthorUserId: string | null = null;
    let threadRootId: string | null = null; // Root post ID for thread hierarchy
    let parentTopics: string[] = [];
    let rootTopics: string[] = [];

    if (parentId && parentPost) {
      parentAuthorUserId = parentPost.userId;
      parentTopics = Array.isArray(parentPost.topics)
        ? (parentPost.topics as string[])
        : [];
      if (parentPost.visibility === "onlyMe") {
        throw new ForbiddenException(
          "Replies are not allowed on only-me posts.",
        );
      }
      const parentGid = parentPost.communityGroupId ?? null;
      const isCrossUser = Boolean(
        parentAuthorUserId && parentAuthorUserId !== userId,
      );
      // Use parent's rootId if it exists (parent is also a reply), otherwise parent.id is the root
      threadRootId =
        (parentPost as { rootId?: string | null }).rootId ?? parentPost.id;
      const needsRootTopics = Boolean(
        threadRootId && threadRootId !== parentPost.id,
      );

      // Fan out parent-dependent reads in one round trip:
      //   block check, group membership, root-for-topics, thread tree.
      const [blockCount, groupMember, rootForTopics, threadPosts] =
        await Promise.all([
          isCrossUser
            ? this.prisma.userBlock.count({
                where: {
                  OR: [
                    { blockerId: userId, blockedId: parentAuthorUserId! },
                    { blockerId: parentAuthorUserId!, blockedId: userId },
                  ],
                },
              })
            : Promise.resolve(0),
          parentGid
            ? findGroupMemberStatus(
                this.prisma,
                parentGid,
                marvRequesterId ?? userId,
              )
            : Promise.resolve(null),
          needsRootTopics
            ? this.prisma.post.findFirst({
                where: { id: threadRootId, ...notDeletedWhere() },
                select: { topics: true },
              })
            : Promise.resolve(null),
          this.prisma.post.findMany({
            where: {
              OR: [{ id: threadRootId }, { rootId: threadRootId }],
              ...notDeletedWhere(),
            },
            select: {
              id: true,
              parentId: true,
              userId: true,
              mentions: { select: { userId: true } },
            },
          }),
        ]);

      if (blockCount > 0)
        throw new ForbiddenException("You cannot reply to this post.");

      if (parentGid) {
        if (
          requestedCommunityGroupId &&
          requestedCommunityGroupId !== parentGid
        ) {
          throw new BadRequestException(
            "Invalid community group for this thread.",
          );
        }
        resolvedCommunityGroupId = parentGid;
        if (!groupMember || groupMember.status !== "active") {
          throw new ForbiddenException(
            "Join this group to reply in this thread.",
          );
        }
        visibility = "verifiedOnly";
      } else {
        if (requestedCommunityGroupId) {
          throw new BadRequestException(
            "This thread is not in a community group.",
          );
        }
        if (!viewerIsVerified && parentPost.visibility === "public") {
          throw new ForbiddenException(
            "Verify your account to reply publicly.",
          );
        }
        const allowed = this.enrichment.allowedVisibilitiesForViewer(viewer);
        const isSelf = parentPost.userId === userId;
        if (!isSelf) {
          if (!allowed.includes(parentPost.visibility)) {
            if (parentPost.visibility === "verifiedOnly")
              throw new ForbiddenException(
                "Verify to view verified-only posts.",
              );
            if (parentPost.visibility === "premiumOnly")
              throw new ForbiddenException(
                "Upgrade to premium to view premium-only posts.",
              );
            throw new ForbiddenException("Not allowed to reply to this post.");
          }
        }
        visibility = parentPost.visibility as PostVisibility;
      }

      rootTopics = needsRootTopics
        ? Array.isArray(rootForTopics?.topics)
          ? ((rootForTopics?.topics ?? []) as string[])
          : []
        : parentTopics;

      const participantIds = new Set<string>();
      for (const p of threadPosts) {
        participantIds.add(p.userId);
        for (const m of p.mentions) participantIds.add(m.userId);
      }
      threadParticipantIds = Array.from(participantIds);
    } else if (requestedCommunityGroupId) {
      resolvedCommunityGroupId = requestedCommunityGroupId;
      const mem = await findGroupMemberStatus(
        this.prisma,
        resolvedCommunityGroupId,
        userId,
      );
      if (!mem || mem.status !== "active") {
        throw new ForbiddenException("Join this group to post here.");
      }
      visibility = "verifiedOnly";
    }

    // Compute rate-limit window parameters synchronously; the actual count query is
    // batched in parallel with media-hash + mention resolution below.
    let rateLimitParams: PostWriteRateLimit | null = null;
    if (viewerIsVerified && !marvRequesterId) {
      const cfg = await this.siteConfig.get(); // in-memory cached; near-free
      const limit = postRateLimitFor({
        isReply: Boolean(parentId),
        isPremium: Boolean(user.premium || user.premiumPlus),
        cfg,
      });
      const windowStart = new Date(Date.now() - limit.windowSeconds * 1000);
      rateLimitParams = {
        ...limit,
        windowStart,
        where: {
          userId,
          createdAt: { gte: windowStart },
          visibility: { not: "onlyMe" },
          parentId: parentId ? { not: null } : null,
        },
      };
    }

    const viewerIsPremium = Boolean(user.premium || user.premiumPlus);
    const maxLen = viewerIsPremium || marvRequesterId ? 1000 : 500;
    if (body.length > maxLen) {
      throw new BadRequestException(
        maxLen === 1000
          ? "Posts are limited to 1000 characters."
          : "Posts are limited to 500 characters.",
      );
    }

    const media = (params.media ?? []).filter(Boolean);
    if (media.length > 4)
      throw new BadRequestException(
        "You can attach up to 4 images, GIFs, or videos.",
      );

    const poll = params.poll;
    if (poll && resolvedCommunityGroupId) {
      throw new BadRequestException(
        "Polls are not supported in community groups.",
      );
    }
    if (poll && parentId) {
      throw new ForbiddenException("Polls are not allowed on replies.");
    }
    if (poll && media.length > 0) {
      throw new BadRequestException("You cannot attach media to a poll post.");
    }
    // Product rule: polls require verified membership.
    if (poll && !viewerIsVerified) {
      throw new ForbiddenException("Verify your account to create polls.");
    }
    if (poll) {
      const endsAtMs =
        poll.endsAt instanceof Date
          ? poll.endsAt.getTime()
          : new Date(poll.endsAt as string | number).getTime();
      const now = Date.now();
      const maxMs = 7 * 24 * 60 * 60 * 1000;
      if (!Number.isFinite(endsAtMs) || endsAtMs <= now)
        throw new BadRequestException("Invalid poll duration.");
      if (endsAtMs > now + maxMs)
        throw new BadRequestException(
          "Poll duration must be 7 days or shorter.",
        );
      const opts = Array.isArray(poll.options) ? poll.options : [];
      if (opts.length < 2 || opts.length > 5)
        throw new BadRequestException("Poll must include 2 to 5 options.");
    }

    // Images/GIFs require verified; video requires premium.
    const hasVideo = media.some((m) => m.kind === "video");
    const hasImageOrGif = media.some((m) => m.kind !== "video");
    if (hasImageOrGif && !viewerIsVerified) {
      throw new ForbiddenException(
        "Verify your account to post images and GIFs.",
      );
    }
    if (hasVideo && !viewerIsPremium) {
      throw new ForbiddenException("Video posts are for premium members only.");
    }

    return {
      kind,
      boardOnly,
      visibility,
      resolvedCommunityGroupId,
      threadParticipantIds,
      parentAuthorUserId,
      threadRootId,
      parentTopics,
      rootTopics,
      rateLimitParams,
      checkinDayKey: checkinDayKeyRaw,
      checkinPrompt: checkinPromptRaw,
      parentIsBot: parentPost?.user?.isBot,
      authorIsBot: Boolean(author.isBot),
      authorVerifiedStatus: author.verifiedStatus,
    };
  }

  async assertRateLimit(
    limit: PostWriteRateLimit | null,
    recentPostCount: number,
  ): Promise<void> {
    if (limit && recentPostCount >= limit.postsPerWindow) {
      // The slot frees when the oldest post that still counts ages out of the window.
      const blocking = await this.prisma.post.findFirst({
        where: limit.where,
        orderBy: { createdAt: "asc" },
        skip: recentPostCount - limit.postsPerWindow,
        select: { createdAt: true },
      });
      const freesAt =
        (blocking?.createdAt.getTime() ?? Date.now()) +
        limit.windowSeconds * 1000;
      throw new HttpException(
        postRateLimitMessage(limit, (freesAt - Date.now()) / 1000),
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }
}
