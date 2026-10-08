import { assertPublishableText } from "../../common/moderation/content-filter";
import { requireAiConsent } from "../marvin/services/ai-consent";
import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { Prisma, type PostVisibility } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { PresenceRealtimeService } from "../presence/presence-realtime.service";
import { ViewerContextService } from "../viewer/viewer-context.service";
import { AppConfigService } from "../app/app-config.service";
import { CacheInvalidationService } from "../redis/cache-invalidation.service";
import { MENTION_USER_SELECT, USER_LIST_SELECT } from "../../common/prisma-selects/user.select";
import { TickerService } from "../cashtags/ticker.service";
import { inferTopicsFromText } from "../../common/topics/topic-utils";
import { PostViewsService } from "../post-views/post-views.service";
import { PosthogService } from "../../common/posthog/posthog.service";
import { PostsRankingService } from "./posts-ranking.service";
import { PostsViewerEnrichmentService } from "./posts-viewer-enrichment.service";
import { SiteConfigService } from "../site-config/site-config.service";
import { SideEffectsService } from "../side-effects/side-effects.service";
import { PostsTopicsClassifyService } from "./posts-topics-classify.service";
import { PostsMutationSupportService } from "./posts-mutation-support.service";

@Injectable()
export class PostsMutationEditsService {
  private readonly logger = new Logger(PostsMutationEditsService.name);
  createPost?: (params: import("./posts-mutation.types").CreatePostParams) => Promise<{ post: any; streakReward?: any }>;
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
  async deletePost(params: { userId: string; postId: string }) {
    const { userId, postId } = params;
    const id = (postId ?? "").trim();
    if (!id) throw new NotFoundException("Post not found.");

    const post = await this.prisma.post.findUnique({
      where: { id },
      select: {
        id: true,
        userId: true,
        deletedAt: true,
        hashtags: true,
        hashtagCasings: true,
        cashtags: true,
        topics: true,
        kind: true,
        parentId: true,
        rootId: true,
        repostedPostId: true,
        quotedPostId: true,
      },
    });
    if (!post) throw new NotFoundException("Post not found.");
    if (post.userId !== userId)
      throw new ForbiddenException("Not allowed to delete this post.");
    // Board threads count every comment on the root (HN-style total), not just direct replies.
    const boardRootToDecrement =
      post.kind === "board" &&
      post.parentId &&
      post.rootId &&
      post.rootId !== post.parentId
        ? post.rootId
        : null;
    if (post.deletedAt) return { success: true };

    const postTopics = post.topics ?? [];
    const tags = post.hashtags ?? [];
    const variants = post.hashtagCasings ?? [];
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      await tx.post.update({
        where: { id },
        data: { deletedAt: now },
      });

      // Decrement commentCount on the parent post when a comment is deleted.
      // Use raw SQL GREATEST(0, ...) to prevent the counter going negative under races.
      const parentId = post.parentId;
      if (parentId) {
        await tx.$executeRaw`
          UPDATE "Post"
          SET "commentCount" = GREATEST(0, "commentCount" - 1)
          WHERE "id" = ${parentId}
        `;
      }
      if (boardRootToDecrement) {
        await tx.$executeRaw`
          UPDATE "Post"
          SET "commentCount" = GREATEST(0, "commentCount" - 1)
          WHERE "id" = ${boardRootToDecrement}
        `;
      }

      // Decrement repostCount (and quoteCount for quotes) on the target post when a repost/quote is deleted.
      // updateMany no-ops when the target is already gone. update() would throw inside the
      // interactive transaction and abort every later statement, even if the error is caught.
      const repostedPostId = post.repostedPostId;
      const quotedPostId = post.quotedPostId;
      if (post.kind === "repost" && repostedPostId) {
        await tx.post.updateMany({
          where: { id: repostedPostId },
          data: { repostCount: { decrement: 1 } },
        });
      } else if (quotedPostId) {
        await tx.post.updateMany({
          where: { id: quotedPostId },
          data: { repostCount: { decrement: 1 }, quoteCount: { decrement: 1 } },
        });
      }

      // Poll cleanup: once a post is deleted, we should never send "poll results ready" notifications.
      // This also prevents notifications if the post is later restored by an admin.
      await tx.postPoll.updateMany({
        where: { postId: id, resultsNotifiedAt: null },
        data: { resultsNotifiedAt: now },
      });

      // Posts are soft-deleted, so FK cascades won't run. Ensure bookmarks don't retain deleted posts.
      // (BookmarkCollectionItem cascades off Bookmark, so folder links are cleaned up too.)
      await tx.bookmark.deleteMany({ where: { postId: id } });

      if (tags.length > 0) {
        for (let i = 0; i < tags.length; i++) {
          const t = (tags[i] ?? "").trim().toLowerCase();
          const variant = (variants[i] ?? "").trim();
          if (!t) continue;
          await tx.hashtag.updateMany({
            where: { tag: t },
            data: { usageCount: { decrement: 1 } },
          });
          if (variant) {
            await tx.hashtagVariant.updateMany({
              where: { tag: t, variant },
              data: { count: { decrement: 1 } },
            });
          }
        }
        await tx.hashtagVariant.deleteMany({
          where: { tag: { in: tags }, count: { lte: 0 } },
        });
        await tx.hashtag.deleteMany({
          where: { tag: { in: tags }, usageCount: { lte: 0 } },
        });
      }

      // Deleted posts should no longer contribute to current/best streaks.
      // Recompute from remaining non-deleted, non-onlyMe post days.
      await this.support.recomputeStreakFromPostsTx(
        tx as Prisma.TransactionClient,
        userId,
        now,
      );
    });

    // Notification cleanup (rows referencing this post as subject or actorPost) runs on the
    // side-effects queue: the caller only needs to know the post is gone, and a stale bell row
    // for a deleted post is a self-healing problem the retry handles.
    this.sideEffects.dispatch(
      "post.deleted",
      { postId: id },
      { jobId: `post-deleted-${id}` },
    );
    void this.cacheInvalidation.bumpForPostWrite({ topics: postTopics });

    // Refresh trending score for the post that lost a comment/repost due to this deletion.
    const affectedPostId = post.repostedPostId ?? post.quotedPostId ?? null;
    if (affectedPostId) this.ranking.enqueueScoreRefresh(affectedPostId);

    // Realtime: mark post deleted for live subscribers (best-effort).
    try {
      this.presenceRealtime.emitPostsLiveUpdated(id, {
        postId: id,
        version: now.toISOString(),
        reason: "post_deleted",
        patch: { deletedAt: now.toISOString() },
      });
    } catch {
      // Best-effort
    }

    // Realtime: decrement parent commentCount + notify thread subscribers of the delete (best-effort).
    const deletedParentId = post.parentId;
    if (deletedParentId) {
      // Emit the structural delete hint FIRST so thread subscribers remove the reply
      // from their local list, then send the authoritative `commentCount` patch. If
      // we did this in the opposite order, the `liveUpdated` patch would set the
      // count to N-1 and `commentDeleted` would then decrement again to N-2, since
      // the per-permalink `onCommentDeleted` handler decrements when it removes the
      // row from its array.
      try {
        this.presenceRealtime.emitPostsCommentDeleted(deletedParentId, {
          parentPostId: deletedParentId,
          commentId: id,
        });
      } catch {
        // Best-effort
      }

      try {
        const updatedParent = await this.prisma.post.findUnique({
          where: { id: deletedParentId },
          select: { commentCount: true },
        });
        if (updatedParent && typeof updatedParent.commentCount === "number") {
          this.presenceRealtime.emitPostsLiveUpdated(deletedParentId, {
            postId: deletedParentId,
            version: now.toISOString(),
            reason: "comment_deleted",
            patch: { commentCount: updatedParent.commentCount },
          });
        }
      } catch {
        // Best-effort
      }
    }

    if (boardRootToDecrement && deletedParentId) {
      try {
        this.presenceRealtime.emitPostsCommentDeleted(boardRootToDecrement, {
          parentPostId: deletedParentId,
          commentId: id,
        });
        const root = await this.prisma.post.findUnique({
          where: { id: boardRootToDecrement },
          select: { commentCount: true },
        });
        if (root) {
          this.presenceRealtime.emitPostsLiveUpdated(boardRootToDecrement, {
            postId: boardRootToDecrement,
            version: now.toISOString(),
            reason: "comment_deleted",
            patch: { commentCount: root.commentCount },
          });
        }
      } catch {
        // Best-effort
      }
    }

    return { success: true };
  }

  async updatePost(params: {
    userId: string;
    postId: string;
    body: string;
    isSiteAdmin?: boolean;
  }) {
    const { userId, postId } = params;
    const id = (postId ?? "").trim();
    if (!id) throw new NotFoundException("Post not found.");

    const nextBody = (params.body ?? "").trim();
    assertPublishableText(nextBody);

    const post = await this.prisma.post.findUnique({
      where: { id },
      include: {
        user: { select: USER_LIST_SELECT },
        media: { orderBy: { position: "asc" } },
        mentions: { select: { userId: true } },
        poll: { select: { id: true, totalVoteCount: true } },
      },
    });
    if (!post) throw new NotFoundException("Post not found.");
    if (post.userId !== userId)
      throw new ForbiddenException("Not allowed to edit this post.");
    if (post.deletedAt)
      throw new ForbiddenException("Cannot edit a deleted post.");
    if (post.parentId)
      throw new ForbiddenException("Replies cannot be edited.");
    if (!nextBody && post.kind !== "board")
      throw new BadRequestException("Post must include text.");

    // Product rule: posts with polls cannot be edited once voting begins.
    if (post.poll && (post.poll.totalVoteCount ?? 0) > 0) {
      throw new ForbiddenException("This post can no longer be edited.");
    }

    // Only-me posts and siteAdmins are exempt from age/count limits.
    if (post.visibility !== "onlyMe" && !params.isSiteAdmin) {
      // Enforce edit window + count: 3 edits in first 30 minutes after creation.
      const now = Date.now();
      const createdAtMs = post.createdAt.getTime();
      const windowMs = 30 * 60 * 1000;
      if (Number.isFinite(createdAtMs) && now > createdAtMs + windowMs) {
        throw new ForbiddenException("This post can no longer be edited.");
      }
      if (post.editCount >= 3)
        throw new ForbiddenException("This post has reached the edit limit.");
    }

    // Length rules align with createPost.
    const isAuthorPremium = Boolean(
      post.user?.premium || post.user?.premiumPlus,
    );
    const maxLen = isAuthorPremium ? 1000 : 500;
    if (nextBody.length > maxLen) {
      throw new BadRequestException(
        isAuthorPremium
          ? "Posts are limited to 1000 characters."
          : "Posts are limited to 500 characters.",
      );
    }

    const hashtagTokensRaw = this.support.parseHashtagsFromBody(nextBody);
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
    const cashtags = this.support.parseCashtagsFromBody(nextBody);

    const fromBodyMentions = this.support.parseMentionsFromBody(nextBody);
    const bodyMentionIds = await this.support.resolveMentionUsernames(fromBodyMentions);
    const existingMentionIds = (post.mentions ?? []).map((m) => m.userId);
    const mentionUserIds = Array.from(
      new Set(
        post.kind === "board"
          ? bodyMentionIds
          : [...existingMentionIds, ...bodyMentionIds],
      ),
    ).filter(Boolean);
    const addedMentionIds = bodyMentionIds.filter(
      (id) => !existingMentionIds.includes(id),
    );
    if (
      post.kind === "board" &&
      fromBodyMentions.some(
        (name) =>
          name.toLowerCase() ===
          this.appConfig.marvBot().username.trim().toLowerCase(),
      )
    ) {
      await requireAiConsent(this.prisma, userId);
    }

    // Detect whether the quoted post link changed so we can adjust repostCount.
    const prevQuotedPostId: string | null = (post as any).quotedPostId ?? null;
    const detectedQuotedId = this.support.extractQuotedPostIdFromBody(nextBody);
    const nextQuotedExists = detectedQuotedId
      ? await this.prisma.post.findFirst({
          where: { id: detectedQuotedId, deletedAt: null },
          select: { id: true, visibility: true, communityGroupId: true },
        })
      : null;
    const nextQuotedPostId: string | null = nextQuotedExists?.id ?? null;
    const quoteLinkChanged = prevQuotedPostId !== nextQuotedPostId;

    // Quote floor: quoting post visibility must not be more open than the quoted post's.
    // Same rule as create — applied on edit so a body change can't reintroduce the leak.
    if (nextQuotedExists) {
      const sameGroup =
        post.communityGroupId &&
        nextQuotedExists.communityGroupId === post.communityGroupId;
      if (
        !sameGroup &&
        this.support.visibilityRank(post.visibility) <
          this.support.visibilityRank(nextQuotedExists.visibility)
      ) {
        throw new ForbiddenException(
          "A quote can't be more public than the post it quotes.",
        );
      }
    }

    const prevTopics = post.topics ?? [];
    const updated = await this.prisma.$transaction(async (tx) => {
      // Snapshot previous state (pre-edit).
      await tx.postVersion.create({
        data: {
          postId: post.id,
          body: post.body,
          topics: post.topics ?? [],
          hashtags: post.hashtags ?? [],
          hashtagCasings: post.hashtagCasings ?? [],
          cashtags: (post as any).cashtags ?? [],
          visibility: post.visibility,
        },
      });

      // Recompute topics from text and hashtags (no related topics for root post edits).
      const topics = inferTopicsFromText(nextBody, {
        hashtags,
        relatedTopics: [],
      });

      const next = await tx.post.update({
        where: { id: post.id },
        data: {
          body: nextBody,
          topics,
          topicsClassifiedAt: null,
          replyPrompt: null,
          replyPromptClassifiedAt: null,
          hashtags,
          hashtagCasings,
          cashtags,
          editedAt: new Date(),
          editCount: { increment: 1 },
          // Update the stored quotedPostId to reflect the new body's link.
          ...(quoteLinkChanged ? { quotedPostId: nextQuotedPostId } : {}),
        },
        include: {
          user: { select: USER_LIST_SELECT },
          media: { orderBy: { position: "asc" } },
          mentions: {
            include: {
              user: {
                select: MENTION_USER_SELECT,
              },
            },
          },
        },
      });

      // Adjust repostCount and quoteCount on old and new quoted targets (in-transaction to prevent drift).
      if (quoteLinkChanged) {
        if (prevQuotedPostId) {
          // Quote link removed or swapped away — decrement the old target.
          await tx.post.updateMany({
            where: { id: prevQuotedPostId },
            data: {
              repostCount: { decrement: 1 },
              quoteCount: { decrement: 1 },
            },
          });
        }
        if (nextQuotedPostId) {
          // Quote link added or swapped in — increment the new target.
          await tx.post.update({
            where: { id: nextQuotedPostId },
            data: {
              repostCount: { increment: 1 },
              quoteCount: { increment: 1 },
            },
          });
        }
      }

      await tx.postMention.deleteMany({ where: { postId: post.id } });
      if (mentionUserIds.length > 0) {
        await tx.postMention.createMany({
          data: mentionUserIds.map((uid) => ({ postId: post.id, userId: uid })),
          skipDuplicates: true,
        });
      }

      if (post.kind === "board") {
        next.mentions = await tx.postMention.findMany({
          where: { postId: post.id },
          include: { user: { select: MENTION_USER_SELECT } },
        });
      }

      // If hashtags changed, best-effort adjust counters by recomputing counts deltas.
      // We keep it simple for v1: decrement old and increment new based on tokens.
      const prevTags = post.hashtags ?? [];
      const prevVariants = post.hashtagCasings ?? [];
      const prevPairs = prevTags
        .map((t, i) => ({
          tag: (t ?? "").trim().toLowerCase(),
          variant: (prevVariants[i] ?? "").trim(),
        }))
        .filter((x) => x.tag);
      const nextPairs = hashtagTokens;

      const prevKeyCount = new Map<string, number>();
      for (const p of prevPairs)
        prevKeyCount.set(
          `${p.tag}\n${p.variant}`,
          (prevKeyCount.get(`${p.tag}\n${p.variant}`) ?? 0) + 1,
        );
      const nextKeyCount = new Map<string, number>();
      for (const p of nextPairs)
        nextKeyCount.set(
          `${p.tag}\n${p.variant}`,
          (nextKeyCount.get(`${p.tag}\n${p.variant}`) ?? 0) + 1,
        );

      const allKeys = new Set<string>([
        ...prevKeyCount.keys(),
        ...nextKeyCount.keys(),
      ]);
      for (const key of allKeys) {
        const [tag, variant] = key.split("\n");
        const prevN = prevKeyCount.get(key) ?? 0;
        const nextN = nextKeyCount.get(key) ?? 0;
        const delta = nextN - prevN;
        if (!tag || delta === 0) continue;
        if (delta > 0) {
          await tx.hashtag.upsert({
            where: { tag },
            create: { tag, usageCount: delta },
            update: { usageCount: { increment: delta } },
          });
          if (variant) {
            await tx.hashtagVariant.upsert({
              where: { tag_variant: { tag, variant } },
              create: { tag, variant, count: delta },
              update: { count: { increment: delta } },
            });
          }
        } else if (delta < 0) {
          try {
            await tx.hashtag.update({
              where: { tag },
              data: { usageCount: { decrement: Math.abs(delta) } },
            });
          } catch {
            // ignore
          }
          if (variant) {
            try {
              await tx.hashtagVariant.update({
                where: { tag_variant: { tag, variant } },
                data: { count: { decrement: Math.abs(delta) } },
              });
            } catch {
              // ignore
            }
          }
        }
      }
      const allTagsTouched = Array.from(
        new Set(
          [...prevTags, ...hashtags]
            .map((t) =>
              String(t ?? "")
                .trim()
                .toLowerCase(),
            )
            .filter(Boolean),
        ),
      );
      await tx.hashtagVariant.deleteMany({
        where: { tag: { in: allTagsTouched }, count: { lte: 0 } },
      });
      await tx.hashtag.deleteMany({
        where: { tag: { in: allTagsTouched }, usageCount: { lte: 0 } },
      });

      return next;
    });
    if (post.kind === "board" && addedMentionIds.length) {
      this.sideEffects.dispatch("board.mentions.added", {
        postId: id,
        actorUserId: userId,
        recipientIds: addedMentionIds,
      });
    }
    const nextTopics = updated.topics ?? [];
    await this.cacheInvalidation.bumpForPostWrite({
      topics: [...prevTopics, ...nextTopics],
    });
    void this.topicsClassify.enqueueIfNeeded(id);
    if (post.kind === "regular") this.sideEffects.dispatch("post.replyPrompt.classify", { postId: id });

    // Realtime: update body/edited markers for live subscribers (best-effort).
    try {
      const editedAtIso = (updated.editedAt ?? new Date()).toISOString();
      const editCount =
        typeof updated.editCount === "number" ? updated.editCount : undefined;
      this.presenceRealtime.emitPostsLiveUpdated(id, {
        postId: id,
        version: editedAtIso,
        reason: "post_edited",
        patch: {
          body: String(updated.body ?? ""),
          editedAt: editedAtIso,
          ...(typeof editCount === "number" ? { editCount } : {}),
        },
      });
    } catch {
      // Best-effort
    }

    // If the quoted link changed, dispatch a side effect to reconcile notifications and
    // emit liveUpdated on both old and new quoted targets.
    if (quoteLinkChanged) {
      this.sideEffects.dispatch("post.quote.changed", {
        postId: id,
        actorUserId: userId,
        prevQuotedPostId,
        nextQuotedPostId,
      });
    }

    return updated;
  }

  async publishFromOnlyMe(params: {
    userId: string;
    sourcePostId: string;
    body: string | null;
    visibility: PostVisibility;
    media?: Array<
      | { source: "existing"; id: string; alt?: string | null }
      | {
          source: "upload";
          kind: "image" | "gif" | "video";
          r2Key?: string;
          thumbnailR2Key?: string;
          url?: string;
          mp4Url?: string;
          width?: number;
          height?: number;
          durationSeconds?: number;
          alt?: string | null;
        }
      | {
          source: "giphy";
          kind: "gif";
          url: string;
          mp4Url?: string;
          width?: number;
          height?: number;
          alt?: string | null;
        }
    > | null;
  }) {
    const sourceId = (params.sourcePostId ?? "").trim();
    if (!sourceId) throw new NotFoundException("Post not found.");

    const source = await this.prisma.post.findUnique({
      where: { id: sourceId },
      include: { media: { orderBy: { position: "asc" } } },
    });
    if (!source) throw new NotFoundException("Post not found.");
    if (source.userId !== params.userId)
      throw new ForbiddenException("Not allowed.");
    if (source.deletedAt) throw new NotFoundException("Post not found.");
    if (source.visibility !== "onlyMe")
      throw new ForbiddenException("Not allowed.");
    if (source.parentId) throw new ForbiddenException("Not allowed.");

    const body = (params.body ?? source.body ?? "").trim();
    assertPublishableText(body);

    const sourceMediaSorted = (source.media ?? [])
      .slice()
      .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));

    const requested = (params.media ?? null) as NonNullable<
      (typeof params)["media"]
    > | null;

    const media = requested
      ? requested.map((m) => {
          if (m.source === "existing") {
            const id = (m.id ?? "").trim();
            if (!id) throw new BadRequestException("Invalid media item.");
            const found = sourceMediaSorted.find(
              (sm) => sm.id === id && !sm.deletedAt,
            );
            if (!found) throw new BadRequestException("Invalid media item.");
            const alt =
              (m.alt ?? "").trim() || (found.alt ?? "").trim() || null;
            return {
              source:
                found.source === "giphy"
                  ? ("giphy" as const)
                  : ("upload" as const),
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
          }
          if (m.source === "giphy") {
            return {
              source: "giphy" as const,
              kind: "gif" as const,
              url: m.url,
              mp4Url: m.mp4Url ?? undefined,
              width: m.width ?? undefined,
              height: m.height ?? undefined,
              alt: (m.alt ?? "").trim() || null,
            };
          }
          // upload
          return {
            source: "upload" as const,
            kind: m.kind,
            r2Key: m.r2Key ?? undefined,
            thumbnailR2Key: m.thumbnailR2Key ?? undefined,
            width: m.width ?? undefined,
            height: m.height ?? undefined,
            durationSeconds: m.durationSeconds ?? undefined,
            alt: (m.alt ?? "").trim() || null,
          };
        })
      : sourceMediaSorted.map((m) => ({
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
          alt: (m.alt ?? "").trim() || null,
        }));

    const createdBundle = await this.createPost!({
      userId: params.userId,
      body,
      visibility: params.visibility,
      parentId: null,
      mentions: null,
      media: media.length ? media : null,
      poll: null,
    });
    const postId = createdBundle.post.id;

    // Fetch with mentions for UI consistency (createPost already bumped caches for non–onlyMe).
    const full = await this.prisma.post.findUnique({
      where: { id: postId },
      include: {
        user: { select: USER_LIST_SELECT },
        media: { orderBy: { position: "asc" } },
        poll: { include: { options: { orderBy: { position: "asc" } } } },
        mentions: {
          include: {
            user: {
              select: MENTION_USER_SELECT,
            },
          },
        },
      },
    });
    return full ?? createdBundle.post;
  }
}
