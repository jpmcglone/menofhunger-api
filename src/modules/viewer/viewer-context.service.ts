import { Injectable, NotFoundException } from '@nestjs/common';
import type { PostVisibility, VerifiedStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RequestCacheService } from '../../common/cache/request-cache.service';

export type ViewerContext = {
  id: string;
  verifiedStatus: VerifiedStatus;
  premium: boolean;
  premiumPlus: boolean;
  siteAdmin: boolean;
};

@Injectable()
export class ViewerContextService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly requestCache: RequestCacheService,
  ) {}

  private cacheKey(viewerUserId: string): string {
    return `viewerContext:${viewerUserId}`;
  }

  async getViewer(viewerUserId: string | null): Promise<ViewerContext | null> {
    const uid = (viewerUserId ?? '').trim();
    if (!uid) return null;

    const key = this.cacheKey(uid);
    const cached = this.requestCache.get<ViewerContext | null>(key);
    if (cached !== undefined) return cached;

    const viewer = await this.prisma.user.findUnique({
      where: { id: uid },
      select: { id: true, verifiedStatus: true, premium: true, premiumPlus: true, siteAdmin: true },
    });
    this.requestCache.set(key, viewer);
    return viewer;
  }

  async getViewerOrThrow(userId: string): Promise<ViewerContext> {
    const uid = (userId ?? '').trim();
    if (!uid) throw new NotFoundException('User not found.');
    const viewer = await this.getViewer(uid);
    if (!viewer) throw new NotFoundException('User not found.');
    return viewer;
  }

  isVerified(viewer: Pick<ViewerContext, 'verifiedStatus'> | null): boolean {
    return Boolean(viewer?.verifiedStatus && viewer.verifiedStatus !== 'none');
  }

  isPremium(viewer: Pick<ViewerContext, 'premium' | 'premiumPlus'> | null): boolean {
    return Boolean(viewer && (viewer.premium || viewer.premiumPlus));
  }

  allowedPostVisibilities(viewer: Pick<ViewerContext, 'verifiedStatus' | 'premium' | 'premiumPlus'> | null): PostVisibility[] {
    const allowed: PostVisibility[] = ['public'];
    if (this.isVerified(viewer as any)) allowed.push('verifiedOnly');
    if (this.isPremium(viewer as any)) allowed.push('premiumOnly');
    return allowed;
  }
}

