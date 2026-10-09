import { Injectable } from "@nestjs/common";
import { captureMemberParticipation } from "../../common/posthog/member-participation";
import { toPostDto } from "../../common/dto/post.dto";
import { PosthogService } from "../../common/posthog/posthog.service";
import { AppConfigService } from "../app/app-config.service";
import { PostViewsService } from "../post-views/post-views.service";
import { PresenceRealtimeService } from "../presence/presence-realtime.service";
import { CacheInvalidationService } from "../redis/cache-invalidation.service";
import { SideEffectsService } from "../side-effects/side-effects.service";
import { PostsRankingService } from "./posts-ranking.service";

type CreatedPost = Parameters<typeof toPostDto>[0] & {
  id: string;
  topics?: string[] | null;
};

export type PostWrittenInput = {
  post: CreatedPost;
  userId: string;
  kind: string;
  visibility: string;
  parentId: string | null | undefined;
  /** Comment count after the parent bump, when this write was a reply. */
  parentCommentCount: number | null;
  parentAuthorUserId: string | null | undefined;
  parentIsBot: boolean | undefined;
  /** Board thread root that mirrors nested comments, with its post-bump comment count. */
  boardRootToBump: string | null;
  boardRootCommentCount: number | null;
  /** Original post of a quote repost, so its score refreshes too. */
  quotedPostId: string | null;
  didAwardStreak: boolean;
  requestedMarvMode: "regular" | "fast" | "smart" | null;
  fromArticle: boolean;
  hasMedia: boolean;
  hasPoll: boolean;
  authorIsBot: boolean;
  authorVerifiedStatus: string;
};

/**
 * Everything that follows a committed post write on the request path: feed invalidation, realtime
 * pushes to thread/board/group rooms, the post.created side-effect, view and score refreshes, and
 * analytics. Each realtime emit is best-effort and never fails the write.
 */
@Injectable()
export class PostsWriteAfterCommitService {
  constructor(
    private readonly appConfig: AppConfigService,
    private readonly cacheInvalidation: CacheInvalidationService,
    private readonly posthog: PosthogService,
    private readonly postViews: PostViewsService,
    private readonly presenceRealtime: PresenceRealtimeService,
    private readonly ranking: PostsRankingService,
    private readonly sideEffects: SideEffectsService,
  ) {}

  run(input: PostWrittenInput): void {
    const {
      post, userId, kind, visibility, parentId, parentCommentCount, parentAuthorUserId, parentIsBot,
      boardRootToBump, boardRootCommentCount, quotedPostId, didAwardStreak, requestedMarvMode,
      fromArticle, hasMedia, hasPoll, authorIsBot, authorVerifiedStatus,
    } = input;
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
    } else if (quotedPostId) {
      this.ranking.enqueueScoreRefresh(quotedPostId);
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
      ...(kind === "board" ? { from_article: fromArticle } : {}),
      visibility,
      has_media: hasMedia,
      has_poll: hasPoll,
      is_reply: Boolean(parentId),
    });

    captureMemberParticipation(this.posthog, {
      id: post.id,
      userId,
      kind,
      visibility,
      isBot: Boolean(authorIsBot),
      verifiedStatus: authorVerifiedStatus,
      parentId,
      parentAuthorId: parentAuthorUserId,
      parentIsBot,
    });
  }
}
