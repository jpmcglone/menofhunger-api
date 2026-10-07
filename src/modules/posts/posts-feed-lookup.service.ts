import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {Prisma} from "@prisma/client";
import type {
  PostVisibility,
} from "@prisma/client";
import {PrismaService} from "../prisma/prisma.service";
import {RequestCacheService} from "../../common/cache/request-cache.service";
import {
  ViewerContextService,
} from "../viewer/viewer-context.service";
import {
  BOARD_THREAD_PREVIEW_INCLUDE,
  BOARD_ROOT_TITLE_INCLUDE,
  ARTICLE_SHARE_INCLUDE,
  FITNESS_SHARE_INCLUDE,
  QUOTED_POST_INCLUDE,
} from "../../common/prisma-includes/post.include";
import {
  MENTION_USER_SELECT,
  USER_LIST_SELECT,
} from "../../common/prisma-selects/user.select";
import {
  notDeletedWhere,
} from "./posts-query-builders";
import {
  type FeedPost,
} from "./posts-feed.types";
import {PostsViewerEnrichmentService} from "./posts-viewer-enrichment.service";
import {CacheService} from "../redis/cache.service";
import {CacheTtl} from "../redis/cache-ttl";
import {RedisKeys} from "../redis/redis-keys";
import {
  totalPostCommentsWhere,
} from "../../common/content-counts";
import {excludeMarvFromParticipants} from "./posts-mentions.helpers";
import {PostsFeedAccessService, type ReadablePostShell} from "./posts-feed-access.service";
import {PostsRankingService} from "./posts-ranking.service";
import {AppConfigService} from "../app/app-config.service";

