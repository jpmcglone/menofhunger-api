import { Injectable, NotFoundException } from '@nestjs/common';
import type { OrgAffiliationDto } from '../../common/dto';
import { publicAssetUrl } from '../../common/assets/public-asset-url';
import { totalUserArticlesWhere, totalUserPostsWhere } from '../../common/content-counts';
import { AppConfigService } from '../app/app-config.service';
import { PrismaService } from '../prisma/prisma.service';
import { PublicProfileCacheService } from './public-profile-cache.service';

export type PublicProfilePayload = {
  id: string;
  createdAt: string;
  username: string | null;
  name: string | null;
  bio: string | null;
  website: string | null;
  locationDisplay: string | null;
  locationZip: string | null;
  locationCity: string | null;
  locationCounty: string | null;
  locationState: string | null;
  locationCountry: string | null;
  birthdayDisplay: string | null;
  birthdayMonthDay: string | null;
  premium: boolean;
  premiumPlus: boolean;
  isOrganization: boolean;
  stewardBadgeEnabled: boolean;
  verifiedStatus: string;
  avatarUrl: string | null;
  bannerUrl: string | null;
  pinnedPostId: string | null;
  lastOnlineAt: string | null;
  checkinStreakDays: number;
  longestStreakDays: number;
  inCrew?: boolean;
  isBot?: boolean;
};

type PublicProfileResult = {
  payload: PublicProfilePayload;
  cache: 'hit' | 'miss';
};

function formatBirthdayMonthDay(birthdate: Date): string {
  const month = birthdate.getUTCMonth();
  const day = birthdate.getUTCDate();
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[month] ?? 'Jan'} ${day}`;
}

function formatBirthdayFull(birthdate: Date): string {
  const month = birthdate.getUTCMonth();
  const day = birthdate.getUTCDate();
  const year = birthdate.getUTCFullYear();
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[month] ?? 'Jan'} ${day}, ${year}`;
}

function formatBirthdayDisplay(
  birthdate: Date | null,
  visibility: 'none' | 'monthDay' | 'full' | null | undefined,
): string | null {
  if (!birthdate || visibility === 'none') return null;
  return visibility === 'full' ? formatBirthdayFull(birthdate) : formatBirthdayMonthDay(birthdate);
}

