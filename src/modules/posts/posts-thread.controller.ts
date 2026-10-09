import type { CommunityGroupPreviewDto } from "../../common/dto/community-group.dto";
import { postCommentsQuerySchema } from "./posts.schemas";
import { Inject } from "@nestjs/common";
import { PostsFeedComposeService } from "./posts-feed-compose.service";
import { PostsViewerEnrichmentService } from "./posts-viewer-enrichment.service";
import { PostsRankingService } from "./posts-ranking.service";
import { PostsFeedLookupService } from "./posts-feed-lookup.service";
import { isSiteAdminViewer } from "../viewer/site-admin";
import { Controller, Get, Param, Query, Res, UseGuards } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import type { Response } from "express";
import { OptionalAuthGuard } from "../auth/auth-public-api";
import { AppConfigService } from "../app/app-config.service";
import { OptionalCurrentUserId } from "../users/users.decorator";
import { toPostDto, type PostWithAuthorAndMedia } from "./post.dto";
import { buildAttachParentChain } from "./posts.utils";
import {
  rateLimitLimit,
  rateLimitTtl,
} from "../../common/throttling/rate-limit.resolver";
import { setReadCache } from "../../common/http-cache";

@ApiTags("Feed & Posts")
@Controller("posts")
export class PostsThreadController {
  constructor(
    @Inject(PostsFeedComposeService)
    private readonly postsCompose: Pick<
      PostsFeedComposeService,
      "communityGroupPreviewMapForFeed" | "getByIds" | "videoEmbedsForPosts"
    >,
    @Inject(PostsViewerEnrichmentService)
    private readonly postsEnrichment: Pick<
      PostsViewerEnrichmentService,
      | "viewerBookmarksByPostId"
      | "viewerBoostedPostIds"
      | "viewerContext"
      | "viewerVotedPollOptionIdByPostId"
    >,
    @Inject(PostsRankingService)
    private readonly postsRanking: Pick<
      PostsRankingService,
      "computeScoresForPostIds" | "ensureBoostScoresFresh"
    >,
    @Inject(PostsFeedLookupService)
    private readonly postsLookup: Pick<
      PostsFeedLookupService,
      "getThreadParticipants" | "listComments"
    >,
    private readonly appConfig: AppConfigService,
  ) {}

  @UseGuards(OptionalAuthGuard)
  @Throttle({
    default: {
      limit: rateLimitLimit("publicRead", 600),
      ttl: rateLimitTtl("publicRead", 60),
    },
  })
  @Get(":id/comments")
  async listComments(
    @OptionalCurrentUserId() userId: string | undefined,
    @Param("id") id: string,
    @Query() query: unknown,
    @Res({ passthrough: true }) httpRes: Response,
  ) {
    const viewerUserId = userId ?? null;
    const parsed = postCommentsQuerySchema.parse(query);
    const sortKind =
      parsed.sort === "trending" ? "popular" : (parsed.sort ?? "new");
    const result = await this.postsLookup.listComments({
      viewerUserId,
      postId: id,
      limit: parsed.limit ?? 30,
      cursor: parsed.cursor ?? null,
      visibility:
        (parsed.visibility as
          | "all"
          | "public"
          | "verifiedOnly"
          | "premiumOnly") ?? "all",
      sort: sortKind as "new" | "popular",
    });
    const commentIds = result.comments.map((p) => p.id);
    const viewer = await this.postsEnrichment.viewerContext(viewerUserId);
    const viewerHasAdmin = isSiteAdminViewer(viewer);
    const [
      boosted,
      bookmarksByPostId,
      votedPollOptionIdByPostId,
      internalByPostId,
      scoreByPostIdComments,
    ] = await Promise.all([
      viewerUserId
        ? this.postsEnrichment.viewerBoostedPostIds({
            viewerUserId,
            postIds: commentIds,
          })
        : Promise.resolve(new Set<string>()),
      viewerUserId
        ? this.postsEnrichment.viewerBookmarksByPostId({
            viewerUserId,
            postIds: commentIds,
          })
        : Promise.resolve(new Map<string, { collectionIds: string[] }>()),
      viewerUserId
        ? this.postsEnrichment.viewerVotedPollOptionIdByPostId({
            viewerUserId,
            postIds: commentIds,
          })
        : Promise.resolve(new Map<string, string>()),
      viewerHasAdmin
        ? this.postsRanking.ensureBoostScoresFresh(commentIds)
        : Promise.resolve(null),
      viewerHasAdmin
        ? this.postsRanking.computeScoresForPostIds(commentIds)
        : Promise.resolve(undefined),
    ]);

    const r2comments = this.appConfig.r2()?.publicBaseUrl ?? null;

    // Collect unique parentIds and communityGroupIds from comments so we can:
    //   (a) attach parent chain info ("Replying to @username" in the reply preview)
    //   (b) attach group preview chip (same as the main feed)
    const uniqueParentIds = [
      ...new Set(
        result.comments
          .map((p) =>
            String((p as { parentId?: string | null }).parentId ?? "").trim(),
          )
          .filter(Boolean),
      ),
    ];
    const uniqueGroupIds = [
      ...new Set(
        result.comments
          .map((p) =>
            String(
              (p as { communityGroupId?: string | null }).communityGroupId ??
                "",
            ).trim(),
          )
          .filter(Boolean),
      ),
    ];

    const [parentPosts, groupPreviewByGroupId] = await Promise.all([
      uniqueParentIds.length
        ? this.postsCompose.getByIds({ viewerUserId, ids: uniqueParentIds })
        : Promise.resolve([]),
      uniqueGroupIds.length
        ? this.postsCompose.communityGroupPreviewMapForFeed(
            viewerUserId,
            uniqueGroupIds,
          )
        : Promise.resolve(new Map<string, CommunityGroupPreviewDto>()),
    ]);
    const parentMap = new Map(parentPosts.map((p) => [p.id, p] as const));
    const videoEmbedByPostId = await this.postsCompose.videoEmbedsForPosts([
      ...result.comments,
      ...parentPosts,
    ]);

    const attachParentChain = buildAttachParentChain<PostWithAuthorAndMedia>({
      parentMap,
      baseUrl: r2comments,
      boosted,
      bookmarksByPostId,
      votedPollOptionIdByPostId,
      viewerUserId,
      viewerHasAdmin,
      internalByPostId,
      scoreByPostId: scoreByPostIdComments,
      toPostDto,
      groupPreviewByGroupId,
      videoEmbedByPostId,
    });

    setReadCache(httpRes, { viewerUserId });
    return {
      data: result.comments.map((p) => attachParentChain(p)),
      pagination: {
        nextCursor: result.nextCursor,
        counts: result.counts ?? null,
      },
    };
  }

  @UseGuards(OptionalAuthGuard)
  @Throttle({
    default: {
      limit: rateLimitLimit("publicRead", 600),
      ttl: rateLimitTtl("publicRead", 60),
    },
  })
  @Get(":id/thread-participants")
  async getThreadParticipants(
    @OptionalCurrentUserId() userId: string | undefined,
    @Param("id") id: string,
  ) {
    const viewerUserId = userId ?? null;
    const result = await this.postsLookup.getThreadParticipants({
      viewerUserId,
      postId: id,
    });
    return { data: result.participants };
  }
}
