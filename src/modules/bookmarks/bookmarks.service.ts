import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { PostVisibility, VerifiedStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

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
  constructor(private readonly prisma: PrismaService) {}

  private async viewer(userId: string): Promise<Viewer> {
    const u = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, verifiedStatus: true, premium: true },
    });
    if (!u) throw new NotFoundException('User not found.');
    return u;
  }

  private allowedVisibilitiesForViewer(viewer: Viewer): PostVisibility[] {
    const allowed: PostVisibility[] = ['public'];
    if (viewer.verifiedStatus !== 'none') allowed.push('verifiedOnly');
    if (viewer.premium) allowed.push('premiumOnly');
    return allowed;
  }

  private async assertViewerCanBookmarkPost(params: { viewerUserId: string; postId: string }) {
    const { viewerUserId, postId } = params;
    const viewer = await this.viewer(viewerUserId);
    const allowed = this.allowedVisibilitiesForViewer(viewer);

    const post = await this.prisma.post.findFirst({
      where: { id: postId, deletedAt: null },
      select: { id: true, userId: true, visibility: true },
    });
    if (!post) throw new NotFoundException('Post not found.');

    if (post.visibility === 'onlyMe') {
      if (post.userId !== viewerUserId) throw new ForbiddenException('Post not found.');
      return;
    }
    if (!allowed.includes(post.visibility)) throw new ForbiddenException('Post not found.');
  }

  async listCollections(params: { userId: string }) {
    const { userId } = params;
    const [collections, totalCount, unorganizedCount] = await Promise.all([
      this.prisma.bookmarkCollection.findMany({
        where: { userId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: {
          id: true,
          name: true,
          slug: true,
          createdAt: true,
          updatedAt: true,
          _count: { select: { bookmarks: true } },
        },
      }),
      this.prisma.bookmark.count({ where: { userId } }),
      this.prisma.bookmark.count({ where: { userId, collections: { none: {} } } }),
    ]);
    return {
      collections: collections.map((c) => ({
        id: c.id,
        name: c.name,
        slug: c.slug,
        bookmarkCount: c._count.bookmarks,
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
      select: { id: true, name: true, slug: true, createdAt: true, updatedAt: true, _count: { select: { bookmarks: true } } },
    });
    return {
      collection: {
        id: updated.id,
        name: updated.name,
        slug: updated.slug,
        bookmarkCount: updated._count.bookmarks,
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
    return { success: true };
  }

  async setBookmark(params: { userId: string; postId: string; collectionIds?: string[] | null }) {
    const userId = (params.userId ?? '').trim();
    const postId = (params.postId ?? '').trim();
    if (!postId) throw new BadRequestException('Post id is required.');

    await this.assertViewerCanBookmarkPost({ viewerUserId: userId, postId });

    const desired = Array.isArray(params.collectionIds)
      ? Array.from(
          new Set(
            params.collectionIds
              .map((v) => (v ?? '').toString().trim())
              .filter(Boolean),
          ),
        )
      : [];

    if (desired.length > 0) {
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

      // Replace folder membership.
      if (desired.length === 0) {
        await tx.bookmarkCollectionItem.deleteMany({ where: { bookmarkId: row.id } });
      } else {
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

    return { success: true, bookmarked: true, bookmarkId: bookmark.id, collectionIds: desired };
  }

  async removeBookmark(params: { userId: string; postId: string }) {
    const userId = (params.userId ?? '').trim();
    const postId = (params.postId ?? '').trim();
    if (!postId) throw new BadRequestException('Post id is required.');

    await this.prisma.$transaction(async (tx) => {
      const deleted = await tx.bookmark.deleteMany({ where: { userId, postId } });
      if (deleted.count > 0) {
        await tx.post.update({
          where: { id: postId },
          data: { bookmarkCount: { decrement: deleted.count } },
        });
      }
    });
    return { success: true, bookmarked: false };
  }
}

