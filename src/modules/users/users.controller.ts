import { BadRequestException, Body, ConflictException, Controller, Delete, Get, NotFoundException, Param, Patch, Put, Query, Res, UseGuards } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import type { Response } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { AuthGuard } from '../auth/auth.guard';
import { OptionalAuthGuard } from '../auth/optional-auth.guard';
import { AppConfigService } from '../app/app-config.service';
import { FollowsService } from '../follows/follows.service';
import { CurrentUserId, OptionalCurrentUserId } from './users.decorator';
import { validateUsername } from './users.utils';
import { toUserDto } from './user.dto';
import { toUserListDto, type NudgeStateDto } from '../../common/dto';
import { publicAssetUrl } from '../../common/assets/public-asset-url';
import { Throttle } from '@nestjs/throttler';
import { rateLimitLimit, rateLimitTtl } from '../../common/throttling/rate-limit.resolver';
import { PublicProfileCacheService } from './public-profile-cache.service';
import { UsersMeRealtimeService } from './users-me-realtime.service';
import { UsersPublicRealtimeService } from './users-public-realtime.service';
import { canonicalizeTopicValue } from '../../common/topics/topic-utils';
import { UsersLocationService } from './users-location.service';
import { EmailVerificationService } from '../email/email-verification.service';

const setUsernameSchema = z.object({
  username: z.string().min(1),
});

function formatBirthdayMonthDay(birthdate: Date): string {
  // Use UTC to avoid timezone surprises.
  const month = birthdate.getUTCMonth(); // 0-11
  const day = birthdate.getUTCDate(); // 1-31
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const mm = months[month] ?? 'Jan';
  return `${mm} ${day}`;
}

function formatBirthdayFull(birthdate: Date): string {
  // Use UTC to avoid timezone surprises.
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

function normalizeWebsite(raw: string): string {
  const s = (raw ?? '').trim();
  if (!s) throw new BadRequestException('Website is required.');
  const withScheme = /^https?:\/\//i.test(s) ? s : `https://${s}`;
  let u: URL;
  try {
    u = new URL(withScheme);
  } catch {
    throw new BadRequestException('Website must be a valid URL.');
  }
  if (!/^https?:$/.test(u.protocol)) throw new BadRequestException('Website must be a valid URL.');
  // Remove default ports and normalize.
  u.hash = '';
  return u.toString();
}

const profileSchema = z.object({
  name: z.string().trim().max(50).optional(),
  bio: z.string().trim().max(160).optional(),
  email: z.union([z.string().trim().email(), z.literal('')]).optional(),
  interests: z.array(z.string().trim().min(1).max(40)).max(30).optional(),
  website: z.union([z.string().trim().max(200), z.literal('')]).optional(),
  locationQuery: z.union([z.string().trim().max(120), z.literal('')]).optional(),
});

const settingsSchema = z.object({
  followVisibility: z.enum(['all', 'verified', 'premium', 'none']).optional(),
  birthdayVisibility: z.enum(['none', 'monthDay', 'full']).optional(),
  stewardBadgeEnabled: z.boolean().optional(),
});

const onboardingSchema = z.object({
  username: z.string().min(1).optional(),
  name: z.string().trim().max(50).optional(),
  email: z.union([z.string().trim().email(), z.literal('')]).optional(),
  // Expect YYYY-MM-DD from client.
  birthdate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Birthdate must be a date (YYYY-MM-DD).').optional(),
  interests: z.array(z.string().trim().min(1).max(40)).min(1).max(30).optional(),
  menOnlyConfirmed: z.boolean().optional(),
});

const newestUsersSchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).optional(),
});

function isAtLeast18(birthdateUtcMidnight: Date): boolean {
  // Compare by YYYY-MM-DD using UTC to avoid timezone edge cases.
  const yyyy = birthdateUtcMidnight.getUTCFullYear();
  const mm = birthdateUtcMidnight.getUTCMonth();
  const dd = birthdateUtcMidnight.getUTCDate();

  const now = new Date();
  const todayUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const cutoff = new Date(Date.UTC(todayUtc.getUTCFullYear() - 18, todayUtc.getUTCMonth(), todayUtc.getUTCDate()));

  const d = new Date(Date.UTC(yyyy, mm, dd));
  return d.getTime() <= cutoff.getTime();
}

