import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { PostVisibility, VerifiedStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

type Viewer = { id: string; verifiedStatus: VerifiedStatus; premium: boolean };

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
          createdAt: true,
          updatedAt: true,
          _count: { select: { bookmarks: true } },
        },
      }),
      this.prisma.bookmark.count({ where: { userId } }),
      this.prisma.bookmark.count({ where: { userId, collectionId: null } }),
    ]);
    return {
      collections: collections.map((c) => ({
        id: c.id,
        name: c.name,
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

    const created = await this.prisma.bookmarkCollection.create({
      data: { userId, name },
      select: { id: true, name: true, createdAt: true, updatedAt: true },
    });
    return {
      collection: {
        id: created.id,
        name: created.name,
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

    const existing = await this.prisma.bookmarkCollection.findFirst({ where: { id, userId }, select: { id: true } });
    if (!existing) throw new NotFoundException('Collection not found.');

    const updated = await this.prisma.bookmarkCollection.update({
      where: { id },
      data: { name },
      select: { id: true, name: true, createdAt: true, updatedAt: true, _count: { select: { bookmarks: true } } },
    });
    return {
      collection: {
        id: updated.id,
        name: updated.name,
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

  async setBookmark(params: { userId: string; postId: string; collectionId?: string | null }) {
    const userId = (params.userId ?? '').trim();
    const postId = (params.postId ?? '').trim();
    if (!postId) throw new BadRequestException('Post id is required.');

    await this.assertViewerCanBookmarkPost({ viewerUserId: userId, postId });

    const collectionId = (params.collectionId ?? null) ? String(params.collectionId) : null;
    if (collectionId) {
      const ok = await this.prisma.bookmarkCollection.findFirst({ where: { id: collectionId, userId }, select: { id: true } });
      if (!ok) throw new NotFoundException('Collection not found.');
    }

    const bookmark = await this.prisma.$transaction(async (tx) => {
      const created = await tx.bookmark.createMany({
        data: [{ userId, postId, collectionId }],
        skipDuplicates: true,
      });

      // Keep a fast counter on Post for UI + scoring.
      if (created.count > 0) {
        await tx.post.update({
          where: { id: postId },
          data: { bookmarkCount: { increment: created.count } },
        });
      }

      // Always ensure the bookmark is in the requested collection (including null).
      await tx.bookmark.updateMany({
        where: { userId, postId },
        data: { collectionId },
      });

      const row = await tx.bookmark.findUnique({
        where: { userId_postId: { userId, postId } },
        select: { id: true, collectionId: true },
      });
      if (!row) throw new Error('Bookmark upsert failed.');
      return row;
    });

    return { success: true, bookmarked: true, bookmarkId: bookmark.id, collectionId: bookmark.collectionId ?? null };
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