@Injectable()
export class PostsFeedLookupService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly requestCache: RequestCacheService,
    private readonly viewerContextService: ViewerContextService,
    private readonly enrichment: PostsViewerEnrichmentService,
    private readonly cache: CacheService,
    private readonly access: PostsFeedAccessService,
    private readonly ranking: PostsRankingService,
    private readonly appConfig: AppConfigService,
  ) {}
  private encodeCommentCursor(cursor: { createdAt: string; id: string }) {
    return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
  }

  private decodeCommentCursor(
    token: string | null,
  ): { createdAt: string; id: string } | null {
    const t = (token ?? "").trim();
    if (!t) return null;
    try {
      const raw = Buffer.from(t, "base64url").toString("utf8");
      const parsed = JSON.parse(raw) as Partial<{
        createdAt: string;
        id: string;
      }>;
      const createdAt =
        typeof parsed.createdAt === "string" ? parsed.createdAt : "";
      const id = typeof parsed.id === "string" ? parsed.id : "";
      if (!createdAt || !id) return null;
      return { createdAt, id };
    } catch {
      return null;
    }
  }

  /**
   * List comments for a post. Viewer must be able to see the parent (same rule as getById).
   * Only top-level posts can have comments; only-me parents are unreachable.
   */
  async listComments(params: {
    viewerUserId: string | null;
    postId: string;
    limit: number;
    cursor: string | null;
    visibility?: "all" | PostVisibility;
    sort?: "new" | "popular";
  }) {
    const {
      viewerUserId,
      postId,
      limit,
      cursor,
      visibility = "all",
      sort = "new",
    } = params;
    const parent = await this.access.requireReadablePostShell({
      viewerUserId,
      id: postId,
    });
    if (parent.visibility === "onlyMe") {
      throw new ForbiddenException("This post is private.");
    }

    const viewer = await this.viewerContextService.getViewer(viewerUserId);
    const allowed = this.enrichment.allowedVisibilitiesForViewer(viewer);
    const baseVisibilityWhere: Prisma.PostWhereInput =
      visibility === "all"
        ? { visibility: { in: allowed } }
        : visibility === "public"
          ? { visibility: "public" }
          : { visibility };
    // Author always sees own replies (e.g. after tier downgrade).
    const visibilityWhere: Prisma.PostWhereInput = viewerUserId
      ? { OR: [baseVisibilityWhere, { userId: viewerUserId }] }
      : baseVisibilityWhere;

    const decoded = this.decodeCommentCursor(cursor);
    const isDesc = sort === "new";
    const cursorWhere =
      decoded != null
        ? isDesc
          ? ({
              OR: [
                { createdAt: { lt: new Date(decoded.createdAt) } },
                {
                  AND: [
                    { createdAt: new Date(decoded.createdAt) },
                    { id: { lt: decoded.id } },
                  ],
                },
              ],
            } as Prisma.PostWhereInput)
          : ({
              OR: [
                { createdAt: { gt: new Date(decoded.createdAt) } },
                {
                  AND: [
                    { createdAt: new Date(decoded.createdAt) },
                    { id: { gt: decoded.id } },
                  ],
                },
              ],
            } as Prisma.PostWhereInput)
        : undefined;

    const baseWhere = {
      parentId: postId,
      ...visibilityWhere,
      ...notDeletedWhere(),
    };

    const commentInclude = {
      user: { select: USER_LIST_SELECT },
      media: { orderBy: { position: "asc" as const } },
      mentions: { include: { user: { select: MENTION_USER_SELECT } } },
    };

    if (sort === "popular") {
      const candidateIds = (
        await this.prisma.post.findMany({
          where: {
            ...baseWhere,
            OR: [{ boostCount: { gt: 0 } }, { bookmarkCount: { gt: 0 } }],
          },
          select: { id: true },
          take: 500,
        })
      ).map((p) => p.id);
      if (candidateIds.length > 0)
        await this.ranking.ensureBoostScoresFresh(candidateIds);
      const [comments, countMap] = await Promise.all([
        this.prisma.post.findMany({
          where: cursorWhere ? { AND: [baseWhere, cursorWhere] } : baseWhere,
          include: commentInclude,
          orderBy: [
            { boostScore: "desc" },
            { boostCount: "desc" },
            { createdAt: "desc" },
            { id: "desc" },
          ],
          take: limit + 1,
        }),
        this.commentVisibilityCounts(postId),
      ]);
      const slice = comments.slice(0, limit);
      const nextCursor =
        comments.length > limit && slice[slice.length - 1]
          ? this.encodeCommentCursor({
              createdAt: slice[slice.length - 1].createdAt.toISOString(),
              id: slice[slice.length - 1].id,
            })
          : null;
      return { comments: slice, nextCursor, counts: countMap };
    }

    const [comments, countMap] = await Promise.all([
      this.prisma.post.findMany({
        where: cursorWhere ? { AND: [baseWhere, cursorWhere] } : baseWhere,
        include: commentInclude,
        orderBy: isDesc
          ? [{ createdAt: "desc" }, { id: "desc" }]
          : [{ createdAt: "asc" }, { id: "asc" }],
        take: limit + 1,
      }),
      this.commentVisibilityCounts(postId),
    ]);

    const slice = comments.slice(0, limit);
    const nextCursor =
      comments.length > limit && slice[slice.length - 1]
        ? this.encodeCommentCursor({
            createdAt: slice[slice.length - 1].createdAt.toISOString(),
            id: slice[slice.length - 1].id,
          })
        : null;

    return { comments: slice, nextCursor, counts: countMap };
  }

  private async commentVisibilityCounts(postId: string) {
    const counts = await this.prisma.post.groupBy({
      by: ["visibility"],
      where: totalPostCommentsWhere(postId),
      _count: { _all: true },
    });
    const countMap = { all: 0, public: 0, verifiedOnly: 0, premiumOnly: 0 };
    for (const g of counts) {
      countMap.all += g._count._all;
      if (g.visibility === "public") countMap.public = g._count._all;
      if (g.visibility === "verifiedOnly")
        countMap.verifiedOnly = g._count._all;
      if (g.visibility === "premiumOnly") countMap.premiumOnly = g._count._all;
    }
    return countMap;
  }

  /**
   * Thread participants = root post author + all comment authors + everyone mentioned in the thread
   * (except Marv — he only answers an explicit @marv, so we don't prefill him on later replies).
   * Used to pre-fill mentions and show "Replying to @userA, @userB" when composing a reply.
   */
  async getThreadParticipants(params: {
    viewerUserId: string | null;
    postId: string;
  }) {
    const { viewerUserId, postId } = params;
    const post = await this.access.requireReadablePostShell({
      viewerUserId,
      id: postId,
    });
    if (post.visibility === "onlyMe") {
      throw new ForbiddenException("This post is private.");
    }

    const rootId = post.rootId ?? post.id;
    const cached = await this.cache.getOrSetJson<
      { id: string; username: string }[]
    >({
      enabled: true,
      key: RedisKeys.threadParticipants(rootId),
      ttlSeconds: CacheTtl.threadParticipantsSeconds,
      compute: () => this.loadThreadParticipantUsers(rootId),
    });
    const marv = this.appConfig.marvBot();
    return {
      participants: excludeMarvFromParticipants(cached, marv),
    };
  }

  private async loadThreadParticipantUsers(
    rootId: string,
  ): Promise<Array<{ id: string; username: string }>> {
    const threadWhere = {
      OR: [{ id: rootId }, { rootId }],
      ...notDeletedWhere(),
    };
    const [authorRows, mentionRows] = await Promise.all([
      this.prisma.post.findMany({
        where: threadWhere,
        select: { userId: true },
        distinct: ["userId"],
      }),
      this.prisma.postMention.findMany({
        where: { post: threadWhere },
        select: { userId: true },
        distinct: ["userId"],
      }),
    ]);
    const participantIds = [
      ...new Set([...authorRows, ...mentionRows].map((r) => r.userId)),
    ];
    if (participantIds.length === 0) return [];

    const users = await this.prisma.user.findMany({
      where: {
        id: { in: participantIds },
        usernameIsSet: true,
        bannedAt: null,
      },
      select: { id: true, username: true },
    });
    return users
      .filter((u) => u.username != null)
      .map((u) => ({ id: u.id, username: u.username as string }));
  }

  async getById(params: { viewerUserId: string | null; id: string }) {
    const { viewerUserId, id } = params;
    const postId = (id ?? "").trim();
    if (!postId) throw new NotFoundException("Post not found.");

    const cacheKey = `posts.getById:${viewerUserId ?? "anon"}:${postId}`;
    const cached = this.requestCache.get<FeedPost>(cacheKey);
    if (cached) return cached;

    const viewer = await this.viewerContextService.getViewer(viewerUserId);
    const post = await this.prisma.post.findFirst({
      where: { id: postId, ...(viewer?.siteAdmin ? {} : notDeletedWhere()) },
      include: {
        user: { select: USER_LIST_SELECT },
        media: { orderBy: { position: "asc" } },
        poll: { include: { options: { orderBy: { position: "asc" } } } },
        mentions: { include: { user: { select: MENTION_USER_SELECT } } },
        article: ARTICLE_SHARE_INCLUDE,
        fitnessShare: FITNESS_SHARE_INCLUDE,
        boardThread: BOARD_THREAD_PREVIEW_INCLUDE,
        root: BOARD_ROOT_TITLE_INCLUDE,
        quotedPost: { include: QUOTED_POST_INCLUDE },
      },
    });
    if (!post) throw new NotFoundException("Post not found.");

    const shell: ReadablePostShell = {
      id: post.id,
      userId: post.userId,
      visibility: post.visibility,
      rootId: (post as { rootId?: string | null }).rootId ?? null,
      communityGroupId:
        (post as { communityGroupId?: string | null }).communityGroupId ?? null,
    };
    await this.access.assertViewerCanReadListedPost({
      post: shell,
      viewerUserId,
      viewer,
    });

    this.requestCache.set(cacheKey, post as FeedPost);
    this.requestCache.set(
      `posts.readShell:${viewerUserId ?? "anon"}:${postId}`,
      shell,
    );
    return post;
  }

  /**
   * Like getById but for permalink preview: returns the post even when the viewer's tier
   * can't access it (verifiedOnly / premiumOnly). onlyMe posts still throw 404.
   * The caller is responsible for passing `viewerCanAccess: false` to toPostDto.
   */
  async getByIdNoAccess(id: string): Promise<FeedPost> {
    const postId = (id ?? "").trim();
    if (!postId) throw new NotFoundException("Post not found.");

    const post = await this.prisma.post.findFirst({
      where: { id: postId, visibility: { not: "onlyMe" }, deletedAt: null },
      include: {
        user: { select: USER_LIST_SELECT },
        media: { orderBy: { position: "asc" } },
        poll: { include: { options: { orderBy: { position: "asc" } } } },
        mentions: { include: { user: { select: MENTION_USER_SELECT } } },
        article: ARTICLE_SHARE_INCLUDE,
        fitnessShare: FITNESS_SHARE_INCLUDE,
        boardThread: BOARD_THREAD_PREVIEW_INCLUDE,
        root: BOARD_ROOT_TITLE_INCLUDE,
        quotedPost: { include: QUOTED_POST_INCLUDE },
      },
    });
    if (!post) throw new NotFoundException("Post not found.");
    return post as FeedPost;
  }
}