@Injectable()
export class PublicProfilesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly appConfig: AppConfigService,
    private readonly cache: PublicProfileCacheService<PublicProfilePayload>,
  ) {}

  async batchOrgAffiliations(userIds: string[]): Promise<Map<string, OrgAffiliationDto[]>> {
    if (userIds.length === 0) return new Map();
    const publicBaseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;
    const memberships = await this.prisma.userOrgMembership.findMany({
      where: { userId: { in: userIds } },
      select: {
        userId: true,
        org: { select: { id: true, username: true, name: true, avatarKey: true, avatarUpdatedAt: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
    const map = new Map<string, OrgAffiliationDto[]>();
    for (const membership of memberships) {
      const list = map.get(membership.userId) ?? [];
      list.push({
        id: membership.org.id,
        username: membership.org.username,
        name: membership.org.name,
        avatarUrl: publicAssetUrl({
          publicBaseUrl,
          key: membership.org.avatarKey ?? null,
          updatedAt: membership.org.avatarUpdatedAt ?? null,
        }),
      });
      map.set(membership.userId, list);
    }
    return map;
  }

  async getByUsernameOrId(rawUsernameOrId: string): Promise<PublicProfileResult> {
    const raw = (rawUsernameOrId ?? '').trim();
    if (!raw) throw new NotFoundException('User not found');

    const normalized = raw.toLowerCase();
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(raw);
    const isCuid = /^c[a-z0-9]{24}$/i.test(raw);
    const isUuidOrCuid = isUuid || isCuid;
    const cacheKey = isUuidOrCuid ? `id:${raw}` : `username:${normalized}`;
    const cached = await this.cache.read(cacheKey);

    if (cached) {
      try {
        const fresh = await this.prisma.user.findUnique({
          where: { id: cached.id },
          select: {
            lastOnlineAt: true,
            premium: true,
            premiumPlus: true,
            isOrganization: true,
            verifiedStatus: true,
            pinnedPostId: true,
          },
        });
        const lastOnlineAt = fresh?.lastOnlineAt ? fresh.lastOnlineAt.toISOString() : null;
        const premium = fresh?.premium ?? cached.premium;
        const premiumPlus = fresh?.premiumPlus ?? cached.premiumPlus;
        const isOrganization = fresh?.isOrganization ?? cached.isOrganization;
        const verifiedStatus = fresh?.verifiedStatus ?? cached.verifiedStatus;
        let pinnedPostId = fresh?.pinnedPostId ?? cached.pinnedPostId;
        if (pinnedPostId) {
          const pinned = await this.prisma.post.findFirst({
            where: { id: pinnedPostId, userId: cached.id, deletedAt: null },
            select: { visibility: true },
          });
          if (!pinned || pinned.visibility === 'onlyMe') {
            try {
              await this.prisma.user.update({ where: { id: cached.id }, data: { pinnedPostId: null } });
              await this.cache.invalidateForUser({ id: cached.id, username: cached.username });
            } catch {
              // Best-effort cleanup of a legacy private pin.
            }
            pinnedPostId = null;
          }
        }

        if (
          lastOnlineAt !== cached.lastOnlineAt ||
          premium !== cached.premium ||
          premiumPlus !== cached.premiumPlus ||
          isOrganization !== cached.isOrganization ||
          verifiedStatus !== cached.verifiedStatus ||
          pinnedPostId !== cached.pinnedPostId
        ) {
          const next: PublicProfilePayload = {
            ...cached,
            lastOnlineAt,
            premium,
            premiumPlus,
            isOrganization,
            verifiedStatus,
            pinnedPostId,
          };
          this.writeCache(cacheKey, next);
          return { payload: next, cache: 'hit' };
        }
      } catch {
        // Fall back to the cached public payload if the volatile refresh fails.
      }
      return { payload: cached, cache: 'hit' };
    }

    const user =
      (
        await this.prisma.$queryRaw<
          Array<{
            id: string;
            createdAt: Date;
            username: string | null;
            name: string | null;
            bio: string | null;
            website: string | null;
            locationDisplay: string | null;
            locationZip: string | null;
            locationCity: string | null;
            locationCounty: string | null;
            locationState: string | null;
            locationCountry: string | null;
            birthdate: Date | null;
            birthdayVisibility: 'none' | 'monthDay' | 'full';
            premium: boolean;
            premiumPlus: boolean;
            isOrganization: boolean;
            stewardBadgeEnabled: boolean;
            verifiedStatus: string;
            avatarKey: string | null;
            avatarUpdatedAt: Date | null;
            bannerKey: string | null;
            bannerUpdatedAt: Date | null;
            pinnedPostId: string | null;
            lastOnlineAt: Date | null;
            bannedAt: Date | null;
            checkinStreakDays: number;
            longestStreakDays: number;
            isBot: boolean;
          }>
        >`
          SELECT "id", "createdAt", "username", "name", "bio", "website", "locationDisplay", "locationZip", "locationCity", "locationCounty", "locationState", "locationCountry", "birthdate", "birthdayVisibility", "premium", "premiumPlus", "isOrganization", "stewardBadgeEnabled", "verifiedStatus", "avatarKey", "avatarUpdatedAt", "bannerKey", "bannerUpdatedAt", "pinnedPostId", "lastOnlineAt", "bannedAt", "checkinStreakDays", "longestStreakDays", "isBot"
          FROM "User"
          WHERE (
            (${isUuidOrCuid} = true AND "id" = ${raw})
            OR
            (${isUuidOrCuid} = false AND LOWER("username") = ${normalized})
          )
          AND "usernameIsSet" = true
          LIMIT 1
        `
      )[0] ?? null;

    if (!user) throw new NotFoundException('User not found');
    if (user.bannedAt) return { payload: { banned: true } as unknown as PublicProfilePayload, cache: 'miss' };

    let pinnedPostId = user.pinnedPostId ?? null;
    if (pinnedPostId) {
      const pinned = await this.prisma.post.findFirst({
        where: { id: pinnedPostId, userId: user.id, deletedAt: null },
        select: { visibility: true },
      });
      if (!pinned || pinned.visibility === 'onlyMe') {
        await this.prisma.user.update({ where: { id: user.id }, data: { pinnedPostId: null } });
        pinnedPostId = null;
      }
    }

    const publicBaseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;
    const payload: PublicProfilePayload = {
      id: user.id,
      createdAt: user.createdAt.toISOString(),
      username: user.username,
      name: user.name,
      bio: user.bio,
      website: user.website ?? null,
      locationDisplay: user.locationDisplay ?? null,
      locationZip: user.locationZip ?? null,
      locationCity: user.locationCity ?? null,
      locationCounty: user.locationCounty ?? null,
      locationState: user.locationState ?? null,
      locationCountry: user.locationCountry ?? null,
      birthdayDisplay: formatBirthdayDisplay(user.birthdate, user.birthdayVisibility ?? 'monthDay'),
      // Respect the user's birthday privacy setting: if they chose 'none', suppress both fields.
      birthdayMonthDay: user.birthdate && (user.birthdayVisibility ?? 'monthDay') !== 'none' ? formatBirthdayMonthDay(user.birthdate) : null,
      premium: user.premium,
      premiumPlus: user.premiumPlus,
      isOrganization: user.isOrganization,
      stewardBadgeEnabled: user.stewardBadgeEnabled,
      verifiedStatus: user.verifiedStatus,
      avatarUrl: publicAssetUrl({ publicBaseUrl, key: user.avatarKey, updatedAt: user.avatarUpdatedAt }),
      bannerUrl: publicAssetUrl({ publicBaseUrl, key: user.bannerKey, updatedAt: user.bannerUpdatedAt }),
      pinnedPostId,
      lastOnlineAt: user.lastOnlineAt ? user.lastOnlineAt.toISOString() : null,
      checkinStreakDays: Math.max(0, Math.floor(Number(user.checkinStreakDays) || 0)),
      longestStreakDays: Math.max(0, Math.floor(Number(user.longestStreakDays) || 0)),
      isBot: user.isBot,
    };

    this.writeCache(cacheKey, payload);
    return { payload, cache: 'miss' };
  }

  async getAnonymousProfile(usernameOrId: string) {
    const result = await this.getByUsernameOrId(usernameOrId);
    const payload = result.payload;
    if ((payload as unknown as { banned?: boolean }).banned === true) {
      return { payload: { banned: true }, cache: result.cache };
    }

    const [orgMap, crewMember, postCount, articleCount] = await Promise.all([
      this.batchOrgAffiliations([payload.id]),
      this.prisma.crewMember.findFirst({
        where: { userId: payload.id, crew: { deletedAt: null } },
        select: { crewId: true },
      }),
      this.prisma.post.count({ where: totalUserPostsWhere(payload.id) }),
      this.prisma.article.count({ where: totalUserArticlesWhere(payload.id) }),
    ]);

    return {
      cache: result.cache,
      payload: {
        ...payload,
        lastOnlineAt: null,
        orgAffiliations: orgMap.get(payload.id) ?? [],
        postCount,
        articleCount,
        inCrew: Boolean(crewMember),
      },
    };
  }

  private writeCache(cacheKey: string, payload: PublicProfilePayload): void {
    void this.cache.write(cacheKey, payload, 5 * 60 * 1000);
    void this.cache.write(`id:${payload.id}`, payload, 5 * 60 * 1000);
    if (payload.username) {
      void this.cache.write(`username:${payload.username.toLowerCase()}`, payload, 5 * 60 * 1000);
    }
  }
}
