import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { PostVisibility, VerifiedStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PresenceRealtimeService } from '../presence/presence-realtime.service';
import { ViewerContextService } from '../viewer/viewer-context.service';
import { PostViewsService } from '../post-views/post-views.service';
import { JobsService } from '../jobs/jobs.service';
import { JOBS } from '../jobs/jobs.constants';
import { RedisService } from '../redis/redis.service';
import { RedisKeys } from '../redis/redis-keys';

const COLLECTIONS_CACHE_TTL_SECONDS = 60;

type Viewer = { id: string; verifiedStatus: VerifiedStatus; premium: boolean };

function slugifyCollectionName(name: string): string {
  return (name ?? '')
    .toString()
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
}

const RESERVED_COLLECTION_SLUGS = new Set<string>(['unorganized']);

@Injectable()
export class BookmarksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly presenceRealtime: PresenceRealtimeService,
    private readonly viewerContext: ViewerContextService,
    private readonly postViews: PostViewsService,
    private readonly jobs: JobsService,
    private readonly redis: RedisService,
  ) {}

  private invalidateCollectionsCache(userId: string): void {
    void this.redis.del(RedisKeys.bookmarksCollections(userId)).catch(() => undefined);
  }

  private enqueueScoreRefresh(postId: string): void {
    if (!postId) return;
    this.jobs
      .enqueue(
        JOBS.postsRefreshSinglePostScore,
        { postId },
        { jobId: `score-${postId}`, removeOnComplete: true, removeOnFail: true },
      )
      .catch(() => {});
  }

  private async viewer(userId: string): Promise<Viewer> {
    const u = (await this.viewerContext.getViewer(userId)) as any;
    if (!u) throw new NotFoundException('User not found.');
    return u as Viewer;
  }

  private allowedVisibilitiesForViewer(viewer: Viewer): PostVisibility[] {
    return this.viewerContext.allowedPostVisibilities(viewer as any);
  }

  private visibleBookmarkPostWhere(userId: string) {
    return {
      OR: [
        { communityGroupId: null },
        {
          communityGroup: {
            members: {
              some: {
                userId,
                status: 'active',
              },
            },
          },
        },
      ],
    } satisfies import('@prisma/client').Prisma.PostWhereInput;
  }

  private async visibleBookmarkCountsByCollection(userId: string): Promise<Map<string, number>> {
    const grouped = await this.prisma.bookmarkCollectionItem.groupBy({
      by: ['collectionId'],
      where: {
        collection: { userId },
        bookmark: {
          userId,
          post: this.visibleBookmarkPostWhere(userId),
        },
      },
      _count: { collectionId: true },
    });
    return new Map(grouped.map((row) => [row.collectionId, row._count.collectionId]));
  }

  private async visibleBookmarkCountForCollection(userId: string, collectionId: string): Promise<number> {
    return await this.prisma.bookmarkCollectionItem.count({
      where: {
        collectionId,
        collection: { userId },
        bookmark: {
          userId,
          post: this.visibleBookmarkPostWhere(userId),
        },
      },
    });
  }

  private async assertViewerCanBookmarkPost(params: { viewerUserId: string; postId: string }): Promise<{
    postUserId: string;
  }> {
    const { viewerUserId, postId } = params;
    const viewer = await this.viewer(viewerUserId);
    const allowed = this.allowedVisibilitiesForViewer(viewer);

    const post = await this.prisma.post.findFirst({
      where: { id: postId, deletedAt: null },
      select: { id: true, userId: true, visibility: true, communityGroupId: true },
    });
    if (!post) throw new NotFoundException('Post not found.');

    if (post.communityGroupId) {
      const membership = await this.prisma.communityGroupMember.findUnique({
        where: { groupId_userId: { groupId: post.communityGroupId, userId: viewerUserId } },
        select: { status: true },
      });
      if (!membership || membership.status !== 'active') {
        throw new ForbiddenException('Join this group to bookmark its posts.');
      }
    }

    if (post.visibility === 'onlyMe') {
      if (post.userId !== viewerUserId) throw new ForbiddenException('Post not found.');
      return { postUserId: post.userId };
    }
    if (!allowed.includes(post.visibility)) throw new ForbiddenException('Post not found.');
    return { postUserId: post.userId };
  }

  async listCollections(params: { userId: string }) {
    const { userId } = params;

    const cacheKey = RedisKeys.bookmarksCollections(userId);
    try {
      const cached = await this.redis.getJson<ReturnType<typeof this._listCollectionsRaw> extends Promise<infer T> ? T : never>(cacheKey);
      if (cached) return cached;
    } catch {
      // Redis unavailable — fall through to DB.
    }

    const result = await this._listCollectionsRaw(userId);
    void this.redis.setJson(cacheKey, result, { ttlSeconds: COLLECTIONS_CACHE_TTL_SECONDS }).catch(() => undefined);
    return result;
  }

  private async _listCollectionsRaw(userId: string) {
    const visiblePostWhere = this.visibleBookmarkPostWhere(userId);
    const [collections, visibleCountsByCollection, totalCount, unorganizedCount] = await Promise.all([
      this.prisma.bookmarkCollection.findMany({
        where: { userId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: {
          id: true,
          name: true,
          slug: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
      this.visibleBookmarkCountsByCollection(userId),
      this.prisma.bookmark.count({ where: { userId, post: visiblePostWhere } }),
      this.prisma.bookmark.count({ where: { userId, post: visiblePostWhere, collections: { none: {} } } }),
    ]);
    return {
      collections: collections.map((c) => ({
        id: c.id,
        name: c.name,
        slug: c.slug,
        bookmarkCount: visibleCountsByCollection.get(c.id) ?? 0,
        createdAt: c.createdAt.toISOString(),
        updatedAt: c.updatedAt.toISOString(),
      })),
      summary: {
        totalCount,
        unorganizedCount,
      },
    };
  }

  async createCollection(params: { userId: string; name: string }) {
    const { userId } = params;
    const name = (params.name ?? '').trim();
    if (!name) throw new BadRequestException('Name is required.');
    if (name.length > 40) throw new BadRequestException('Name is too long.');

    const slug = slugifyCollectionName(name);
    if (!slug) throw new BadRequestException('Folder name is invalid.');
    if (RESERVED_COLLECTION_SLUGS.has(slug)) throw new BadRequestException('Folder name is reserved.');

    const existingSlug = await this.prisma.bookmarkCollection.findFirst({ where: { userId, slug }, select: { id: true } });
    if (existingSlug) throw new BadRequestException('Folder already exists.');

    const created = await this.prisma.bookmarkCollection.create({
      data: { userId, name, slug },
      select: { id: true, name: true, slug: true, createdAt: true, updatedAt: true },
    });
    this.invalidateCollectionsCache(userId);
    return {
      collection: {
        id: created.id,
        name: created.name,
        slug: created.slug,
        bookmarkCount: 0,
        createdAt: created.createdAt.toISOString(),
        updatedAt: created.updatedAt.toISOString(),
      },
    };
  }

  async renameCollection(params: { userId: string; id: string; name: string }) {
    const { userId, id } = params;
    const name = (params.name ?? '').trim();
    if (!name) throw new BadRequestException('Name is required.');
    if (name.length > 40) throw new BadRequestException('Name is too long.');

    const existing = await this.prisma.bookmarkCollection.findFirst({ where: { id, userId }, select: { id: true, slug: true } });
    if (!existing) throw new NotFoundException('Collection not found.');

    const desiredSlug = slugifyCollectionName(name);
    if (!desiredSlug) throw new BadRequestException('Folder name is invalid.');
    if (RESERVED_COLLECTION_SLUGS.has(desiredSlug)) throw new BadRequestException('Folder name is reserved.');

    let slug = existing.slug;
    if (desiredSlug && desiredSlug !== existing.slug) {
      const collision = await this.prisma.bookmarkCollection.findFirst({
        where: { userId, slug: desiredSlug, NOT: { id } },
        select: { id: true },
      });
      // If the slug would collide, allow renaming the display name but keep the old slug stable.
      if (!collision) slug = desiredSlug;
    }

    const updated = await this.prisma.bookmarkCollection.update({
      where: { id },
      data: { name, slug },
      select: { id: true, name: true, slug: true, createdAt: true, updatedAt: true },
    });
    const bookmarkCount = await this.visibleBookmarkCountForCollection(userId, updated.id);
    this.invalidateCollectionsCache(userId);
    return {
      collection: {
        id: updated.id,
        name: updated.name,
        slug: updated.slug,
        bookmarkCount,
        createdAt: updated.createdAt.toISOString(),
        updatedAt: updated.updatedAt.toISOString(),
      },
    };
  }

  async deleteCollection(params: { userId: string; id: string }) {
    const { userId, id } = params;
    const existing = await this.prisma.bookmarkCollection.findFirst({ where: { id, userId }, select: { id: true } });
    if (!existing) throw new NotFoundException('Collection not found.');
    await this.prisma.bookmarkCollection.delete({ where: { id } });
    this.invalidateCollectionsCache(userId);
    return { success: true };
  }

  async setBookmark(params: { userId: string; postId: string; collectionIds?: string[] | null }) {
    const userId = (params.userId ?? '').trim();
    const postId = (params.postId ?? '').trim();
    if (!postId) throw new BadRequestException('Post id is required.');

    const { postUserId } = await this.assertViewerCanBookmarkPost({ viewerUserId: userId, postId });

    // Invariant: a bookmark is either "unorganized" (no folder memberships) or in one or more
    // folders — never both. `null` means "keep the existing folder state"; an explicit array
    // (including `[]`) performs a full replace of folder memberships. Sending `[]` is the only
    // way to explicitly move a bookmark to "unorganized".
    const desired: string[] | null = Array.isArray(params.collectionIds)
      ? Array.from(
          new Set(
            params.collectionIds
              .map((v) => (v ?? '').toString().trim())
              .filter(Boolean),
          ),
        )
      : null;

    if (desired !== null && desired.length > 0) {
      const ok = await this.prisma.bookmarkCollection.findMany({
        where: { userId, id: { in: desired } },
        select: { id: true },
      });
      if (ok.length !== desired.length) throw new NotFoundException('Folder not found.');
    }

    const bookmark = await this.prisma.$transaction(async (tx) => {
      const created = await tx.bookmark.createMany({
        data: [{ userId, postId }],
        skipDuplicates: true,
      });

      // Keep a fast counter on Post for UI + scoring.
      if (created.count > 0) {
        await tx.post.update({
          where: { id: postId },
          data: { bookmarkCount: { increment: created.count } },
        });
      }

      const row = await tx.bookmark.findUnique({
        where: { userId_postId: { userId, postId } },
        select: { id: true },
      });
      if (!row) throw new Error('Bookmark upsert failed.');

      // Folder membership: null = keep existing; [] = explicitly unorganized; [...] = full replace.
      if (desired === null) {
        // Keep existing folder memberships — no change.
      } else if (desired.length === 0) {
        // Explicitly unorganized: strip all folder memberships.
        await tx.bookmarkCollectionItem.deleteMany({ where: { bookmarkId: row.id } });
      } else {
        // Full replace: remove memberships not in the desired set, add any that are missing.
        // The bookmark cannot be in "unorganized" state once it has at least one folder.
        await tx.bookmarkCollectionItem.deleteMany({
          where: { bookmarkId: row.id, collectionId: { notIn: desired } },
        });
        await tx.bookmarkCollectionItem.createMany({
          data: desired.map((collectionId) => ({ bookmarkId: row.id, collectionId })),
          skipDuplicates: true,
        });
      }

      return row;
    });

    // Fetch updated bookmark count for realtime payload (keep REST response stable).
    try {
      const post = await this.prisma.post.findUnique({
        where: { id: postId },
        select: { bookmarkCount: true },
      });
      const recipients = new Set<string>([userId, postUserId].filter(Boolean));
      this.presenceRealtime.emitPostsInteraction(recipients, {
        postId,
        actorUserId: userId,
        kind: 'bookmark',
        active: true,
        bookmarkCount: post?.bookmarkCount ?? undefined,
      });
    } catch {
      // Best-effort
    }

    // Bookmarking implies the user saw the post.
    void this.postViews.markViewed(userId, postId);
    this.enqueueScoreRefresh(postId);
    this.invalidateCollectionsCache(userId);

    // When collectionIds was not provided (null), fetch the current folder state from the DB so
    // the response always reflects the true state of the bookmark.
    const finalCollectionIds: string[] =
      desired !== null
        ? desired
        : (
            await this.prisma.bookmarkCollectionItem.findMany({
              where: { bookmarkId: bookmark.id },
              select: { collectionId: true },
            })
          ).map((item) => item.collectionId);

    return { success: true, bookmarked: true, bookmarkId: bookmark.id, collectionIds: finalCollectionIds };
  }

  async removeBookmark(params: { userId: string; postId: string }) {
    const userId = (params.userId ?? '').trim();
    const postId = (params.postId ?? '').trim();
    if (!postId) throw new BadRequestException('Post id is required.');

    // Best-effort: removing a bookmark should not require the post to still be visible.
    const postUserId =
      (
        await this.prisma.post.findUnique({
          where: { id: postId },
          select: { userId: true },
        })
      )?.userId ?? null;

    await this.prisma.$transaction(async (tx) => {
      const deleted = await tx.bookmark.deleteMany({ where: { userId, postId } });
      if (deleted.count > 0) {
        await tx.post.update({
          where: { id: postId },
          data: { bookmarkCount: { decrement: deleted.count } },
        });
      }
    });

    // Fetch updated bookmark count for realtime payload (keep REST response stable).
    try {
      const post = await this.prisma.post.findUnique({
        where: { id: postId },
        select: { bookmarkCount: true },
      });
      const recipients = new Set<string>([userId, postUserId].filter(Boolean) as string[]);
      this.presenceRealtime.emitPostsInteraction(recipients, {
        postId,
        actorUserId: userId,
        kind: 'bookmark',
        active: false,
        bookmarkCount: post?.bookmarkCount ?? undefined,
      });
    } catch {
      // Best-effort
    }

    this.enqueueScoreRefresh(postId);
    this.invalidateCollectionsCache(userId);
    return { success: true, bookmarked: false };
  }
}

