import { assertXCrosspostInput } from "../../common/crosspost/x-crosspost-input";
import { boardMarvReplyId } from "../marvin/services/board-marv-reply-id";
import { captureMemberParticipation } from "../../common/posthog/member-participation";
import { assertPublishableText } from "../../common/moderation/content-filter";
import { requireAiConsent } from "../marvin/services/ai-consent";
import { isCheckinOpen, CHECKIN_CLOSED_MESSAGE } from "../checkins/checkin-schedule";
import { BadRequestException, ForbiddenException, HttpException, HttpStatus, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { Prisma, type PostVisibility } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { PresenceRealtimeService } from "../presence/presence-realtime.service";
import { ViewerContextService } from "../viewer/viewer-context.service";
import { AppConfigService } from "../app/app-config.service";
import { CacheInvalidationService } from "../redis/cache-invalidation.service";
import { MENTION_USER_SELECT, USER_LIST_SELECT } from "../../common/prisma-selects/user.select";
import { TickerService } from "../cashtags/ticker.service";
import { inferTopicsFromText } from "../../common/topics/topic-utils";
import { easternDayKey, yesterdayEasternDayKey } from "../../common/time/eastern-day-key";
import { computeCheckinRewards } from "../checkins/checkin-rewards";
import { toPostDto } from "../../common/dto/post.dto";
import { BOARD_THREAD_PREVIEW_INCLUDE } from "../../common/prisma-includes/post.include";
import { LOGGED_IN_VIEW_WEIGHT } from "../views/view-tracking.utils";
import { PostViewsService } from "../post-views/post-views.service";
import { PosthogService } from "../../common/posthog/posthog.service";
import { notDeletedWhere } from "./posts-query-builders";
import { excludeMarvUserId } from "./posts-mentions.helpers";
import { PostsRankingService } from "./posts-ranking.service";
import { PostsViewerEnrichmentService } from "./posts-viewer-enrichment.service";
import { SiteConfigService } from "../site-config/site-config.service";
import { SideEffectsService } from "../side-effects/side-effects.service";
import { PostsTopicsClassifyService } from "./posts-topics-classify.service";
import { postRateLimitFor, postRateLimitMessage, type PostRateLimit } from "./posts-rate-limit";
import { PostsMutationSupportService } from "./posts-mutation-support.service";
import { cleanMutationMediaAndPoll } from "./posts-mutation-media";
import type { CreatePostParams } from "./posts-mutation.types";

@Injectable()
export class PostsMutationWriteService {
  private readonly logger = new Logger(PostsMutationWriteService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly presenceRealtime: PresenceRealtimeService,
    private readonly cacheInvalidation: CacheInvalidationService,
    private readonly appConfig: AppConfigService,
    private readonly postViews: PostViewsService,
    private readonly posthog: PosthogService,
    private readonly viewerContextService: ViewerContextService,
    private readonly enrichment: PostsViewerEnrichmentService,
    private readonly ranking: PostsRankingService,
    private readonly ticker: TickerService,
    private readonly siteConfig: SiteConfigService,
    private readonly sideEffects: SideEffectsService,
    private readonly topicsClassify: PostsTopicsClassifyService,
    private readonly support: PostsMutationSupportService,
  ) {}
  async createPost(params: CreatePostParams) {
    // Old scheduled selections still publish locally; the X worker rechecks the latest content.
    if (!params.scheduledSource && params.crosspost?.x)
      assertXCrosspostInput(params, this.appConfig.integrationBudget().enabled);
    return this.writePost(params);
  }

  /** Internal reply path: only the configured bot, inside the requesting author's thread. */
  async createMarvReply(params: {
    botUserId: string;
    requestingUserId: string;
    parentId: string;
    body: string;
  }) {
    const cfg = this.appConfig.marvBot();
    const bot = await this.prisma.user.findUnique({
      where: { id: params.botUserId },
      select: { isBot: true, botType: true, username: true },
    });
    const matchesIdentity = cfg.userId
      ? cfg.userId === params.botUserId
      : bot?.username?.toLowerCase() === cfg.username.trim().toLowerCase();
    if (!bot?.isBot || bot.botType !== "marvin" || !matchesIdentity) {
      throw new ForbiddenException("Invalid Marv reply author.");
    }
    return this.writePost(
      {
        userId: params.botUserId,
        body: params.body,
        parentId: params.parentId,
        visibility: "public",
        media: null,
        poll: null,
      },
      params.requestingUserId,
    );
  }

  private async writePost(params: CreatePostParams, marvRequesterId?: string) {
    const {
      userId,
      body,
      visibility: requestedVisibility,
      parentId,
      mentions: clientMentions,
    } = params;
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
      this.support.parseMentionsFromBody(body).some(
        (username) =>
          username.toLowerCase() ===
          this.appConfig.marvBot().username.trim().toLowerCase(),
      )
    )
      await requireAiConsent(this.prisma, userId);
    const requestedMarvMode = params.marvMode ?? null;
    const requestedCommunityGroupId =
      (params.communityGroupId ?? "").trim() || null;
    let kind = (params.kind ?? "regular") as
      | "regular"
      | "checkin"
      | "status"
      | "board";
    const now = new Date();
    const checkinDayKeyRaw = (params.checkinDayKey ?? null)?.trim() || null;
    const checkinPromptRaw = (params.checkinPrompt ?? null)?.trim() || null;

    if (kind === "checkin") {
      if (!isCheckinOpen(now))
        throw new BadRequestException(CHECKIN_CLOSED_MESSAGE);
      if (requestedCommunityGroupId) {
        throw new BadRequestException(
          "Check-ins cannot be posted inside a community group.",
        );
      }
      if (parentId)
        throw new BadRequestException("Check-ins must be top-level posts.");
      if (
        requestedVisibility !== "verifiedOnly" &&
        requestedVisibility !== "premiumOnly"
      ) {
        throw new BadRequestException(
          "Check-ins must be verified-only or premium-only.",
        );
      }
      const todayKey = easternDayKey(now);
      if (!checkinDayKeyRaw || checkinDayKeyRaw !== todayKey) {
        throw new BadRequestException("Invalid check-in day.");
      }
      if (!checkinPromptRaw)
        throw new BadRequestException("Check-in prompt is required.");
    }

    if (kind === "status") {
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
    // Every reply inside a Board thread is a Board comment, whichever client sent it.
    if (parentPost?.kind === "board") {
      kind = "board";
      if (marvRequesterId) {
        const explicit = this.support.parseMentionsFromBody(parentPost.body).some(
          (name) =>
            name.toLowerCase() ===
            this.appConfig.marvBot().username.trim().toLowerCase(),
        );
        if (
          !explicit ||
          !parentPost.mentions.some((mention) => mention.userId === userId)
        ) {
          throw new ForbiddenException(
            "This Board item no longer mentions Marv.",
          );
        }
      }
    }
    if (
      parentPost?.kind === "board" &&
      !parentPost.rootId &&
      parentPost.articleId
    ) {
      throw new BadRequestException("Comment on the article instead.");
    }
    if (kind === "board") {
      if (requestedCommunityGroupId)
        throw new BadRequestException(
          "Board posts cannot be posted inside a community group.",
        );
      if (params.poll)
        throw new BadRequestException("Polls are not supported on the Board.");
      if (!parentId && !params.board?.title?.trim())
        throw new BadRequestException("Board posts need a title.");
      if (parentId && params.board)
        throw new BadRequestException(
          "Board comments cannot carry thread fields.",
        );
      if (requestedVisibility === "onlyMe")
        throw new BadRequestException("Board posts cannot be only-me.");
    }
    const boardOnly =
      kind === "board" &&
      (Boolean(parentId) || params.board?.showInFeed === false);
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
            ? this.prisma.communityGroupMember.findUnique({
                where: {
                  groupId_userId: {
                    groupId: parentGid,
                    userId: marvRequesterId ?? userId,
                  },
                },
                select: { status: true },
              })
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
      const mem = await this.prisma.communityGroupMember.findUnique({
        where: {
          groupId_userId: { groupId: resolvedCommunityGroupId, userId },
        },
        select: { status: true },
      });
      if (!mem || mem.status !== "active") {
        throw new ForbiddenException("Join this group to post here.");
      }
      visibility = "verifiedOnly";
    }

    // Compute rate-limit window parameters synchronously; the actual count query is
    // batched in parallel with media-hash + mention resolution below.
    let rateLimitParams:
      | (PostRateLimit & { windowStart: Date; where: Prisma.PostWhereInput })
      | null = null;
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

    const allowedImagePrefixes = [
      `uploads/${userId}/images/`,
      `dev/uploads/${userId}/images/`,
    ];
    const allowedVideoPrefixes = [
      `uploads/${userId}/videos/`,
      `dev/uploads/${userId}/videos/`,
    ];
    const allowedThumbnailPrefixes = [
      `uploads/${userId}/thumbnails/`,
      `dev/uploads/${userId}/thumbnails/`,
    ];

    // Keys that exist in MediaContentHash (reused uploads from any user) are allowed.
    const pollImageKeys = (poll?.options ?? [])
      .map((o) => (o?.image?.r2Key ?? "").trim())
      .filter(Boolean);
    const uploadKeys = [
      ...media
        .filter((m) => m.source === "upload" && (m.r2Key ?? "").trim())
        .map((m) => (m.r2Key ?? "").trim()),
      ...pollImageKeys,
    ];

    // Pre-compute mention username sets so we can do the rate-limit count, media-hash
    // lookup and (single) mention resolution in one round trip.
    const fromBody = this.support.parseMentionsFromBody(body);
    const clientUsernames = Array.isArray(clientMentions)
      ? clientMentions.filter((x) => typeof x === "string" && x.length <= 120)
      : [];
    const allUsernames = [...new Set([...clientUsernames, ...fromBody])];

    const [recentPostCount, reusedKeyRows, mentionUsernameToId] =
      await Promise.all([
        rateLimitParams
          ? this.prisma.post.count({ where: rateLimitParams.where })
          : Promise.resolve(0),
        uploadKeys.length
          ? this.prisma.mediaContentHash.findMany({
              where: { r2Key: { in: uploadKeys } },
              select: { r2Key: true },
            })
          : Promise.resolve([] as Array<{ r2Key: string }>),
        // Single resolution covers both body mentions and thread-participant client mentions.
        this.support.resolveMentionUsernamesMap(allUsernames),
      ]);

    if (rateLimitParams && recentPostCount >= rateLimitParams.postsPerWindow) {
      // The slot frees when the oldest post that still counts ages out of the window.
      const blocking = await this.prisma.post.findFirst({
        where: rateLimitParams.where,
        orderBy: { createdAt: "asc" },
        skip: recentPostCount - rateLimitParams.postsPerWindow,
        select: { createdAt: true },
      });
      const freesAt =
        (blocking?.createdAt.getTime() ?? Date.now()) +
        rateLimitParams.windowSeconds * 1000;
      throw new HttpException(
        postRateLimitMessage(rateLimitParams, (freesAt - Date.now()) / 1000),
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const { cleanedMedia, cleanedPollOptions } = cleanMutationMediaAndPoll({
      media,
      poll,
      reusedKeyRows,
      allowedImagePrefixes,
      allowedVideoPrefixes,
      allowedThumbnailPrefixes,
    });

    // Body-only mention ids used to be derived here for notification priority; that now happens
    // in PostsSideEffectsHandler, which re-parses the persisted body. Only the full resolved set
    // (for the PostMention rows) is still needed on the request path.
    const resolvedFromUsernames: string[] = [];
    {
      const seen = new Set<string>();
      const normAll = [
        ...new Set(
          allUsernames.map((u) => u.trim().slice(0, 120)).filter(Boolean),
        ),
      ];
      for (const name of normAll) {
        const id = mentionUsernameToId.get(name.toLowerCase());
        if (id && !seen.has(id)) {
          seen.add(id);
          resolvedFromUsernames.push(id);
        }
      }
    }

    // All mention IDs for PostMention records (include self so @yourname renders as a link).
    // Marv is not inherited from the thread — only an explicit @marv (in body or client list)
    // should create a mention row for him.
    const marvCfg = this.appConfig.marvBot();
    const marvId =
      marvCfg.userId ??
      mentionUsernameToId.get(marvCfg.username.trim().toLowerCase()) ??
      null;
    const mentionUserIds = [
      ...new Set([
        ...excludeMarvUserId(threadParticipantIds, marvId),
        ...resolvedFromUsernames,
      ]),
    ];

    const hashtagTokensRaw = this.support.parseHashtagsFromBody(body);
    const hashtagTokens = hashtagTokensRaw
      .map((t) => ({
        tag: (t.tag ?? "").trim().toLowerCase(),
        variant: (t.variant ?? "").trim(),
      }))
      .filter((t) => Boolean(t.tag && t.variant));
    hashtagTokens.sort(
      (a, b) =>
        a.tag.localeCompare(b.tag) || a.variant.localeCompare(b.variant),
    );
    const hashtags = hashtagTokens.map((t) => t.tag);
    const hashtagCasings = hashtagTokens.map((t) => t.variant);
    const cashtags = this.support.parseCashtagsFromBody(body);

    let parentCommentCount: number | null = null;
    let boardRootCommentCount: number | null = null;
    const boardRootToBump =
      kind === "board" && parentId && threadRootId && threadRootId !== parentId
        ? threadRootId
        : null;
    let didAwardStreak = false;
    let streakRewardOut: {
      coinsEarned: number;
      streakDays: number;
      multiplier: 1 | 2 | 3 | 4;
    } | null = null;
    const quotedPostInfoRef: {
      current: { quotedAuthorId: string; quotedPostId: string } | null;
    } = { current: null };
    const post = await this.prisma
      .$transaction(async (tx) => {
        if (params.scheduledSource) {
          const claim = await tx.post.updateMany({
            where: {
              id: params.scheduledSource.id,
              userId,
              scheduledRevision: params.scheduledSource.revision,
              isDraft: true,
              deletedAt: null,
              scheduledAt: { not: null, lte: now },
              scheduledPublishedPostId: null,
            },
            data: { deletedAt: now, scheduledAt: null },
          });
          if (!claim.count)
            throw new BadRequestException(
              "Scheduled post changed or was already published.",
            );
        }
        const relatedTopics = Array.from(
          new Set([...(parentTopics ?? []), ...(rootTopics ?? [])]),
        ).filter(Boolean);
        const topics = inferTopicsFromText(body, { hashtags, relatedTopics });

        // Detect embedded post link in body up front so we can include `quotedPostId` in the
        // initial create (saves one extra `tx.post.update` round trip when present).
        const detectedQuotedPostId = this.support.extractQuotedPostIdFromBody(body);
        const quotedExists = detectedQuotedPostId
          ? await tx.post.findFirst({
              where: { id: detectedQuotedPostId, deletedAt: null },
              select: {
                id: true,
                userId: true,
                visibility: true,
                communityGroupId: true,
              },
            })
          : null;
        const quotedPostIdToSet = quotedExists ? quotedExists.id : null;

        // Quote floor: the quoting post's effective visibility must not be more open than
        // the quoted post's visibility.  Applied universally — replies, group posts, and
        // check-ins are no longer bypassed.
        //
        // `visibility` is already the effective value: parentPost.visibility for replies,
        // 'verifiedOnly' for group posts, requestedVisibility otherwise.
        //
        // Exception: a group post quoting a post that lives in the same group is allowed
        // because every member of the group has read access regardless of their tier.
        if (quotedExists) {
          const sameGroup =
            resolvedCommunityGroupId &&
            quotedExists.communityGroupId === resolvedCommunityGroupId;
          if (
            !sameGroup &&
            this.support.visibilityRank(visibility) <
              this.support.visibilityRank(quotedExists.visibility)
          ) {
            throw new ForbiddenException(
              "A quote can't be more public than the post it quotes.",
            );
          }
        }

        const created = await tx.post.create({
          data: {
            crosspostChoices: params.crosspost,
            ...(marvRequesterId && kind === "board" && parentId
              ? { id: boardMarvReplyId(parentId) }
              : {}),
            body,
            topics,
            hashtags,
            hashtagCasings,
            cashtags,
            visibility,
            userId,
            kind,
            ...(boardOnly ? { boardOnly: true } : {}),
            ...(kind === "board" && !parentId && params.board
              ? {
                  boardThread: {
                    create: {
                      title: params.board.title.trim(),
                      url: params.board.url,
                      urlNormalized: params.board.urlNormalized,
                      domain: params.board.domain,
                      tags: params.board.tags,
                      showInFeed: params.board.showInFeed,
                    },
                  },
                  ...(params.articleId ? { articleId: params.articleId } : {}),
                }
              : {}),
            ...(resolvedCommunityGroupId
              ? { communityGroupId: resolvedCommunityGroupId }
              : {}),
            ...(kind === "checkin"
              ? {
                  checkinDayKey: checkinDayKeyRaw ?? undefined,
                  checkinPrompt: checkinPromptRaw ?? undefined,
                }
              : {}),
            parentId: parentId ?? undefined,
            rootId: threadRootId ?? undefined, // Set root post ID for thread hierarchy
            ...(quotedPostIdToSet ? { quotedPostId: quotedPostIdToSet } : {}),
            ...(cleanedMedia.length
              ? {
                  media: {
                    create: cleanedMedia,
                  },
                }
              : {}),
            ...(mentionUserIds.length
              ? {
                  // Nested-create mentions in the same query so the response includes them
                  // and we don't need a post-transaction findUnique to fetch them.
                  mentions: {
                    create: mentionUserIds.map((uid) => ({ userId: uid })),
                  },
                }
              : {}),
            ...(poll
              ? {
                  poll: {
                    create: {
                      endsAt: poll.endsAt,
                      ...(cleanedPollOptions?.length
                        ? {
                            options: {
                              create: cleanedPollOptions.map((o) => ({
                                text: o.text,
                                position: o.position,
                                imageR2Key: o.imageR2Key ?? undefined,
                                imageWidth: o.imageWidth ?? undefined,
                                imageHeight: o.imageHeight ?? undefined,
                                imageAlt: o.imageAlt ?? undefined,
                              })),
                            },
                          }
                        : {}),
                    },
                  },
                }
              : {}),
          },
          include: {
            user: { select: USER_LIST_SELECT },
            media: { orderBy: { position: "asc" } },
            mentions: { include: { user: { select: MENTION_USER_SELECT } } },
            poll: { include: { options: { orderBy: { position: "asc" } } } },
            boardThread: BOARD_THREAD_PREVIEW_INCLUDE,
          },
        });

        if (params.scheduledSource) {
          await tx.post.update({
            where: { id: params.scheduledSource.id },
            data: { scheduledPublishedPostId: created.id },
          });
        }
        if (quotedExists) {
          // Store for post-transaction notification (avoid sending inside the transaction).
          quotedPostInfoRef.current = {
            quotedAuthorId: quotedExists.userId,
            quotedPostId: quotedExists.id,
          };
        }

        // Streak rewards: check-in posts only, once per ET day. Regular posts/replies do not count.
        // CAS guard: updateMany with WHERE lastCheckinDayKey = prevKey prevents a double-award when two
        // concurrent check-ins run the check at the same time. Only the first writer wins count === 1.
        const streakOp =
          kind === "checkin" && visibility !== "onlyMe"
            ? (async () => {
                const todayKey = easternDayKey(now);
                const yesterdayKey = yesterdayEasternDayKey(now);
                const u = await tx.user.findUnique({
                  where: { id: userId },
                  select: {
                    coins: true,
                    checkinStreakDays: true,
                    lastCheckinDayKey: true,
                    longestStreakDays: true,
                  },
                });
                if (!u) throw new NotFoundException("User not found.");
                const prevKey = u.lastCheckinDayKey ?? null;
                if (prevKey === todayKey) return; // already awarded today
                const out = computeCheckinRewards({
                  todayKey,
                  yesterdayKey,
                  lastCheckinDayKey: prevKey,
                  currentStreakDays: u.checkinStreakDays ?? 0,
                });
                const nextLongest = Math.max(
                  u.longestStreakDays ?? 0,
                  out.nextStreakDays,
                );
                // Atomic compare-and-swap: only apply when lastCheckinDayKey hasn't changed.
                // If another concurrent post already set it to todayKey, count === 0 and we bail.
                const claim = await tx.user.updateMany({
                  where: { id: userId, lastCheckinDayKey: prevKey },
                  data: {
                    lastCheckinDayKey: todayKey,
                    checkinStreakDays: out.nextStreakDays,
                    longestStreakDays: nextLongest,
                    coins: { increment: out.coinsAdd },
                  },
                });
                if (claim.count === 0) return; // concurrent post already awarded today — skip
                await tx.coinTransfer.create({
                  data: {
                    senderId: userId,
                    recipientId: userId,
                    kind: "streak_reward",
                    amount: out.coinsAdd,
                    note: `Day ${out.nextStreakDays} streak (${out.multiplier}x)`,
                  },
                });
                didAwardStreak = true;
                streakRewardOut = {
                  coinsEarned: out.coinsAdd,
                  streakDays: out.nextStreakDays,
                  multiplier: out.multiplier,
                };
              })()
            : Promise.resolve();

        // Self-view seed: create the row then increment view counters (sequential by data dep).
        // Bots (e.g. Marv) do not count as viewers of their own posts.
        const selfViewOp = author.isBot
          ? Promise.resolve()
          : (async () => {
              const seededView = await tx.postView.createMany({
                data: [{ postId: created.id, userId }],
                skipDuplicates: true,
              });
              if (seededView.count > 0) {
                const updatedCounts = await tx.post.update({
                  where: { id: created.id },
                  data: {
                    viewerCount: { increment: 1 },
                    totalViewCount: { increment: 1 },
                    weightedViewCount: { increment: LOGGED_IN_VIEW_WEIGHT },
                  },
                  select: {
                    viewerCount: true,
                    totalViewCount: true,
                    weightedViewCount: true,
                  },
                });
                created.viewerCount = updatedCounts.viewerCount;
                created.totalViewCount = updatedCounts.totalViewCount;
                created.weightedViewCount = updatedCounts.weightedViewCount;
              }
            })();

        // Parent commentCount increment (only when this is a reply).
        const parentBumpOp = parentId
          ? tx.post
              .update({
                where: { id: parentId },
                data: { commentCount: { increment: 1 } },
                select: { commentCount: true },
              })
              .then((parentAfter) => {
                parentCommentCount =
                  typeof parentAfter.commentCount === "number"
                    ? parentAfter.commentCount
                    : null;
              })
          : Promise.resolve();

        // Board threads count every comment on the root, so nested replies bump it too.
        const boardRootBumpOp = boardRootToBump
          ? tx.post
              .update({
                where: { id: boardRootToBump },
                data: { commentCount: { increment: 1 } },
                select: { commentCount: true },
              })
              .then((rootAfter) => {
                boardRootCommentCount = rootAfter.commentCount;
              })
          : Promise.resolve();

        // Quoted-post repost + quoteCount counter bump (only when a local quote was detected).
        const quotedBumpOp = quotedExists
          ? tx.post
              .update({
                where: { id: quotedExists.id },
                data: {
                  repostCount: { increment: 1 },
                  quoteCount: { increment: 1 },
                },
              })
              .then(() => undefined)
          : Promise.resolve();

        // Hashtag upserts: each tag/variant pair is independent → fire all in parallel.
        const hashtagOps =
          hashtagTokens.length > 0
            ? Promise.all(
                hashtagTokens.flatMap((tok) => [
                  tx.hashtag.upsert({
                    where: { tag: tok.tag },
                    create: { tag: tok.tag, usageCount: 1 },
                    update: { usageCount: { increment: 1 } },
                  }),
                  tx.hashtagVariant.upsert({
                    where: {
                      tag_variant: { tag: tok.tag, variant: tok.variant },
                    },
                    create: { tag: tok.tag, variant: tok.variant, count: 1 },
                    update: { count: { increment: 1 } },
                  }),
                ]),
              )
            : Promise.resolve();

        // All post-create side effects fan out in parallel within the same transaction.
        await Promise.all([
          parentBumpOp,
          boardRootBumpOp,
          quotedBumpOp,
          hashtagOps,
          streakOp,
          selfViewOp,
        ]);

        return created;
      })
      .catch((e: unknown) => {
        if (kind === "checkin") {
          if (!isCheckinOpen(now))
            throw new BadRequestException(CHECKIN_CLOSED_MESSAGE);
          // One-per-day uniqueness.
          if (
            e instanceof Prisma.PrismaClientKnownRequestError &&
            e.code === "P2002"
          ) {
            throw new BadRequestException("Already checked in today.");
          }
        }
        throw e;
      });

    // New content is delivered over realtime; feed snapshots expire within 30s.
    // Keep search/topic invalidation, without flushing every viewer's feed.
    // Edits and deletions still invalidate immediately above.
    if (post.visibility && post.visibility !== "onlyMe") {
      void this.cacheInvalidation.bumpForPostWrite({
        topics: post.topics ?? [],
        invalidateFeed: false,
      });
    }

    // Realtime: bump parent commentCount for live subscribers (best-effort, sync emit).
    if (parentId && typeof parentCommentCount === "number") {
      try {
        this.presenceRealtime.emitPostsLiveUpdated(parentId, {
          postId: parentId,
          version: new Date().toISOString(),
          reason: "comment_created",
          patch: { commentCount: parentCommentCount },
        });
      } catch {
        // Best-effort
      }
    }

    // Realtime: push full reply DTO to thread subscribers (best-effort, sync emit).
    // `post` already includes user/media/mentions/poll thanks to the create's nested include,
    // so no extra fetch is required.
    if (parentId) {
      try {
        const replyDto = toPostDto(
          post,
          this.appConfig.r2()?.publicBaseUrl ?? null,
          {
            viewerHasBoosted: false,
            includeInternal: false,
          },
        );
        this.presenceRealtime.emitPostsCommentAdded(parentId, {
          parentPostId: parentId,
          comment: replyDto,
        });
      } catch {
        // Best-effort
      }
    }

    // Board: the thread page subscribes only to the root, so mirror nested comments there.
    if (boardRootToBump && parentId) {
      try {
        if (typeof boardRootCommentCount === "number") {
          this.presenceRealtime.emitPostsLiveUpdated(boardRootToBump, {
            postId: boardRootToBump,
            version: new Date().toISOString(),
            reason: "comment_created",
            patch: { commentCount: boardRootCommentCount },
          });
        }
        this.presenceRealtime.emitPostsCommentAdded(boardRootToBump, {
          parentPostId: parentId,
          comment: toPostDto(post, this.appConfig.r2()?.publicBaseUrl ?? null, {
            viewerHasBoosted: false,
            includeInternal: false,
          }),
        });
      } catch {
        // Best-effort
      }
    }

    // Realtime: push the full DTO to the community-group feed room so members viewing the group
    // see the new post instantly. Top-level group posts only — replies surface through the
    // post-room `posts:commentAdded` channel.
    //
    // Group rooms require verification and the group’s read permissions. Emit the standard
    // group audience immediately, including verified non-members reading an open group.
    // Historically premium-scoped posts still need a narrower audience in side effects.
    const createdGroupId =
      (post as { communityGroupId?: string | null }).communityGroupId ?? null;
    const createdVisibility =
      (post as { visibility?: string }).visibility ?? "public";
    if (
      !parentId &&
      createdGroupId &&
      (createdVisibility === "public" || createdVisibility === "verifiedOnly")
    ) {
      try {
        const groupPostDto = toPostDto(
          post,
          this.appConfig.r2()?.publicBaseUrl ?? null,
          {
            viewerHasBoosted: false,
            includeInternal: false,
          },
        );
        this.presenceRealtime.emitGroupNewPost(createdGroupId, {
          groupId: createdGroupId,
          post: groupPostDto,
        });
      } catch {
        // Best-effort
      }
    }

    // ─── Hand all notification + fan-out work to the side-effects queue ──────────
    // None of it is observed by the caller, and running it in this process would both add
    // latency here and steal DB/CPU from concurrent requests. See PostsSideEffectsHandler.
    this.sideEffects.dispatch(
      "post.created",
      {
        postId: post.id,
        actorUserId: userId,
        didAwardStreak,
        requestedMarvMode,
      },
      { jobId: `post-created-${post.id}` },
    );

    // Commenting on a post implies the commenter saw the parent post.
    if (parentId) {
      void this.postViews.markViewed(userId, parentId);
    }

    // Refresh trending score: for comments → parent post; for quote reposts → quoted post; for all posts → the post itself.
    if (parentId) {
      this.ranking.enqueueScoreRefresh(parentId);
    } else if (quotedPostInfoRef.current?.quotedPostId) {
      this.ranking.enqueueScoreRefresh(quotedPostInfoRef.current.quotedPostId);
    }
    this.ranking.enqueueScoreRefresh(post.id);

    const eventName =
      kind === "checkin"
        ? "checkin_created"
        : kind === "board"
          ? parentId
            ? "board_comment_created"
            : "board_thread_created"
          : "post_created";
    this.posthog.capture(userId, eventName, {
      post_id: post.id,
      kind,
      ...(kind === "board" ? { from_article: Boolean(params.articleId) } : {}),
      visibility,
      has_media: (params.media?.length ?? 0) > 0,
      has_poll: Boolean(params.poll),
      is_reply: Boolean(parentId),
    });

    captureMemberParticipation(this.posthog, {
      id: post.id,
      userId,
      kind,
      visibility,
      isBot: Boolean(author.isBot),
      verifiedStatus: author.verifiedStatus,
      parentId,
      parentAuthorId: parentAuthorUserId,
      parentIsBot: parentPost?.user?.isBot,
    });

    return { post, streakReward: streakRewardOut };
  }
}
