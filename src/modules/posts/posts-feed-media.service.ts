import { Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type { PostMediaKind, PostVisibility } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { ViewerContextService } from "../viewer/viewer-context.service";
import { MENTION_USER_SELECT, USER_LIST_SELECT } from "../../common/prisma-selects/user.select";
import { toPostAuthorDtoFromFeedRow, type PostAuthorDto } from "../../common/dto/post.dto";
import { type FeedPost } from "./posts-feed.types";
import { PostsViewerEnrichmentService } from "./posts-viewer-enrichment.service";
import { PostsFeedAccessService } from "./posts-feed-access.service";
import { PostsRankingService } from "./posts-ranking.service";
import { AppConfigService } from "../app/app-config.service";
import { PostsFeedListingsService } from "./posts-feed-listings.service";
import { toPage } from "../../common/pagination/page";
import { NOT_DELETED } from '../../common/prisma/where';

@Injectable()
export class PostsFeedMediaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly viewerContextService: ViewerContextService,
    private readonly enrichment: PostsViewerEnrichmentService,
    private readonly access: PostsFeedAccessService,
    private readonly ranking: PostsRankingService,
    private readonly appConfig: AppConfigService,
    private readonly listings: PostsFeedListingsService,
  ) {}
  async listMediaForUsername(params: {
    viewerUserId: string | null;
    username: string;
    limit: number;
    cursor: string | null;
    visibility: "all" | PostVisibility;
    sort: "new" | "trending";
    includeRestricted?: boolean;
  }) {
    const {
      viewerUserId,
      username,
      limit,
      cursor,
      visibility,
      sort,
      includeRestricted,
    } = params;
    const normalized = (username ?? "").trim();
    if (!normalized) throw new NotFoundException("User not found.");

    const user = await this.prisma.user.findFirst({
      where: { username: { equals: normalized, mode: "insensitive" } },
      select: { id: true },
    });
    if (!user) throw new NotFoundException("User not found.");

    const viewer = await this.viewerContextService.getViewer(viewerUserId);
    const isSelf = Boolean(viewer && viewer.id === user.id);
    const allowed = isSelf
      ? (["public", "verifiedOnly", "premiumOnly"] as PostVisibility[])
      : this.enrichment.allowedVisibilitiesForViewer(viewer);

    // When includeRestricted, fetch all tiers and compute access per item.
    // When a specific visibility is requested via filter, honour it even in restricted mode.
    const allVisibilities: PostVisibility[] = [
      "public",
      "verifiedOnly",
      "premiumOnly",
    ];
    const visibilityFilter: PostVisibility[] = includeRestricted
      ? visibility !== "all"
        ? [visibility as PostVisibility]
        : allVisibilities
      : visibility === "all"
        ? allowed
        : allowed.includes(visibility as PostVisibility)
          ? [visibility as PostVisibility]
          : [];

    const r2BaseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;

    // Trending sort: join through post.trendingScore. Use numeric offset cursor
    // (encoded as base64) because score order is volatile and ID-lt breaks pages.
    const offset =
      sort === "trending" && cursor
        ? (() => {
            try {
              return (
                parseInt(Buffer.from(cursor, "base64").toString("utf8"), 10) ||
                0
              );
            } catch {
              return 0;
            }
          })()
        : 0;

    const baseWhere: Prisma.PostMediaWhereInput = {
      kind: { in: ["image", "video"] },
      source: "upload",
      ...NOT_DELETED,
      post: {
        userId: user.id,
        ...NOT_DELETED,
        communityGroupId: null,
        boardOnly: false,
        visibility: { in: visibilityFilter },
      },
    };

    type MediaRow = {
      id: string;
      kind: PostMediaKind;
      r2Key: string | null;
      thumbnailR2Key: string | null;
      width: number | null;
      height: number | null;
      durationSeconds: number | null;
      postId: string;
      post: { visibility: PostVisibility };
    };
    let mediaRows: MediaRow[];

    if (sort === "trending") {
      // Include all media (including zero/unscored posts), but rank by parent post score.
      // Unscored/null scores sort to the bottom so "trending" remains score-first.
      mediaRows = await this.prisma.postMedia.findMany({
        where: baseWhere,
        orderBy: [
          { post: { trendingScore: { sort: "desc", nulls: "last" } } },
          { post: { boostCount: "desc" } },
          { post: { bookmarkCount: "desc" } },
          { post: { repostCount: "desc" } },
          { post: { commentCount: "desc" } },
          { post: { createdAt: "desc" } },
          { id: "desc" },
        ],
        skip: offset,
        take: limit + 1,
        select: {
          id: true,
          kind: true,
          r2Key: true,
          thumbnailR2Key: true,
          width: true,
          height: true,
          durationSeconds: true,
          postId: true,
          post: { select: { visibility: true } },
        },
      });
    } else {
      mediaRows = await this.prisma.postMedia.findMany({
        where: { ...baseWhere, ...(cursor ? { id: { lt: cursor } } : {}) },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: limit + 1,
        select: {
          id: true,
          kind: true,
          r2Key: true,
          thumbnailR2Key: true,
          width: true,
          height: true,
          durationSeconds: true,
          postId: true,
          post: { select: { visibility: true } },
        },
      });
    }

    const mediaPage = toPage(mediaRows, limit, (m) => m.id);
    const items = mediaPage.items;
    const hasMore = mediaPage.nextCursor !== null;

    let nextCursor: string | null = null;
    if (hasMore) {
      if (sort === "trending") {
        nextCursor = Buffer.from(String(offset + limit)).toString("base64");
      } else {
        nextCursor = items[items.length - 1]?.id ?? null;
      }
    }

    return {
      items: items.map((m) => {
        const vis = m.post.visibility as PostVisibility;
        const viewerCanAccess = includeRestricted
          ? isSelf || allowed.includes(vis)
          : true;
        return {
          id: m.id,
          postId: m.postId,
          kind: m.kind as "image" | "video",
          url: r2BaseUrl && m.r2Key ? `${r2BaseUrl}/${m.r2Key}` : null,
          thumbnailUrl:
            r2BaseUrl && m.thumbnailR2Key
              ? `${r2BaseUrl}/${m.thumbnailR2Key}`
              : null,
          width: m.width,
          height: m.height,
          durationSeconds: m.durationSeconds ?? null,
          visibility: vis,
          viewerCanAccess,
        };
      }),
      nextCursor,
    };
  }

  // ─── Community group media grid ───────────────────────────────────────────

  async listMediaForGroupsHub(params: {
    viewerUserId: string;
    limit: number;
    cursor: string | null;
    sort: "new" | "trending";
  }) {
    const { viewerUserId, limit, cursor, sort } = params;
    const groupIds =
      await this.listings.listActiveCommunityGroupIdsForUser(viewerUserId);
    if (!groupIds.length) return { items: [], nextCursor: null };

    const r2BaseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;

    const viewer = await this.viewerContextService.getViewer(viewerUserId);
    const allowedVisibilities =
      this.enrichment.allowedVisibilitiesForViewer(viewer);

    const baseWhere: Prisma.PostMediaWhereInput = {
      kind: { in: ["image", "video"] },
      source: "upload",
      ...NOT_DELETED,
      post: {
        communityGroupId: { in: groupIds },
        ...NOT_DELETED,
        visibility: { in: allowedVisibilities },
      },
    };

    type MediaRow = {
      id: string;
      kind: PostMediaKind;
      r2Key: string | null;
      thumbnailR2Key: string | null;
      width: number | null;
      height: number | null;
      durationSeconds: number | null;
      postId: string;
    };

    let mediaRows: MediaRow[];

    const offset =
      sort === "trending" && cursor
        ? (() => {
            try {
              return (
                parseInt(Buffer.from(cursor, "base64").toString("utf8"), 10) ||
                0
              );
            } catch {
              return 0;
            }
          })()
        : 0;

    if (sort === "trending") {
      mediaRows = await this.prisma.postMedia.findMany({
        where: baseWhere,
        orderBy: [
          { post: { trendingScore: { sort: "desc", nulls: "last" } } },
          { post: { boostCount: "desc" } },
          { post: { bookmarkCount: "desc" } },
          { post: { repostCount: "desc" } },
          { post: { commentCount: "desc" } },
          { post: { createdAt: "desc" } },
          { id: "desc" },
        ],
        skip: offset,
        take: limit + 1,
        select: {
          id: true,
          kind: true,
          r2Key: true,
          thumbnailR2Key: true,
          width: true,
          height: true,
          durationSeconds: true,
          postId: true,
        },
      });
    } else {
      mediaRows = await this.prisma.postMedia.findMany({
        where: { ...baseWhere, ...(cursor ? { id: { lt: cursor } } : {}) },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: limit + 1,
        select: {
          id: true,
          kind: true,
          r2Key: true,
          thumbnailR2Key: true,
          width: true,
          height: true,
          durationSeconds: true,
          postId: true,
        },
      });
    }

    const mediaPage = toPage(mediaRows, limit, (m) => m.id);
    const items = mediaPage.items;
    const hasMore = mediaPage.nextCursor !== null;

    let nextCursor: string | null = null;
    if (hasMore) {
      if (sort === "trending") {
        nextCursor = Buffer.from(String(offset + limit)).toString("base64");
      } else {
        nextCursor = items[items.length - 1]?.id ?? null;
      }
    }

    return {
      items: items.map((m) => ({
        id: m.id,
        postId: m.postId,
        kind: m.kind as "image" | "video",
        url: r2BaseUrl && m.r2Key ? `${r2BaseUrl}/${m.r2Key}` : null,
        thumbnailUrl:
          r2BaseUrl && m.thumbnailR2Key
            ? `${r2BaseUrl}/${m.thumbnailR2Key}`
            : null,
        width: m.width,
        height: m.height,
        durationSeconds: m.durationSeconds ?? null,
      })),
      nextCursor,
    };
  }

  async listMediaForCommunityGroup(params: {
    viewerUserId: string;
    groupId: string;
    limit: number;
    cursor: string | null;
    sort: "new" | "trending";
  }) {
    const { viewerUserId, groupId, limit, cursor, sort } = params;
    await this.listings.assertCanReadCommunityGroup(viewerUserId, groupId);

    const r2BaseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;

    const baseWhere: Prisma.PostMediaWhereInput = {
      kind: { in: ["image", "video"] },
      source: "upload",
      ...NOT_DELETED,
      post: {
        communityGroupId: groupId,
        ...NOT_DELETED,
      },
    };

    type MediaRow = {
      id: string;
      kind: PostMediaKind;
      r2Key: string | null;
      thumbnailR2Key: string | null;
      width: number | null;
      height: number | null;
      durationSeconds: number | null;
      postId: string;
    };

    let mediaRows: MediaRow[];

    const offset =
      sort === "trending" && cursor
        ? (() => {
            try {
              return (
                parseInt(Buffer.from(cursor, "base64").toString("utf8"), 10) ||
                0
              );
            } catch {
              return 0;
            }
          })()
        : 0;

    if (sort === "trending") {
      mediaRows = await this.prisma.postMedia.findMany({
        where: baseWhere,
        orderBy: [
          { post: { trendingScore: { sort: "desc", nulls: "last" } } },
          { post: { boostCount: "desc" } },
          { post: { bookmarkCount: "desc" } },
          { post: { repostCount: "desc" } },
          { post: { commentCount: "desc" } },
          { post: { createdAt: "desc" } },
          { id: "desc" },
        ],
        skip: offset,
        take: limit + 1,
        select: {
          id: true,
          kind: true,
          r2Key: true,
          thumbnailR2Key: true,
          width: true,
          height: true,
          durationSeconds: true,
          postId: true,
        },
      });
    } else {
      mediaRows = await this.prisma.postMedia.findMany({
        where: { ...baseWhere, ...(cursor ? { id: { lt: cursor } } : {}) },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: limit + 1,
        select: {
          id: true,
          kind: true,
          r2Key: true,
          thumbnailR2Key: true,
          width: true,
          height: true,
          durationSeconds: true,
          postId: true,
        },
      });
    }

    const mediaPage = toPage(mediaRows, limit, (m) => m.id);
    const items = mediaPage.items;
    const hasMore = mediaPage.nextCursor !== null;

    let nextCursor: string | null = null;
    if (hasMore) {
      if (sort === "trending") {
        nextCursor = Buffer.from(String(offset + limit)).toString("base64");
      } else {
        nextCursor = items[items.length - 1]?.id ?? null;
      }
    }

    return {
      items: items.map((m) => ({
        id: m.id,
        postId: m.postId,
        kind: m.kind as "image" | "video",
        url: r2BaseUrl && m.r2Key ? `${r2BaseUrl}/${m.r2Key}` : null,
        thumbnailUrl:
          r2BaseUrl && m.thumbnailR2Key
            ? `${r2BaseUrl}/${m.thumbnailR2Key}`
            : null,
        width: m.width,
        height: m.height,
        durationSeconds: m.durationSeconds ?? null,
      })),
      nextCursor,
    };
  }

  /**
   * Cursor-paginated list of users who flat-reposted a post.
   * Ordered newest-repost-first. Soft-deleted reposts are excluded.
   */
  async listReposters(params: {
    viewerUserId: string | null;
    postId: string;
    limit: number;
    cursor: string | null;
  }): Promise<{ authors: PostAuthorDto[]; nextCursor: string | null }> {
    const { viewerUserId, postId, limit, cursor } = params;

    const post = await this.prisma.post.findFirst({
      where: { id: postId, ...NOT_DELETED },
      select: {
        id: true,
        visibility: true,
        userId: true,
        communityGroupId: true,
      },
    });
    if (!post) throw new NotFoundException("Post not found.");

    const viewer = await this.viewerContextService.getViewer(viewerUserId);
    const allowed = this.enrichment.allowedVisibilitiesForViewer(viewer);
    if (!allowed.includes(post.visibility))
      throw new NotFoundException("Post not found.");

    // Enforce group membership — non-members must not enumerate reposters of a private group post.
    try {
      await this.access.assertReadableCommunityGroupPost(
        post,
        viewerUserId,
        viewer,
      );
    } catch {
      throw new NotFoundException("Post not found.");
    }

    const reposts = await this.prisma.post.findMany({
      where: {
        kind: "repost",
        repostedPostId: postId,
        ...NOT_DELETED,
        ...(cursor ? { createdAt: { lt: new Date(cursor) } } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: limit + 1,
      include: { user: { select: USER_LIST_SELECT } },
    });

    const { items: page, nextCursor } = toPage(reposts, limit, (r) =>
      r.createdAt.toISOString(),
    );
    const r2BaseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;
    const authors = page
      .map((r) => toPostAuthorDtoFromFeedRow(r as any, r2BaseUrl))
      .filter((a): a is PostAuthorDto => a !== null);
    return { authors, nextCursor };
  }

  /**
   * Cursor-paginated list of posts that quote a given post (quotedPostId = postId).
   * Applies full viewer gating on the quoting posts themselves.
   */
  async listQuotes(params: {
    viewerUserId: string | null;
    postId: string;
    limit: number;
    cursor: string | null;
  }): Promise<{ posts: FeedPost[]; nextCursor: string | null }> {
    const { viewerUserId, postId, limit, cursor } = params;

    const post = await this.prisma.post.findFirst({
      where: { id: postId, ...NOT_DELETED, isDraft: false },
      select: {
        id: true,
        visibility: true,
        userId: true,
        communityGroupId: true,
      },
    });
    if (!post) throw new NotFoundException("Post not found.");

    const viewer = await this.viewerContextService.getViewer(viewerUserId);
    const allowed = this.enrichment.allowedVisibilitiesForViewer(viewer);
    if (!allowed.includes(post.visibility))
      throw new NotFoundException("Post not found.");

    // Enforce group membership — non-members must not list quotes of a private group post.
    try {
      await this.access.assertReadableCommunityGroupPost(
        post,
        viewerUserId,
        viewer,
      );
    } catch {
      throw new NotFoundException("Post not found.");
    }

    const quotes = await this.prisma.post.findMany({
      where: {
        quotedPostId: postId,
        ...NOT_DELETED,
        isDraft: false,
        visibility: { in: allowed },
        kind: { not: "repost" },
        ...(cursor ? { createdAt: { lt: new Date(cursor) } } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: limit + 1,
      include: {
        user: { select: USER_LIST_SELECT },
        media: { orderBy: { position: "asc" } },
        mentions: { include: { user: { select: MENTION_USER_SELECT } } },
      },
    });

    const { items: page, nextCursor } = toPage(quotes, limit, (q) =>
      q.createdAt.toISOString(),
    );
    const visibleQuotes = await this.access.filterPostsByCommunityGroupAccess({
      viewerUserId,
      viewer,
      posts: page as unknown as FeedPost[],
    });
    return { posts: visibleQuotes, nextCursor };
  }
}
