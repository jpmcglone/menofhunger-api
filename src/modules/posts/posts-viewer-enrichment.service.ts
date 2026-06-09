import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RequestCacheService } from '../../common/cache/request-cache.service';
import { ViewerContextService, type ViewerContext } from '../viewer/viewer-context.service';
import { RedisService } from '../redis/redis.service';
import { RedisKeys } from '../redis/redis-keys';

/**
 * Viewer-scoped post enrichment: which posts the viewer boosted / reposted /
 * bookmarked / voted on, viewer block sets, and visibility tiers. These power
 * the per-viewer overlay fields on post DTOs (viewerHasBoosted, etc.).
 */
@Injectable()
export class PostsViewerEnrichmentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly requestCache: RequestCacheService,
    private readonly viewerContextService: ViewerContextService,
    private readonly redis: RedisService,
  ) {}

  async viewerContext(viewerUserId: string | null) {
    return await this.viewerContextService.getViewer(viewerUserId);
  }

  async viewerBoostedPostIds(params: { viewerUserId: string; postIds: string[] }) {
    const { viewerUserId, postIds } = params;
    if (!viewerUserId) return new Set<string>();
    const ids = (postIds ?? []).filter(Boolean);
    if (ids.length === 0) return new Set<string>();

    const key = `posts.viewerBoosted:${viewerUserId}`;
    const map = this.requestCache.get<Map<string, boolean>>(key) ?? new Map<string, boolean>();
    if (this.requestCache.get<Map<string, boolean>>(key) == null) {
      this.requestCache.set(key, map);
    }

    const missing = ids.filter((id) => !map.has(id));
    if (missing.length > 0) {
      const boosts = await this.prisma.boost.findMany({
        where: { userId: viewerUserId, postId: { in: missing } },
        select: { postId: true },
      });
      const boostedSet = new Set(boosts.map((b) => b.postId));
      for (const id of missing) map.set(id, boostedSet.has(id));
    }

    const out = new Set<string>();
    for (const id of ids) if (map.get(id)) out.add(id);
    return out;
  }

  /** Returns the set of canonical post IDs that the viewer has flat-reposted. */
  async viewerRepostedPostIds(params: { viewerUserId: string; postIds: string[] }) {
    const { viewerUserId, postIds } = params;
    if (!viewerUserId) return new Set<string>();
    const ids = (postIds ?? []).filter(Boolean);
    if (ids.length === 0) return new Set<string>();

    const key = `posts.viewerReposted:${viewerUserId}`;
    const map = this.requestCache.get<Map<string, boolean>>(key) ?? new Map<string, boolean>();
    if (this.requestCache.get<Map<string, boolean>>(key) == null) {
      this.requestCache.set(key, map);
    }

    const missing = ids.filter((id) => !map.has(id));
    if (missing.length > 0) {
      const reposts = await this.prisma.post.findMany({
        where: { userId: viewerUserId, kind: 'repost', repostedPostId: { in: missing }, deletedAt: null },
        select: { repostedPostId: true },
      });
      const repostedSet = new Set((reposts as Array<{ repostedPostId: string | null }>).map((r) => r.repostedPostId).filter(Boolean));
      for (const id of missing) map.set(id, repostedSet.has(id));
    }

    const out = new Set<string>();
    for (const id of ids) if (map.get(id)) out.add(id);
    return out;
  }

  async viewerBookmarksByPostId(params: { viewerUserId: string; postIds: string[] }) {
    const { viewerUserId, postIds } = params;
    if (!viewerUserId) return new Map<string, { collectionIds: string[] }>();
    const ids = (postIds ?? []).filter(Boolean);
    if (ids.length === 0) return new Map<string, { collectionIds: string[] }>();

    const cacheKey = `posts.viewerBookmarks:${viewerUserId}`;
    const cached =
      this.requestCache.get<Map<string, { collectionIds: string[] } | null>>(cacheKey) ??
      new Map<string, { collectionIds: string[] } | null>();
    if (this.requestCache.get<Map<string, { collectionIds: string[] } | null>>(cacheKey) == null) {
      this.requestCache.set(cacheKey, cached);
    }

    const missing = ids.filter((id) => !cached.has(id));

    let rows: Array<{ postId: string; collections: Array<{ collectionId: string }> }>;
    try {
      rows = missing.length
        ? await this.prisma.bookmark.findMany({
            where: { userId: viewerUserId, postId: { in: missing } },
            select: { postId: true, collections: { select: { collectionId: true } } },
          })
        : [];
    } catch (e: unknown) {
      // If migrations haven't been applied yet, don't crash the entire feed.
      // Prisma throws P2021 when the underlying table doesn't exist.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2021') {
        return new Map<string, { collectionIds: string[] }>();
      }
      throw e;
    }

    // Populate cache with missing IDs (including explicit nulls for "not bookmarked").
    for (const id of missing) cached.set(id, null);
    for (const r of rows) {
      cached.set(r.postId, { collectionIds: (r.collections ?? []).map((c) => c.collectionId) });
    }

    const out = new Map<string, { collectionIds: string[] }>();
    for (const id of ids) {
      const v = cached.get(id);
      if (v) out.set(id, v);
    }
    return out;
  }

  async viewerVotedPollOptionIdByPostId(params: { viewerUserId: string; postIds: string[] }) {
    const { viewerUserId, postIds } = params;
    if (!viewerUserId) return new Map<string, string>();
    const ids = (postIds ?? []).filter(Boolean);
    if (ids.length === 0) return new Map<string, string>();

    const cacheKey = `posts.viewerPollVotes:${viewerUserId}`;
    const cached =
      this.requestCache.get<Map<string, string | null>>(cacheKey) ??
      new Map<string, string | null>();
    if (this.requestCache.get<Map<string, string | null>>(cacheKey) == null) {
      this.requestCache.set(cacheKey, cached);
    }

    const missing = ids.filter((id) => !cached.has(id));
    if (missing.length > 0) {
      const rows = await this.prisma.postPollVote.findMany({
        where: { userId: viewerUserId, poll: { postId: { in: missing } } },
        select: { optionId: true, poll: { select: { postId: true } } },
      });
      for (const id of missing) cached.set(id, null);
      for (const r of rows) cached.set(r.poll.postId, r.optionId);
    }

    const out = new Map<string, string>();
    for (const id of ids) {
      const v = cached.get(id);
      if (v) out.set(id, v);
    }
    return out;
  }

  allowedVisibilitiesForViewer(viewer: Pick<ViewerContext, 'verifiedStatus' | 'premium' | 'premiumPlus'> | null) {
    return this.viewerContextService.allowedPostVisibilities(viewer);
  }

  /** Public helper: returns the visibility tiers the viewer can access. */
  allowedVisibilities(viewer: Pick<ViewerContext, 'verifiedStatus' | 'premium' | 'premiumPlus'> | null) {
    return this.viewerContextService.allowedPostVisibilities(viewer);
  }

  /**
   * Fetch the block relationship sets for a viewer.
   * Returns sets of author IDs: those blocked by viewer and those blocking viewer.
   * Used to annotate post DTOs with `viewerBlockStatus`.
   */
  async viewerBlockSets(viewerUserId: string): Promise<{ blockedByViewer: Set<string>; viewerBlockedBy: Set<string> }> {
    const cacheKey = RedisKeys.viewerBlockSets(viewerUserId);
    try {
      const cached = await this.redis.getJson<{ blockedByViewer: string[]; viewerBlockedBy: string[] }>(cacheKey);
      if (cached) {
        return {
          blockedByViewer: new Set(cached.blockedByViewer),
          viewerBlockedBy: new Set(cached.viewerBlockedBy),
        };
      }
    } catch {
      // Redis unavailable — fall through to DB.
    }

    const rows = await this.prisma.userBlock.findMany({
      where: { OR: [{ blockerId: viewerUserId }, { blockedId: viewerUserId }] },
      select: { blockerId: true, blockedId: true },
    });
    const blockedByViewer = new Set<string>();
    const viewerBlockedBy = new Set<string>();
    for (const row of rows) {
      if (row.blockerId === viewerUserId) blockedByViewer.add(row.blockedId);
      else viewerBlockedBy.add(row.blockerId);
    }

    void this.redis.setJson(cacheKey, {
      blockedByViewer: [...blockedByViewer],
      viewerBlockedBy: [...viewerBlockedBy],
    }, { ttlSeconds: 5 * 60 }).catch(() => undefined);

    return { blockedByViewer, viewerBlockedBy };
  }

  /** Bust cached block sets for both sides of a block/unblock action. */
  invalidateBlockSetsCache(userId1: string, userId2: string): void {
    void this.redis.del(RedisKeys.viewerBlockSets(userId1), RedisKeys.viewerBlockSets(userId2)).catch(() => undefined);
  }

  // ─── User media grid ──────────────────────────────────────────────────────
}
