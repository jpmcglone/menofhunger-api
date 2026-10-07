import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
} from "@nestjs/common";
import {MutesService} from "../mutes/mutes.service";
import type {
  CommunityGroupJoinPolicy,
  PostVisibility,
} from "@prisma/client";
import {PrismaService} from "../prisma/prisma.service";
import {RequestCacheService} from "../../common/cache/request-cache.service";
import {
  ViewerContextService,
  type ViewerContext,
} from "../viewer/viewer-context.service";
import {POSTS_RANKING} from "./posts-ranking.config";
import {
  notDeletedWhere,
} from "./posts-query-builders";
import {
  type FeedPost,
} from "./posts-feed.types";
import {PostsViewerEnrichmentService} from "./posts-viewer-enrichment.service";
import {CacheService} from "../redis/cache.service";
import {stableJsonHash} from "../redis/redis-keys";

export type ReadablePostShell = {
  id: string;
  userId: string;
  visibility: PostVisibility;
  rootId: string | null;
  communityGroupId: string | null;
};

@Injectable()
export class PostsFeedAccessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly requestCache: RequestCacheService,
    private readonly viewerContextService: ViewerContextService,
    private readonly enrichment: PostsViewerEnrichmentService,
    private readonly cache: CacheService,
    @Optional() private readonly mutes?: MutesService,
  ) {}
  async viewerMutedIds(viewerUserId: string | null): Promise<string[]> {
    if (!viewerUserId || !this.mutes) return [];
    return [...(await this.mutes.mutedIds(viewerUserId))];
  }

  /**
   * Group post read access:
   *   • OPEN groups: any signed-in, verified user can read posts.
   *   • PRIVATE (approval) groups: members-only.
   * Posting still requires active membership regardless of joinPolicy — that
   * gate lives on the create path, not here.
   */
  async assertReadableCommunityGroupPost(
    post: { userId: string; communityGroupId: string | null },
    viewerUserId: string | null,
    viewer: ViewerContext | null,
    opts?: {
      knownActiveMember?: boolean;
      knownGroupJoinPolicy?: CommunityGroupJoinPolicy;
    },
  ): Promise<void> {
    const gid = post.communityGroupId;
    if (!gid) return;
    if (viewer?.siteAdmin) return;
    if (viewerUserId && post.userId === viewerUserId) return;
    // Anonymous users can never join an approval group — treat as not found so the
    // permalink fallback path does not leak author/body metadata to unauthenticated callers.
    if (!viewerUserId) throw new NotFoundException("Post not found.");
    if (opts?.knownActiveMember) return;

    let joinPolicy: CommunityGroupJoinPolicy | null =
      opts?.knownGroupJoinPolicy ?? null;
    if (!joinPolicy) {
      const g = await this.prisma.communityGroup.findUnique({
        where: { id: gid },
        select: { joinPolicy: true },
      });
      joinPolicy = g?.joinPolicy ?? "approval";
    }

    if (joinPolicy === "open") {
      if (this.viewerContextService.isVerified(viewer)) return;
      // Unverified users hitting an open group: keep as Forbidden (verifying grants access,
      // similar to verifiedOnly tier). The permalink will show the verify-prompt preview.
      throw new ForbiddenException("Verify your account to view group posts.");
    }

    const m = await this.prisma.communityGroupMember.findUnique({
      where: { groupId_userId: { groupId: gid, userId: viewerUserId } },
      select: { status: true },
    });
    // Approval-group non-members: 404 so the permalink returns not-found instead of
    // leaking author identity, engagement counts, and a body snippet via getByIdNoAccess.
    if (!m || m.status !== "active") {
      throw new NotFoundException("Post not found.");
    }
  }

  /**
   * Same visibility + group gates as getById, without the feed include.
   * Comments and thread-participants only need access, not the full row.
   */
  async assertViewerCanReadListedPost(params: {
    post: ReadablePostShell;
    viewerUserId: string | null;
    viewer: ViewerContext | null;
  }): Promise<void> {
    const { post, viewerUserId, viewer } = params;
    const gid = post.communityGroupId;
    const isSelf = Boolean(viewer && viewer.id === post.userId);
    let knownActiveGroupMember = false;
    if (!isSelf && gid && viewerUserId && !viewer?.siteAdmin) {
      const m = await this.prisma.communityGroupMember.findUnique({
        where: { groupId_userId: { groupId: gid, userId: viewerUserId } },
        select: { status: true },
      });
      knownActiveGroupMember = m?.status === "active";
    }

    if (!isSelf) {
      if (post.visibility === "onlyMe" && !viewer?.siteAdmin) {
        throw new ForbiddenException("This post is private.");
      }
      const allowed = this.enrichment.allowedVisibilitiesForViewer(viewer);
      if (!allowed.includes(post.visibility)) {
        if (post.visibility === "verifiedOnly")
          throw new ForbiddenException("Verify to view verified-only posts.");
        if (post.visibility === "premiumOnly") {
          throw new ForbiddenException(
            "Upgrade to premium to view premium-only posts.",
          );
        }
        throw new ForbiddenException("Not allowed to view this post.");
      }
    }

    await this.assertReadableCommunityGroupPost(
      { userId: post.userId, communityGroupId: gid },
      viewerUserId,
      viewer,
      knownActiveGroupMember ? { knownActiveMember: true } : undefined,
    );
  }

  async requireReadablePostShell(params: {
    viewerUserId: string | null;
    id: string;
  }): Promise<ReadablePostShell> {
    const { viewerUserId, id } = params;
    const postId = (id ?? "").trim();
    if (!postId) throw new NotFoundException("Post not found.");

    const shellKey = `posts.readShell:${viewerUserId ?? "anon"}:${postId}`;
    const cachedShell = this.requestCache.get<ReadablePostShell>(shellKey);
    if (cachedShell) return cachedShell;

    const fullKey = `posts.getById:${viewerUserId ?? "anon"}:${postId}`;
    const cachedFull = this.requestCache.get<FeedPost>(fullKey);
    if (cachedFull) {
      const fromFull: ReadablePostShell = {
        id: cachedFull.id,
        userId: cachedFull.userId,
        visibility: cachedFull.visibility,
        rootId: (cachedFull as { rootId?: string | null }).rootId ?? null,
        communityGroupId:
          (cachedFull as { communityGroupId?: string | null })
            .communityGroupId ?? null,
      };
      this.requestCache.set(shellKey, fromFull);
      return fromFull;
    }

    const viewer = await this.viewerContextService.getViewer(viewerUserId);
    const post = await this.prisma.post.findFirst({
      where: { id: postId, ...(viewer?.siteAdmin ? {} : notDeletedWhere()) },
      select: {
        id: true,
        userId: true,
        visibility: true,
        rootId: true,
        communityGroupId: true,
      },
    });
    if (!post) throw new NotFoundException("Post not found.");

    await this.assertViewerCanReadListedPost({ post, viewerUserId, viewer });
    this.requestCache.set(shellKey, post);
    return post;
  }

  async filterPostsByCommunityGroupAccess(params: {
    viewerUserId: string | null;
    viewer: ViewerContext | null;
    posts: FeedPost[];
  }): Promise<FeedPost[]> {
    const { viewerUserId, viewer, posts } = params;
    const groupIds = [
      ...new Set(
        posts
          .map(
            (p) => (p as { communityGroupId?: string | null }).communityGroupId,
          )
          .filter((x): x is string => Boolean(x)),
      ),
    ];
    if (groupIds.length === 0) return posts;

    // Fetch joinPolicy for each referenced group so OPEN groups can pass through
    // for verified non-members (posts in OPEN groups are readable by any
    // verified user; PRIVATE/approval groups remain members-only).
    const groups = await this.prisma.communityGroup.findMany({
      where: { id: { in: groupIds } },
      select: { id: true, joinPolicy: true },
    });
    const policyByGroup = new Map(
      groups.map((g) => [g.id, g.joinPolicy] as const),
    );

    let memberGroupIds = new Set<string>();
    if (viewerUserId) {
      const rows = await this.prisma.communityGroupMember.findMany({
        where: {
          userId: viewerUserId,
          groupId: { in: groupIds },
          status: "active",
        },
        select: { groupId: true },
      });
      memberGroupIds = new Set(rows.map((r) => r.groupId));
    }

    const viewerVerified = this.viewerContextService.isVerified(viewer);

    return posts.filter((p) => {
      const gid =
        (p as { communityGroupId?: string | null }).communityGroupId ?? null;
      if (!gid) return true;
      if (viewer?.siteAdmin) return true;
      if (viewerUserId && p.userId === viewerUserId) return true;
      if (memberGroupIds.has(gid)) return true;
      if (viewerVerified && policyByGroup.get(gid) === "open") return true;
      return false;
    });
  }

  encodePopularCursor(cursor: {
    score: number;
    createdAt: string;
    id: string;
  }) {
    return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
  }

  decodePopularCursor(
    token: string | null,
  ): { score: number; createdAt: string; id: string } | null {
    const t = (token ?? "").trim();
    if (!t) return null;
    try {
      const raw = Buffer.from(t, "base64url").toString("utf8");
      // Accept both old cursors (with asOf field) and new cursors (without).
      const parsed = JSON.parse(raw) as Partial<{
        asOf: string;
        score: number;
        createdAt: string;
        id: string;
      }>;
      const createdAt =
        typeof parsed.createdAt === "string" ? parsed.createdAt : "";
      const id = typeof parsed.id === "string" ? parsed.id : "";
      const score =
        typeof parsed.score === "number" && Number.isFinite(parsed.score)
          ? parsed.score
          : NaN;
      if (!createdAt || !id) return null;
      if (!Number.isFinite(score)) return null;
      return { score, createdAt, id };
    } catch {
      return null;
    }
  }

  async encodeForYouCursor(
    servedIds: string[],
    seed: string,
    viewerUserId: string | null,
  ) {
    const ids = [...new Set(servedIds.filter(Boolean))];
    if (!ids.length || ids.length >= POSTS_RANKING.forYouSessionMaxPosts)
      return null;
    // Immutable records keep retries and concurrent pagination from advancing each other.
    const ref = stableJsonHash({ ids, seed, viewerUserId });
    try {
      await this.cache.setJson(
        `feed:foryou:cursor:v4:${ref}`,
        { ids, seed, viewerUserId },
        {
          ttlSeconds: POSTS_RANKING.forYouSessionTtlSeconds,
        },
      );
      return Buffer.from(JSON.stringify({ v: 4, ref, seed })).toString(
        "base64url",
      );
    } catch {
      // During a Redis outage, continue a short session without losing exclusion history.
      if (ids.length > POSTS_RANKING.forYouInlineCursorMaxPosts) return null;
      return Buffer.from(JSON.stringify({ v: 3, s: ids, seed })).toString(
        "base64url",
      );
    }
  }

  async decodeForYouCursor(
    token: string | null,
    viewerUserId: string | null,
  ): Promise<{
    servedIds: string[];
    seed: string | null;
    legacyPopular: { score: number; createdAt: string; id: string } | null;
  }> {
    const empty = { servedIds: [], seed: null, legacyPopular: null };
    const t = (token ?? "").trim();
    if (!t) return empty;
    let parsed: { v?: number; ref?: string; s?: unknown; seed?: string };
    try {
      parsed = JSON.parse(Buffer.from(t, "base64url").toString("utf8"));
    } catch {
      throw new BadRequestException(
        "Feed session expired. Refresh your feed to continue.",
      );
    }
    if (!parsed || typeof parsed !== "object")
      throw new BadRequestException("Refresh your feed to continue.");
    if (parsed.v === 4) {
      const state =
        typeof parsed.ref === "string" && /^[a-f0-9]{20}$/.test(parsed.ref)
          ? await this.cache
              .getJson<{
                ids: string[];
                seed: string;
                viewerUserId: string | null;
              }>(`feed:foryou:cursor:v4:${parsed.ref}`)
              .catch(() => null)
          : null;
      if (
        !state ||
        state.viewerUserId !== viewerUserId ||
        !Array.isArray(state.ids) ||
        state.ids.length > POSTS_RANKING.forYouSessionMaxPosts
      ) {
        throw new BadRequestException(
          "Feed session expired. Refresh your feed to continue.",
        );
      }
      return { servedIds: state.ids, seed: state.seed, legacyPopular: null };
    }
    if ((parsed.v === 3 || parsed.v === 2) && Array.isArray(parsed.s)) {
      // Preserve old in-flight sessions, but never truncate IDs and make them eligible again.
      const ids = [
        ...new Set(
          parsed.s.filter(
            (id): id is string => typeof id === "string" && Boolean(id.trim()),
          ),
        ),
      ];
      if (ids.length > POSTS_RANKING.forYouCursorServedIdMax)
        throw new BadRequestException("Refresh your feed to continue.");
      return {
        servedIds: ids,
        seed: typeof parsed.seed === "string" ? parsed.seed : null,
        legacyPopular: null,
      };
    }
    const legacyPopular = this.decodePopularCursor(t);
    if (!legacyPopular)
      throw new BadRequestException(
        "Feed session expired. Refresh your feed to continue.",
      );
    return { ...empty, legacyPopular };
  }

  /**
   * Returns userIds the viewer follows for "following" feed scope.
   * The viewer is intentionally excluded so their own posts do not appear in
   * the home Following/All feeds (only other people's posts are returned).
   * Used by trending (popular) feed when followingOnly is true.
   */
  async getAuthorIdsForFollowingFilter(
    viewerUserId: string,
  ): Promise<string[]> {
    const follows = await this.prisma.follow.findMany({
      where: { followerId: viewerUserId },
      select: { followingId: true },
    });
    return follows.map((f) => f.followingId);
  }

  /** Ranking signals only: permissions and block filters are always read fresh. */
  rankingInput<T>(
    viewerUserId: string | null,
    name: string,
    compute: () => Promise<T>,
  ): Promise<T> {
    if (!viewerUserId) return compute();
    return this.cache.getOrSetJson({
      enabled: true,
      key: `cache:forYou:input:v1:${viewerUserId}:${name}`,
      ttlSeconds: 15,
      compute,
    });
  }
}
