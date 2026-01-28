import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { PostVisibility, VerifiedStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export type PostCounts = {
  all: number;
  public: number;
  verifiedOnly: number;
  premiumOnly: number;
};

@Injectable()
export class PostsService {
  constructor(private readonly prisma: PrismaService) {}

  private allowedVisibilitiesForViewer(viewer: { verifiedStatus: VerifiedStatus; premium: boolean } | null) {
    const allowed: PostVisibility[] = ['public'];
    if (viewer?.verifiedStatus && viewer.verifiedStatus !== 'none') allowed.push('verifiedOnly');
    if (viewer?.premium) allowed.push('premiumOnly');
    return allowed;
  }

  async listFeed(params: { viewerUserId: string | null; limit: number; cursor: string | null }) {
    const { viewerUserId, limit, cursor } = params;

    const viewer = viewerUserId
      ? await this.prisma.user.findUnique({
          where: { id: viewerUserId },
          select: { verifiedStatus: true, premium: true },
        })
      : null;

    const allowed = this.allowedVisibilitiesForViewer(viewer);

    const posts = await this.prisma.post.findMany({
      where: { visibility: { in: allowed } },
      include: { user: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });

    const slice = posts.slice(0, limit);
    const nextCursor = posts.length > limit ? slice[slice.length - 1]?.id ?? null : null;

    return { posts: slice, nextCursor };
  }

  async listForUsername(params: {
    viewerUserId: string | null;
    username: string;
    limit: number;
    cursor: string | null;
    visibility: 'all' | PostVisibility;
  }) {
    const { viewerUserId, username, limit, cursor, visibility } = params;
    const normalized = (username ?? '').trim();
    if (!normalized) throw new NotFoundException('User not found.');

    const user = await this.prisma.user.findFirst({
      where: { username: { equals: normalized, mode: 'insensitive' } },
      select: { id: true },
    });
    if (!user) throw new NotFoundException('User not found.');

    const viewer = viewerUserId
      ? await this.prisma.user.findUnique({
          where: { id: viewerUserId },
          select: { id: true, verifiedStatus: true, premium: true },
        })
      : null;

    const isSelf = Boolean(viewer && viewer.id === user.id);

    // Counts (for tabs).
    const grouped = await this.prisma.post.groupBy({
      by: ['visibility'],
      where: { userId: user.id },
      _count: { _all: true },
    });

    const counts: PostCounts = {
      all: 0,
      public: 0,
      verifiedOnly: 0,
      premiumOnly: 0,
    };
    for (const g of grouped) {
      const n = g._count._all;
      counts.all += n;
      if (g.visibility === 'public') counts.public = n;
      if (g.visibility === 'verifiedOnly') counts.verifiedOnly = n;
      if (g.visibility === 'premiumOnly') counts.premiumOnly = n;
    }

    const allowed =
      isSelf ? (['public', 'verifiedOnly', 'premiumOnly'] as PostVisibility[]) : this.allowedVisibilitiesForViewer(viewer);

    if (visibility === 'verifiedOnly' && !isSelf) {
      if (!viewer || viewer.verifiedStatus === 'none') throw new ForbiddenException('Verify to view verified-only posts.');
    }
    if (visibility === 'premiumOnly' && !isSelf) {
      if (!viewer || !viewer.premium) throw new ForbiddenException('Upgrade to premium to view premium-only posts.');
    }

    const posts = await this.prisma.post.findMany({
      where:
        visibility === 'all'
          ? { userId: user.id, visibility: { in: allowed } }
          : { userId: user.id, visibility },
      include: { user: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });

    const slice = posts.slice(0, limit);
    const nextCursor = posts.length > limit ? slice[slice.length - 1]?.id ?? null : null;

    return { posts: slice, nextCursor, counts };
  }

  async createPost(params: { userId: string; body: string; visibility: PostVisibility }) {
    const { userId, body, visibility } = params;
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { verifiedStatus: true, premium: true },
    });
    if (!user) throw new NotFoundException('User not found.');
    if (user.verifiedStatus === 'none') throw new ForbiddenException('You must be verified to post.');

    const maxLen = user.premium ? 500 : 200;
    if (body.length > maxLen) {
      throw new BadRequestException(
        user.premium
          ? 'Posts are limited to 500 characters.'
          : 'Posts are limited to 200 characters for non-premium members.',
      );
    }

    return await this.prisma.post.create({
      data: {
        body,
        visibility,
        userId,
      },
      include: { user: true },
    });
  }
}

