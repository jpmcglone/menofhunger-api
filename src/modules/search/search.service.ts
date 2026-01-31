import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import type { PostVisibility, VerifiedStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { createdAtIdCursorWhere } from '../../common/pagination/created-at-id-cursor';

type Viewer = { id: string; verifiedStatus: VerifiedStatus; premium: boolean } | null;

@Injectable()
export class SearchService {
  constructor(private readonly prisma: PrismaService) {}

  private async viewerById(viewerUserId: string | null): Promise<Viewer> {
    if (!viewerUserId) return null;
    return await this.prisma.user.findUnique({
      where: { id: viewerUserId },
      select: { id: true, verifiedStatus: true, premium: true },
    });
  }

  private allowedVisibilitiesForViewer(viewer: Viewer): PostVisibility[] {
    const allowed: PostVisibility[] = ['public'];
    if (viewer?.verifiedStatus && viewer.verifiedStatus !== 'none') allowed.push('verifiedOnly');
    if (viewer?.premium) allowed.push('premiumOnly');
    return allowed;
  }

  async searchUsers(params: { q: string; limit: number; cursor: string | null }) {
    const q = (params.q ?? '').trim();
    if (!q) return { users: [], nextCursor: null };
    const limit = Math.max(1, Math.min(50, params.limit || 30));
    const cursor = params.cursor ?? null;

    const cursorWhere = await createdAtIdCursorWhere({
      cursor,
      lookup: async (id) => await this.prisma.user.findUnique({ where: { id }, select: { id: true, createdAt: true } }),
    });

    const whereWithCursor = cursorWhere
      ? ({
          AND: [
            cursorWhere,
            {
              OR: [
                { username: { contains: q, mode: 'insensitive' } },
                { name: { contains: q, mode: 'insensitive' } },
              ],
            },
          ],
        } as any)
      : ({
          OR: [{ username: { contains: q, mode: 'insensitive' } }, { name: { contains: q, mode: 'insensitive' } }],
        } as any);

    const users = await this.prisma.user.findMany({
      where: whereWithCursor,
      select: { id: true, createdAt: true, username: true, name: true, premium: true, verifiedStatus: true, avatarKey: true, avatarUpdatedAt: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });

    const slice = users.slice(0, limit);
    const nextCursor = users.length > limit ? slice[slice.length - 1]?.id ?? null : null;

    return {
      users: slice.map((u) => ({
        id: u.id,
        username: u.username,
        name: u.name,
        premium: u.premium,
        verifiedStatus: u.verifiedStatus,
        // avatarUrl is computed client-side in existing flows; keep it null here for now (fast MVP).
        avatarUrl: null,
      })),
      nextCursor,
    };
  }

  async searchPosts(params: { viewerUserId: string | null; q: string; limit: number; cursor: string | null }) {
    const q = (params.q ?? '').trim();
    if (!q) return { posts: [], nextCursor: null };
    const limit = Math.max(1, Math.min(50, params.limit || 30));
    const cursor = params.cursor ?? null;

    const viewer = await this.viewerById(params.viewerUserId ?? null);
    const allowed = this.allowedVisibilitiesForViewer(viewer);

    const visibilityWhere = viewer?.id
      ? ({
          OR: [{ visibility: { in: allowed } }, { userId: viewer.id, visibility: 'onlyMe' }],
        } as any)
      : ({ visibility: 'public' } as any);

    const cursorWhere = await createdAtIdCursorWhere({
      cursor,
      lookup: async (id) => await this.prisma.post.findUnique({ where: { id }, select: { id: true, createdAt: true } }),
    });

    const where = cursorWhere
      ? ({
          AND: [
            { deletedAt: null },
            visibilityWhere,
            cursorWhere,
            {
              body: { contains: q, mode: 'insensitive' },
            },
          ],
        } as any)
      : ({
          AND: [{ deletedAt: null }, visibilityWhere, { body: { contains: q, mode: 'insensitive' } }],
        } as any);

    const posts = await this.prisma.post.findMany({
      where,
      include: { user: true, media: { orderBy: { position: 'asc' } } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });

    const slice = posts.slice(0, limit);
    const nextCursor = posts.length > limit ? slice[slice.length - 1]?.id ?? null : null;
    return { posts: slice, nextCursor };
  }

  private async bookmarkCursorWhere(params: { userId: string; cursor: string | null }) {
    const cursor = (params.cursor ?? '').trim();
    if (!cursor) return null;
    const row = await this.prisma.bookmark.findUnique({ where: { id: cursor }, select: { id: true, createdAt: true, userId: true } });
    if (!row || row.userId !== params.userId) return null;
    return {
      OR: [
        { createdAt: { lt: row.createdAt } },
        { AND: [{ createdAt: row.createdAt }, { id: { lt: row.id } }] },
      ],
    } as const;
  }

  async searchBookmarks(params: {
    viewerUserId: string | null;
    q: string;
    limit: number;
    cursor: string | null;
    collectionId: string | null;
    unorganized: boolean;
  }) {
    if (!params.viewerUserId) throw new ForbiddenException('Log in to view bookmarks.');
    const userId = params.viewerUserId;
    const q = (params.q ?? '').trim();
    const limit = Math.max(1, Math.min(50, params.limit || 30));
    const cursor = params.cursor ?? null;
    const collectionId = (params.collectionId ?? null) ? String(params.collectionId) : null;
    const unorganized = Boolean(params.unorganized);

    if (collectionId && unorganized) throw new BadRequestException('Invalid filter combination.');

    const cursorWhere = await this.bookmarkCursorWhere({ userId, cursor });

    const folderWhere = unorganized
      ? ({ collections: { none: {} } } as any)
      : collectionId
        ? ({ collections: { some: { collectionId } } } as any)
        : {};

    const where: any = {
      AND: [
        { userId },
        folderWhere,
        cursorWhere ? cursorWhere : {},
        q
          ? {
              OR: [
                { post: { body: { contains: q, mode: 'insensitive' } } },
                { post: { user: { username: { contains: q, mode: 'insensitive' } } } },
                { post: { user: { name: { contains: q, mode: 'insensitive' } } } },
              ],
            }
          : {},
      ],
    };

    const rows = await this.prisma.bookmark.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      select: {
        id: true,
        createdAt: true,
        postId: true,
        collections: { select: { collectionId: true } },
        post: { include: { user: true, media: { orderBy: { position: 'asc' } } } },
      },
    });

    const slice = rows.slice(0, limit);
    const nextCursor = rows.length > limit ? slice[slice.length - 1]?.id ?? null : null;

    return {
      bookmarks: slice.map((b) => ({
        bookmarkId: b.id,
        createdAt: b.createdAt.toISOString(),
        collectionIds: (b.collections ?? []).map((c) => c.collectionId),
        post: b.post,
      })),
      nextCursor,
    };
  }
}