const JOHN_USERNAME = 'john';
const MENOFHUNGER_USERNAME = 'menofhunger';

type PublicProfilePayload = {
  id: string;
  createdAt: string;
  username: string | null;
  name: string | null;
  bio: string | null;
  website: string | null;
  locationDisplay: string | null;
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
};

type UserPreviewPayload = {
  id: string;
  username: string | null;
  name: string | null;
  bio: string | null;
  premium: boolean;
  premiumPlus: boolean;
  isOrganization: boolean;
  stewardBadgeEnabled: boolean;
  verifiedStatus: string;
  avatarUrl: string | null;
  bannerUrl: string | null;
  lastOnlineAt: string | null;
  checkinStreakDays: number;
  longestStreakDays: number;
  relationship: { viewerFollowsUser: boolean; userFollowsViewer: boolean };
  nudge: NudgeStateDto | null;
  followerCount: number | null;
  followingCount: number | null;
};

@Controller('users')
export class UsersController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly appConfig: AppConfigService,
    private readonly followsService: FollowsService,
    private readonly publicProfileCache: PublicProfileCacheService<PublicProfilePayload>,
    private readonly usersMeRealtime: UsersMeRealtimeService,
    private readonly usersPublicRealtime: UsersPublicRealtimeService,
    private readonly usersLocation: UsersLocationService,
    private readonly emailVerification: EmailVerificationService,
  ) {}

  private async viewerCanSeeLastOnline(viewerUserId: string | null): Promise<boolean> {
    if (!viewerUserId) return false;
    try {
      const viewer = await this.prisma.user.findUnique({
        where: { id: viewerUserId },
        select: { verifiedStatus: true, siteAdmin: true },
      });
      const verifiedStatus = (viewer as any)?.verifiedStatus ?? 'none';
      return Boolean((viewer as any)?.siteAdmin) || (typeof verifiedStatus === 'string' && verifiedStatus !== 'none');
    } catch {
      return false;
    }
  }

  private async emitUserSelfUpdated(userId: string): Promise<void> {
    await this.usersPublicRealtime.emitPublicProfileUpdated(userId);
  }

  private async getPublicProfilePayloadByUsernameOrId(
    rawUsernameOrId: string,
  ): Promise<{ payload: PublicProfilePayload; cache: 'hit' | 'miss' }> {
    const raw = (rawUsernameOrId ?? '').trim();
    if (!raw) throw new NotFoundException('User not found');

    const normalized = raw.toLowerCase();
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(raw);
    const isCuid = /^c[a-z0-9]{24}$/i.test(raw);
    const isUuidOrCuid = isUuid || isCuid;

    const cacheKey = isUuidOrCuid ? `id:${raw}` : `username:${normalized}`;
    const cached = await this.publicProfileCache.read(cacheKey);
    if (cached) {
      // Refresh the most volatile fields even when other fields are cached.
      // (Premium/verified status can change via admin actions; lastOnlineAt changes frequently.)
      try {
        const fresh = await this.prisma.user.findUnique({
          where: { id: cached.id },
          select: { lastOnlineAt: true, premium: true, premiumPlus: true, isOrganization: true, verifiedStatus: true, pinnedPostId: true },
        });
        const lastOnlineAt = fresh?.lastOnlineAt ? fresh.lastOnlineAt.toISOString() : null;
        const premium = fresh?.premium ?? cached.premium;
        const premiumPlus = (fresh as any)?.premiumPlus ?? (cached as any).premiumPlus ?? false;
        const isOrganization = (fresh as any)?.isOrganization ?? (cached as any).isOrganization ?? false;
        const verifiedStatus = (fresh as any)?.verifiedStatus ?? (cached as any).verifiedStatus ?? 'none';
        let pinnedPostId = fresh?.pinnedPostId ?? (cached as any).pinnedPostId ?? null;
        if (pinnedPostId) {
          const pinned = await this.prisma.post.findFirst({
            where: { id: pinnedPostId, userId: cached.id, deletedAt: null },
            select: { visibility: true },
          });
          if (!pinned || pinned.visibility === 'onlyMe') {
            try {
              await this.prisma.user.update({ where: { id: cached.id }, data: { pinnedPostId: null } });
              await this.publicProfileCache.invalidateForUser({ id: cached.id, username: (cached as any).username ?? null });
            } catch {
              // Best-effort
            }
            pinnedPostId = null;
          }
        }

        if (
          lastOnlineAt !== (cached as any).lastOnlineAt ||
          premium !== (cached as any).premium ||
          premiumPlus !== (cached as any).premiumPlus ||
          isOrganization !== (cached as any).isOrganization ||
          verifiedStatus !== (cached as any).verifiedStatus ||
          pinnedPostId !== (cached as any).pinnedPostId
        ) {
          const next: PublicProfilePayload = {
            ...(cached as any),
            lastOnlineAt,
            premium,
            premiumPlus,
            isOrganization,
            verifiedStatus,
            pinnedPostId,
          };
          void this.publicProfileCache.write(cacheKey, next, 5 * 60 * 1000);
          void this.publicProfileCache.write(`id:${next.id}`, next, 5 * 60 * 1000);
          if (next.username) void this.publicProfileCache.write(`username:${next.username.toLowerCase()}`, next, 5 * 60 * 1000);
          return { payload: next, cache: 'hit' };
        }
      } catch {
        // If lastOnlineAt refresh fails, fall back to cached payload.
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
          }>
        >`
          SELECT "id", "createdAt", "username", "name", "bio", "website", "locationDisplay", "locationCity", "locationCounty", "locationState", "locationCountry", "birthdate", "birthdayVisibility", "premium", "premiumPlus", "isOrganization", "stewardBadgeEnabled", "verifiedStatus", "avatarKey", "avatarUpdatedAt", "bannerKey", "bannerUpdatedAt", "pinnedPostId", "lastOnlineAt", "bannedAt", "checkinStreakDays", "longestStreakDays"
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

    if (user.bannedAt) {
      return { payload: { banned: true } as any, cache: 'miss' };
    }

    // Safety: only-me posts should never be pinnable/show on profiles.
    // If a user already pinned an only-me post (legacy bug), auto-unpin on read.
    let pinnedPostId: string | null = user.pinnedPostId ?? null;
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
      locationCity: user.locationCity ?? null,
      locationCounty: user.locationCounty ?? null,
      locationState: user.locationState ?? null,
      locationCountry: user.locationCountry ?? null,
      birthdayDisplay: formatBirthdayDisplay(user.birthdate, (user as any).birthdayVisibility ?? 'monthDay'),
      birthdayMonthDay: user.birthdate ? formatBirthdayMonthDay(user.birthdate) : null,
      premium: user.premium,
      premiumPlus: user.premiumPlus,
      isOrganization: Boolean((user as any).isOrganization),
      stewardBadgeEnabled: Boolean(user.stewardBadgeEnabled),
      verifiedStatus: user.verifiedStatus,
      avatarUrl: publicAssetUrl({ publicBaseUrl, key: user.avatarKey, updatedAt: user.avatarUpdatedAt }),
      bannerUrl: publicAssetUrl({ publicBaseUrl, key: user.bannerKey, updatedAt: user.bannerUpdatedAt }),
      pinnedPostId,
      lastOnlineAt: user.lastOnlineAt ? user.lastOnlineAt.toISOString() : null,
      checkinStreakDays: Math.max(0, Math.floor(Number(user.checkinStreakDays) || 0)),
      longestStreakDays: Math.max(0, Math.floor(Number(user.longestStreakDays) || 0)),
    };

    // Cache for subsequent reads (both by username and by id).
    void this.publicProfileCache.write(cacheKey, payload, 5 * 60 * 1000);
    void this.publicProfileCache.write(`id:${user.id}`, payload, 5 * 60 * 1000);
    if (user.username) void this.publicProfileCache.write(`username:${user.username.toLowerCase()}`, payload, 5 * 60 * 1000);

    return { payload, cache: 'miss' };
  }

  /**
   * On first username set, bootstrap starter follows:
   * 1) New user follows @menofhunger (one-way) when that account exists.
   * 2) New user and @john follow each other when @john exists.
   *
   * Uses FollowsService so follow notifications go through the normal flow.
   */
  private async ensureStarterFollowsOnFirstUsernameSet(userId: string, newUsername: string): Promise<void> {
    const usernameLower = (newUsername ?? '').trim().toLowerCase();
    if (!usernameLower) return;

    // First: one-way follow to @menofhunger (if account exists).
    if (usernameLower !== MENOFHUNGER_USERNAME) {
      try {
        await this.followsService.follow({ viewerUserId: userId, username: MENOFHUNGER_USERNAME });
        // New users: enable “every post” notifications for starter follows.
        await this.followsService.setPostNotificationsEnabled({
          viewerUserId: userId,
          username: MENOFHUNGER_USERNAME,
          enabled: true,
        });
      } catch {
        // Best-effort: ignore if account doesn't exist or relation already exists.
      }
    }

    if (usernameLower === JOHN_USERNAME) return;

    const john = await this.prisma.user.findFirst({
      where: {
        usernameIsSet: true,
        username: { equals: JOHN_USERNAME, mode: 'insensitive' },
      },
      select: { id: true },
    });
    if (!john) return;

    try {
      await this.followsService.follow({ viewerUserId: userId, username: JOHN_USERNAME });
      // New users: enable “every post” notifications for starter follows.
      await this.followsService.setPostNotificationsEnabled({
        viewerUserId: userId,
        username: JOHN_USERNAME,
        enabled: true,
      });
    } catch {
      // John may not exist or follow may already exist; ignore.
    }

    try {
      await this.followsService.follow({ viewerUserId: john.id, username: newUsername.trim() });
    } catch {
      // Idempotent or visibility; ignore.
    }
  }

  @Throttle({
    default: {
      limit: rateLimitLimit('publicRead', 120),
      ttl: rateLimitTtl('publicRead', 60),
    },
  })
  @Get('username/available')
  async usernameAvailable(@Query('username') username: string | undefined) {
    const parsed = validateUsername(username ?? '');
    if (!parsed.ok) return { data: { available: false, normalized: null, error: parsed.error } };

    const exists =
      (
        await this.prisma.$queryRaw<Array<{ id: string }>>`
          SELECT "id"
          FROM "User"
          WHERE LOWER("username") = LOWER(${parsed.username})
          LIMIT 1
        `
      )[0] ?? null;

    return { data: { available: !exists, normalized: parsed.usernameLower } };
  }

  @UseGuards(AuthGuard)
  @Throttle({
    default: {
      limit: rateLimitLimit('publicRead', 120),
      ttl: rateLimitTtl('publicRead', 60),
    },
  })
  @Get('newest')
  async newest(@CurrentUserId() viewerUserId: string, @Query() query: unknown) {
    const parsed = newestUsersSchema.parse(query);
    const limit = parsed.limit ?? 12;

    const rows = await this.prisma.user.findMany({
      where: {
        usernameIsSet: true,
        bannedAt: null,
        id: { not: viewerUserId },
        // Exclude users the viewer already follows.
        followers: { none: { followerId: viewerUserId } },
      },
      select: {
        id: true,
        username: true,
        name: true,
        premium: true,
        premiumPlus: true,
        isOrganization: true,
        stewardBadgeEnabled: true,
        verifiedStatus: true,
        avatarKey: true,
        avatarUpdatedAt: true,
        createdAt: true,
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit,
    });

    const rel = await this.followsService.batchRelationshipForUserIds({
      viewerUserId,
      userIds: rows.map((u) => u.id),
    });
    const publicBaseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;
    const users = rows.map((u) =>
      toUserListDto(u, publicBaseUrl, {
        relationship: {
          viewerFollowsUser: rel.viewerFollows.has(u.id),
          userFollowsViewer: rel.followsViewer.has(u.id),
          viewerPostNotificationsEnabled: rel.viewerBellEnabled.has(u.id),
        },
      }),
    );

    return { data: users };
  }

  @UseGuards(AuthGuard)
  @Patch('me/username')
  async setMyUsername(@Body() body: unknown, @CurrentUserId() userId: string) {
    const parsedBody = setUsernameSchema.parse(body);
    const desired = (parsedBody.username ?? '').trim();
    if (!desired) throw new BadRequestException('Username is required.');

    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found.');

    const currentLower = (user.username ?? '').trim().toLowerCase();
    const desiredLower = desired.toLowerCase();
    // Allow capitalization-only changes to the current username, even if the username doesn't meet
    // current validation rules (e.g. legacy/special-case usernames).
    if (currentLower && currentLower === desiredLower) {
      const updated = await this.prisma.user.update({
        where: { id: userId },
        data: { username: desired },
      });
      await this.publicProfileCache.invalidateForUser({ id: updated.id, username: updated.username ?? null });
      await this.emitUserSelfUpdated(updated.id);
      return { data: { user: toUserDto(updated, this.appConfig.r2()?.publicBaseUrl ?? null) } };
    }

    if (user.usernameIsSet) {
      // Once set, the only change allowed is capitalization (handled above).
      throw new ConflictException('Username is already set.');
    }

    const parsed = validateUsername(desired);
    if (!parsed.ok) throw new BadRequestException(parsed.error);

    try {
      const updated = await this.prisma.user.update({
        where: { id: userId },
        data: {
          username: parsed.username,
          usernameIsSet: true,
        },
      });

      await this.ensureStarterFollowsOnFirstUsernameSet(userId, updated.username ?? parsed.username);

      await this.publicProfileCache.invalidateForUser({ id: updated.id, username: updated.username ?? null });
      await this.emitUserSelfUpdated(updated.id);
      return {
        data: { user: toUserDto(updated, this.appConfig.r2()?.publicBaseUrl ?? null) },
      };
    } catch (err: unknown) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException('That username is taken.');
      }
      throw err;
    }
  }

  @Throttle({
    default: {
      limit: rateLimitLimit('publicRead', 300),
      ttl: rateLimitTtl('publicRead', 60),
    },
  })
  @UseGuards(OptionalAuthGuard)
  @Get(':username/preview')
  async userPreview(
    @OptionalCurrentUserId() userId: string | undefined,
    @Param('username') username: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const viewerUserId = userId ?? null;
    const canSeeLastOnline = await this.viewerCanSeeLastOnline(viewerUserId);

    const profileResult = await this.getPublicProfilePayloadByUsernameOrId(username);
    const profile = profileResult.payload;
    if (!this.appConfig.isProd()) {
      res.setHeader('x-moh-cache', `publicProfile=${profileResult.cache}`);
    }
    if ((profile as { banned?: boolean }).banned === true) {
      res.setHeader('Cache-Control', 'public, max-age=300, stale-while-revalidate=600');
      return { data: { banned: true } };
    }

    let relationship: { viewerFollowsUser: boolean; userFollowsViewer: boolean; viewerPostNotificationsEnabled: boolean } =
      {
      viewerFollowsUser: false,
      userFollowsViewer: false,
      viewerPostNotificationsEnabled: false,
    };
    let nudge: NudgeStateDto | null = null;
    let followerCount: number | null = null;
    let followingCount: number | null = null;

    if (profile.username) {
      const summary = await this.followsService.summary({ viewerUserId, username: profile.username });
      relationship = {
        viewerFollowsUser: summary.viewerFollowsUser,
        userFollowsViewer: summary.userFollowsViewer,
        viewerPostNotificationsEnabled: summary.viewerPostNotificationsEnabled,
      };
      nudge = summary.nudge;
      followerCount = summary.followerCount;
      followingCount = summary.followingCount;
    } else {
      const rel = await this.followsService.batchRelationshipForUserIds({
        viewerUserId,
        userIds: [profile.id],
      });
      relationship = {
        viewerFollowsUser: rel.viewerFollows.has(profile.id),
        userFollowsViewer: rel.followsViewer.has(profile.id),
        viewerPostNotificationsEnabled: rel.viewerBellEnabled.has(profile.id),
      };
    }

    const payload: UserPreviewPayload = {
      id: profile.id,
      username: profile.username,
      name: profile.name,
      bio: profile.bio,
      premium: profile.premium,
      premiumPlus: profile.premiumPlus,
      isOrganization: Boolean((profile as any).isOrganization),
      stewardBadgeEnabled: Boolean(profile.stewardBadgeEnabled),
      verifiedStatus: profile.verifiedStatus,
      avatarUrl: profile.avatarUrl,
      bannerUrl: profile.bannerUrl,
      lastOnlineAt: canSeeLastOnline ? (profile.lastOnlineAt ?? null) : null,
      checkinStreakDays: Math.max(0, Math.floor(Number((profile as any).checkinStreakDays) || 0)),
      longestStreakDays: Math.max(0, Math.floor(Number((profile as any).longestStreakDays) || 0)),
      relationship,
      nudge,
      followerCount,
      followingCount,
    };

    // Preview includes viewer-specific relationship when authenticated.
    // Allow longer caching for anonymous reads; authenticated must be private.
    res.setHeader(
      'Cache-Control',
      viewerUserId ? 'private, max-age=60, stale-while-revalidate=120' : 'public, max-age=300, stale-while-revalidate=600',
    );
    res.setHeader('Vary', 'Cookie');

    return { data: payload };
  }

  @Throttle({
    default: {
      limit: rateLimitLimit('publicRead', 300),
      ttl: rateLimitTtl('publicRead', 60),
    },
  })
  @UseGuards(OptionalAuthGuard)
  @Get(':username')
  async publicProfile(
    @OptionalCurrentUserId() userId: string | undefined,
    @Param('username') username: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const viewerUserId = userId ?? null;
    const canSeeLastOnline = await this.viewerCanSeeLastOnline(viewerUserId);
    const profileResult = await this.getPublicProfilePayloadByUsernameOrId(username);
    const payload = profileResult.payload;
    if (!this.appConfig.isProd()) {
      res.setHeader('x-moh-cache', `publicProfile=${profileResult.cache}`);
    }

    if ((payload as { banned?: boolean }).banned === true) {
      res.setHeader('Cache-Control', 'public, max-age=300, stale-while-revalidate=600');
      return { data: { banned: true } };
    }

    // lastOnlineAt is viewer-sensitive: only verified viewers can see it.
    // Anonymous reads can still be publicly cached since we always redact lastOnlineAt there.
    res.setHeader(
      'Cache-Control',
      viewerUserId ? 'private, max-age=60, stale-while-revalidate=120' : 'public, max-age=300, stale-while-revalidate=600',
    );
    if (viewerUserId) res.setHeader('Vary', 'Cookie');
    return { data: { ...(payload as any), lastOnlineAt: canSeeLastOnline ? (payload as any).lastOnlineAt : null } };
  }

  @UseGuards(AuthGuard)
  @Patch('me/profile')
  async updateMyProfile(@Body() body: unknown, @CurrentUserId() userId: string) {
    const parsed = profileSchema.parse(body);

    try {
      const existing = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { email: true, username: true, name: true },
      });
      if (!existing) throw new NotFoundException('User not found.');

      const now = new Date();
      let nextEmail: string | null | undefined = undefined;
      let emailChanged = false;

      const update: Prisma.UserUpdateInput = {
        name: parsed.name === undefined ? undefined : (parsed.name || null),
        bio: parsed.bio === undefined ? undefined : (parsed.bio || null),
      };
      if (parsed.email !== undefined) {
        const cleaned = parsed.email.trim() ? parsed.email.trim().toLowerCase() : null;
        nextEmail = cleaned;
        emailChanged = (existing.email ?? null) !== cleaned;
        (update as any).email = cleaned;
        if (emailChanged) {
          (update as any).emailVerifiedAt = null;
          (update as any).emailVerificationRequestedAt = cleaned ? now : null;
        }
      }

      if (parsed.website !== undefined) {
        const raw = (parsed.website ?? '').trim();
        update.website = raw ? normalizeWebsite(raw) : null;
      }

      if (parsed.locationQuery !== undefined) {
        const q = (parsed.locationQuery ?? '').trim();
        if (!q) {
          update.locationInput = null;
          update.locationDisplay = null;
          update.locationZip = null;
          update.locationCity = null;
          update.locationCounty = null;
          update.locationState = null;
          update.locationCountry = null;
        } else {
          const loc = await this.usersLocation.normalizeUsLocation(q);
          update.locationInput = loc.input;
          update.locationDisplay = loc.display;
          update.locationZip = loc.zip;
          update.locationCity = loc.city;
          update.locationCounty = loc.county;
          update.locationState = loc.state;
          update.locationCountry = loc.country;
        }
      }

      if (parsed.interests !== undefined) {
        const cleaned = Array.from(
          new Set(
            parsed.interests
              .map((s) => s.trim())
              .filter(Boolean),
          ),
        ).slice(0, 30);
        if (cleaned.length < 1) throw new BadRequestException('Select at least one interest.');
        const mapped = cleaned.map((s) => canonicalizeTopicValue(s)).filter(Boolean) as string[];
        if (mapped.length !== cleaned.length) {
          throw new BadRequestException('Interests must be selected from the curated list.');
        }
        update.interests = mapped;
      }

      const updated = await this.prisma.user.update({
        where: { id: userId },
        data: update,
      });

      await this.publicProfileCache.invalidateForUser({ id: updated.id, username: updated.username ?? null });
      await this.emitUserSelfUpdated(updated.id);
      this.usersMeRealtime.emitMeUpdatedFromUser(updated, emailChanged ? 'email_changed' : 'profile_changed');

      if (emailChanged && nextEmail) {
        const greetingName = (updated.name ?? updated.username ?? '').trim() || null;
        // Best-effort: don't block profile updates on email send.
        void this.emailVerification
          .requestVerification({ userId: updated.id, email: nextEmail, name: greetingName })
          .catch(() => undefined);
      }
      return {
        data: { user: toUserDto(updated, this.appConfig.r2()?.publicBaseUrl ?? null) },
      };
    } catch (err: unknown) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException('That email is already in use.');
      }
      throw err;
    }
  }

  @UseGuards(AuthGuard)
  @Put('me/pinned-post')
  async setPinnedPost(@Body() body: unknown, @CurrentUserId() userId: string) {
    const parsed = z.object({ postId: z.string().min(1) }).parse(body);
    const postId = (parsed.postId ?? '').trim();
    if (!postId) throw new BadRequestException('postId is required.');

    const post = await this.prisma.post.findFirst({
      where: { id: postId, deletedAt: null },
      select: { id: true, userId: true, visibility: true },
    });
    if (!post) throw new NotFoundException('Post not found.');
    if (post.userId !== userId) throw new NotFoundException('Post not found.');
    if (post.visibility === 'onlyMe') throw new BadRequestException('Only-me posts cannot be pinned.');

    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: { pinnedPostId: postId },
      select: { id: true, username: true },
    });
    await this.publicProfileCache.invalidateForUser({ id: updated.id, username: updated.username ?? null });
    await this.emitUserSelfUpdated(updated.id);
    void this.usersMeRealtime.emitMeUpdated(updated.id, 'pinned_post_changed');
    return { data: { pinnedPostId: postId } };
  }

  @UseGuards(AuthGuard)
  @Delete('me/pinned-post')
  async unpinPost(@CurrentUserId() userId: string) {
    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: { pinnedPostId: null },
      select: { id: true, username: true },
    });
    await this.publicProfileCache.invalidateForUser({ id: updated.id, username: updated.username ?? null });
    await this.emitUserSelfUpdated(updated.id);
    void this.usersMeRealtime.emitMeUpdated(updated.id, 'pinned_post_changed');
    return { data: { pinnedPostId: null } };
  }

  @UseGuards(AuthGuard)
  @Patch('me/settings')
  async updateMySettings(@Body() body: unknown, @CurrentUserId() userId: string) {
    const parsed = settingsSchema.parse(body);

    if (parsed.stewardBadgeEnabled !== undefined) {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { premiumPlus: true },
      });
      if (!user) throw new NotFoundException('User not found.');
      if (!user.premiumPlus) {
        throw new BadRequestException('Premium+ is required to change steward badge settings.');
      }
    }

    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: {
        followVisibility: parsed.followVisibility,
        birthdayVisibility: parsed.birthdayVisibility,
        ...(parsed.stewardBadgeEnabled !== undefined ? { stewardBadgeEnabled: parsed.stewardBadgeEnabled } : {}),
      },
    });

    await this.publicProfileCache.invalidateForUser({ id: updated.id, username: updated.username ?? null });
    await this.emitUserSelfUpdated(updated.id);
    this.usersMeRealtime.emitMeUpdatedFromUser(updated, 'settings_changed');
    return { data: { user: toUserDto(updated, this.appConfig.r2()?.publicBaseUrl ?? null) } };
  }

  @UseGuards(AuthGuard)
  @Patch('me/onboarding')
  async updateMyOnboarding(@Body() body: unknown, @CurrentUserId() userId: string) {
    const parsed = onboardingSchema.parse(body);

    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found.');

    const data: Prisma.UserUpdateInput = {};
    const now = new Date();
    let emailChanged = false;
    let nextEmail: string | null = user.email ?? null;

    // Required onboarding acknowledgement: once true, it stays true.
    if (!user.menOnlyConfirmed && parsed.menOnlyConfirmed !== true) {
      throw new BadRequestException('Please confirm you’re joining as part of our men’s community to continue.');
    }
    if (user.menOnlyConfirmed && parsed.menOnlyConfirmed === false) {
      throw new BadRequestException('This confirmation cannot be removed.');
    }
    if (parsed.menOnlyConfirmed === true) {
      data.menOnlyConfirmed = true;
    }

    if (parsed.name !== undefined) {
      data.name = parsed.name || null;
    }

    if (parsed.email !== undefined) {
      const cleaned = parsed.email.trim() ? parsed.email.trim().toLowerCase() : null;
      emailChanged = (user.email ?? null) !== cleaned;
      nextEmail = cleaned;
      (data as any).email = cleaned;
      if (emailChanged) {
        (data as any).emailVerifiedAt = null;
        (data as any).emailVerificationRequestedAt = cleaned ? now : null;
      }
    }

    if (parsed.birthdate !== undefined) {
      // Birthdate is locked once set (client enforces this too, but keep server safe).
      if (user.birthdate) {
        const existing = user.birthdate.toISOString().slice(0, 10);
        if (existing !== parsed.birthdate) {
          throw new BadRequestException('Birthday is locked once set.');
        }
        // If it matches, ignore.
      } else {
      // Store as UTC midnight.
      const d = new Date(`${parsed.birthdate}T00:00:00.000Z`);
      if (Number.isNaN(d.getTime())) throw new BadRequestException('Invalid birthdate.');
      if (!isAtLeast18(d)) {
        throw new BadRequestException('You must be at least 18 years old to join Men of Hunger.');
      }
      data.birthdate = d;
      }
    }

    if (parsed.interests !== undefined) {
      const cleaned = Array.from(
        new Set(
          parsed.interests
            .map((s) => s.trim())
            .filter(Boolean),
        ),
      ).slice(0, 30);
      if (cleaned.length < 1) throw new BadRequestException('Select at least one interest.');
      const mapped = cleaned.map((s) => canonicalizeTopicValue(s)).filter(Boolean) as string[];
      if (mapped.length !== cleaned.length) {
        throw new BadRequestException('Interests must be selected from the curated list.');
      }
      data.interests = mapped;
    }

    // Allow setting username here only if not already set.
    if (parsed.username !== undefined) {
      const desired = parsed.username.trim();
      if (!desired) throw new BadRequestException('Username is required.');
      if (user.usernameIsSet) {
        throw new ConflictException('Username is already set.');
      }
      const validated = validateUsername(desired);
      if (!validated.ok) throw new BadRequestException(validated.error);

      try {
        data.username = validated.username;
        data.usernameIsSet = true;
      } catch (err: unknown) {
        throw err;
      }
    }

    try {
      const updated = await this.prisma.user.update({
        where: { id: userId },
        data,
      });

      if (parsed.username !== undefined && updated.username) {
        await this.ensureStarterFollowsOnFirstUsernameSet(userId, updated.username);
      }

      await this.publicProfileCache.invalidateForUser({ id: updated.id, username: updated.username ?? null });
      await this.emitUserSelfUpdated(updated.id);
      this.usersMeRealtime.emitMeUpdatedFromUser(updated, emailChanged ? 'email_changed' : 'onboarding_changed');

      if (emailChanged && nextEmail) {
        const greetingName = (updated.name ?? updated.username ?? '').trim() || null;
        void this.emailVerification
          .requestVerification({ userId: updated.id, email: nextEmail, name: greetingName })
          .catch(() => undefined);
      }
      return { data: { user: toUserDto(updated, this.appConfig.r2()?.publicBaseUrl ?? null) } };
    } catch (err: unknown) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        // Could be username or email unique violations; keep it generic here.
        throw new ConflictException('That value is already in use.');
      }
      throw err;
    }
  }
}

