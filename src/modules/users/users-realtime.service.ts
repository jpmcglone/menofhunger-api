import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfigService } from '../app/app-config.service';
import { publicAssetUrl } from '../../common/assets/public-asset-url';
import type { PublicProfileDto } from '../../common/dto';
import { PublicProfileCacheService } from './public-profile-cache.service';

function formatBirthdayMonthDay(birthdate: Date): string {
  // Use UTC to avoid timezone surprises.
  const month = birthdate.getUTCMonth(); // 0-11
  const day = birthdate.getUTCDate(); // 1-31
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const mm = months[month] ?? 'Jan';
  return `${mm} ${day}`;
}

function formatBirthdayFull(birthdate: Date): string {
  const month = birthdate.getUTCMonth(); // 0-11
  const day = birthdate.getUTCDate(); // 1-31
  const year = birthdate.getUTCFullYear();
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const mm = months[month] ?? 'Jan';
  return `${mm} ${day}, ${year}`;
}

function formatBirthdayDisplay(
  birthdate: Date | null,
  visibility: 'none' | 'monthDay' | 'full' | null | undefined,
): string | null {
  if (!birthdate) return null;
  if (visibility === 'none') return null;
  if (visibility === 'full') return formatBirthdayFull(birthdate);
  return formatBirthdayMonthDay(birthdate);
}

@Injectable()
export class UsersRealtimeService {
  private readonly logger = new Logger(UsersRealtimeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly appConfig: AppConfigService,
    private readonly publicProfileCache: PublicProfileCacheService<{ id: string; username: string | null }>,
  ) {}

  async getPublicProfileDtoByUserId(userId: string): Promise<PublicProfileDto | null> {
    const id = (userId ?? '').trim();
    if (!id) return null;

    const user = await this.prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        createdAt: true,
        username: true,
        usernameIsSet: true,
        name: true,
        bio: true,
        website: true,
        locationDisplay: true,
        locationCity: true,
        locationCounty: true,
        locationState: true,
        locationCountry: true,
        birthdate: true,
        birthdayVisibility: true,
        premium: true,
        premiumPlus: true,
        isOrganization: true,
        stewardBadgeEnabled: true,
        verifiedStatus: true,
        avatarKey: true,
        avatarUpdatedAt: true,
        bannerKey: true,
        bannerUpdatedAt: true,
        pinnedPostId: true,
        lastOnlineAt: true,
      },
    });
    if (!user) return null;

    // Safety: only-me posts should never be pinnable/show on profiles.
    let pinnedPostId: string | null = user.pinnedPostId ?? null;
    if (pinnedPostId) {
      const pinned = await this.prisma.post.findFirst({
        where: { id: pinnedPostId, userId: user.id, deletedAt: null },
        select: { visibility: true },
      });
      if (!pinned || pinned.visibility === 'onlyMe') {
        try {
          await this.prisma.user.update({ where: { id: user.id }, data: { pinnedPostId: null } });
          await this.publicProfileCache.invalidateForUser({ id: user.id, username: user.username ?? null });
        } catch {
          // Best-effort
        }
        pinnedPostId = null;
      }
    }

    const publicBaseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;

    return {
      id: user.id,
      createdAt: user.createdAt.toISOString(),
      username: user.usernameIsSet ? user.username : null,
      name: user.name,
      bio: user.bio,
      website: user.website ?? null,
      locationDisplay: user.locationDisplay ?? null,
      locationCity: user.locationCity ?? null,
      locationCounty: user.locationCounty ?? null,
      locationState: user.locationState ?? null,
      locationCountry: user.locationCountry ?? null,
      birthdayDisplay: formatBirthdayDisplay(user.birthdate, (user as any).birthdayVisibility ?? 'monthDay'),
      birthdayMonthDay: user.birthdate ? formatBirthdayMonthDay(user.birthdate) : null,
      premium: user.premium,
      premiumPlus: user.premiumPlus,
      isOrganization: Boolean(user.isOrganization),
      stewardBadgeEnabled: Boolean(user.stewardBadgeEnabled),
      verifiedStatus: user.verifiedStatus,
      avatarUrl: publicAssetUrl({ publicBaseUrl, key: user.avatarKey ?? null, updatedAt: user.avatarUpdatedAt ?? null }),
      bannerUrl: publicAssetUrl({ publicBaseUrl, key: user.bannerKey ?? null, updatedAt: user.bannerUpdatedAt ?? null }),
      pinnedPostId,
      // Privacy: last-online timestamps are only for verified viewers via HTTP endpoints.
      // Realtime fanout targets can include unverified users, so we redact here.
      lastOnlineAt: null,
    };
  }

  /**
   * Related users for realtime public-profile fanout.
   * Current definition: followers + following (two-way graph neighborhood).
   */
  async listRelatedUserIds(userId: string, opts?: { max?: number }): Promise<string[]> {
    const id = (userId ?? '').trim();
    if (!id) return [];
    const max = Math.max(1, Math.min(10_000, Math.floor(opts?.max ?? 2000)));

    const [followers, following] = await Promise.all([
      this.prisma.follow.findMany({
        where: { followingId: id },
        select: { followerId: true },
        take: max + 1,
      }),
      this.prisma.follow.findMany({
        where: { followerId: id },
        select: { followingId: true },
        take: max + 1,
      }),
    ]);

    const ids = new Set<string>();
    for (const r of followers) ids.add(r.followerId);
    for (const r of following) ids.add(r.followingId);
    ids.delete(id);

    const out = [...ids];
    if (out.length > max) {
      this.logger.warn(`[users:selfUpdated] related fanout capped userId=${id} related=${out.length} max=${max}`);
      return out.slice(0, max);
    }
    return out;
  }
}

