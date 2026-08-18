import { BadRequestException, Body, ConflictException, Controller, Delete, Get, HttpCode, NotFoundException, Param, Patch, Post, Put, Query, Res, UseGuards } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { AuthGuard } from '../auth/auth.guard';
import { OptionalAuthGuard } from '../auth/optional-auth.guard';
import { AuthService } from '../auth/auth.service';
import { AppConfigService } from '../app/app-config.service';
import { FollowsService } from '../follows/follows.service';
import { CurrentUserId, OptionalCurrentUserId } from './users.decorator';
import { validateUsername } from './users.utils';
import {
  HEARD_ABOUT_US_OTHER_MAX,
  HEARD_ABOUT_US_VALUES,
  isFullyOnboarded,
  resolveHeardAboutUs,
  resolveOnboardingUsername,
} from './onboarding.utils';
import { toUserDto } from './user.dto';
import { toUserListDto, type NudgeStateDto } from '../../common/dto';
import { USER_LIST_SELECT } from '../../common/prisma-selects/user.select';
import { Throttle } from '@nestjs/throttler';
import { rateLimitLimit, rateLimitTtl } from '../../common/throttling/rate-limit.resolver';
import { PublicProfileCacheService } from './public-profile-cache.service';
import { PublicProfilesService, type PublicProfilePayload } from './public-profiles.service';
import { UsersMeRealtimeService } from './users-me-realtime.service';
import { UsersPublicRealtimeService } from './users-public-realtime.service';
import { canonicalizeTopicValue } from '../../common/topics/topic-utils';
import { normalizeSocialHandle } from './social-handles';
import { UsersLocationService, STATE_NAMES } from './users-location.service';
import { EmailVerificationService } from '../email/email-verification.service';
import { PosthogService } from '../../common/posthog/posthog.service';
import { SlackService } from '../../common/slack/slack.service';
import { PresenceService } from '../presence/presence.service';
import { totalUserArticlesWhere, totalUserPostsWhere } from '../../common/content-counts';
import type { LocationBrowseResponseDto } from './location-browse.dto';

const setUsernameSchema = z.object({
  username: z.string().min(1),
});

const PREVIEW_BATCH_MAX = 50;
const previewBatchSchema = z.object({
  usernames: z.array(z.string().min(1).max(64)).min(1).max(PREVIEW_BATCH_MAX),
});

type PreviewBatchEntry = {
  username: string;
  id: string | null;
  premium?: boolean;
  premiumPlus?: boolean;
  isOrganization?: boolean;
  verifiedStatus?: string;
};

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
  // Generous max because we also accept pasted profile URLs; the real constraint is in normalizeSocialHandle.
  xUsername: z.union([z.string().trim().max(200), z.literal('')]).optional(),
  pickaxUsername: z.union([z.string().trim().max(200), z.literal('')]).optional(),
  locationQuery: z.union([z.string().trim().max(10), z.literal('')]).optional(),
});

const settingsSchema = z.object({
  followVisibility: z.enum(['all', 'verified', 'premium', 'none']).optional(),
  birthdayVisibility: z.enum(['none', 'monthDay', 'full']).optional(),
});

const onboardingSchema = z.object({
  username: z.string().min(1).optional(),
  name: z.string().trim().max(50).optional(),
  email: z.union([z.string().trim().email(), z.literal('')]).optional(),
  // Expect YYYY-MM-DD from client.
  birthdate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Birthdate must be a date (YYYY-MM-DD).').optional(),
  interests: z.array(z.string().trim().min(1).max(40)).min(1).max(30).optional(),
  menOnlyConfirmed: z.boolean().optional(),
  locationQuery: z.union([z.string().trim().max(10), z.literal('')]).optional(),
  heardAboutUs: z.enum(HEARD_ABOUT_US_VALUES).optional(),
  heardAboutUsOther: z.string().trim().max(HEARD_ABOUT_US_OTHER_MAX).optional().nullable(),
});

const newestUsersSchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).optional(),
});

const byLocationSchema = z.object({
  state: z.string().trim().min(1).max(100),
  zip: z.string().trim().max(20).optional(),
  city: z.string().trim().max(100).optional(),
  county: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});

const articleTagPreferencesSchema = z.object({
  tags: z.array(z.string().trim().min(1).max(50)).max(20),
});

const taxonomyPreferencesSchema = z.object({
  termIds: z.array(z.string().trim().min(1)).max(30).optional(),
  slugs: z.array(z.string().trim().min(1).max(80)).max(30).optional(),
});

function normalizeTag(raw: string): string {
  return raw
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 50);
}

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

type UserPreviewPayload = {
  id: string;
  username: string | null;
  name: string | null;
  bio: string | null;
  premium: boolean;
  premiumPlus: boolean;
  isOrganization: boolean;
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
  viewerHasBlockedUser?: boolean;
  userHasBlockedViewer?: boolean;
  isBot?: boolean;
  locationDisplay: string | null;
  locationState: string | null;
};

@ApiTags('Profiles & Social')
@Controller('users')
export class UsersController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly appConfig: AppConfigService,
    private readonly followsService: FollowsService,
    private readonly publicProfileCache: PublicProfileCacheService<PublicProfilePayload>,
    private readonly publicProfiles: PublicProfilesService,
    private readonly usersMeRealtime: UsersMeRealtimeService,
    private readonly usersPublicRealtime: UsersPublicRealtimeService,
    private readonly usersLocation: UsersLocationService,
    private readonly emailVerification: EmailVerificationService,
    private readonly posthog: PosthogService,
    private readonly slack: SlackService,
    private readonly presence: PresenceService,
    private readonly auth: AuthService,
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
        // New users: enable reply notifications for starter follows.
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
      // New users: enable reply notifications for starter follows.
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

  @UseGuards(AuthGuard)
  @Throttle({
    default: {
      limit: 30,
      ttl: 60_000,
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
      select: USER_LIST_SELECT,
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
  @Throttle({ default: { limit: rateLimitLimit('publicRead', 60), ttl: rateLimitTtl('publicRead', 60) } })
  @Get('location-preview')
  async locationPreview(@Query() query: unknown) {
    const { zip } = z.object({ zip: z.string().trim() }).parse(query);
    const result = this.usersLocation.normalizeUsLocation(zip);
    const stateCode = (result.state ?? '').toUpperCase();
    return {
      data: {
        zip: result.zip,
        city: result.city,
        state: result.state,
        stateDisplay: STATE_NAMES[stateCode] ?? result.state,
        display: result.display,
      },
    };
  }

  @UseGuards(AuthGuard)
  @Throttle({ default: { limit: rateLimitLimit('interact', 60), ttl: rateLimitTtl('interact', 60) } })
  @Post('me/skip-location-prompt')
  async skipLocationPrompt(@CurrentUserId() userId: string) {
    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: { locationPromptSkipped: true },
    });
    const r2PublicBaseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;
    void this.usersMeRealtime.emitMeUpdatedFromUser(updated, 'profile_changed');
    return { data: { user: toUserDto(updated, r2PublicBaseUrl) } };
  }

  @UseGuards(AuthGuard)
  @Throttle({
    default: {
      limit: rateLimitLimit('publicRead', 60),
      ttl: rateLimitTtl('publicRead', 60),
    },
  })
  @Get('by-location')
  async byLocation(
    @CurrentUserId() viewerUserId: string,
    @Query() query: unknown,
  ): Promise<{ data: LocationBrowseResponseDto }> {
    const { state, zip, city, county, limit = 10 } = byLocationSchema.parse(query);
    const publicBaseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;
    const stateCode = state.toUpperCase();
    const stateDisplay = STATE_NAMES[stateCode] ?? stateCode;

    const baseWhere = { usernameIsSet: true, bannedAt: null };

    // State-only queries show all members including the viewer themselves.
    const isStateOnly = !zip && !city && !county;
    const excludedIds = new Set<string>(isStateOnly ? [] : [viewerUserId]);

    const fetchSection = async (where: Record<string, unknown>) => {
      const rows = await this.prisma.user.findMany({
        where: { ...baseWhere, ...where, id: { notIn: Array.from(excludedIds) } },
        select: USER_LIST_SELECT,
        // Most active streakers first; oldest/founding members break ties.
        orderBy: [{ checkinStreakDays: 'desc' }, { createdAt: 'asc' }],
        take: limit,
      });
      rows.forEach((r) => excludedIds.add(r.id));
      return rows;
    };

    // Run sequentially: each section excludes IDs collected by earlier (closer) sections.
    const zipRows = zip ? await fetchSection({ locationZip: zip }) : [];
    const cityRows = city ? await fetchSection({ locationCity: city, locationState: stateCode }) : [];
    const countyRows = county ? await fetchSection({ locationCounty: county, locationState: stateCode }) : [];
    const stateRows = await fetchSection({ locationState: stateCode });
    const memberCount = await this.prisma.user.count({
      where: { ...baseWhere, locationState: stateCode },
    });

    const allRows = [...zipRows, ...cityRows, ...countyRows, ...stateRows];
    const rel = await this.followsService.batchRelationshipForUserIds({
      viewerUserId,
      userIds: allRows.map((u) => u.id),
    });

    const mapUsers = (rows: typeof allRows) =>
      rows.map((u) =>
        toUserListDto(u, publicBaseUrl, {
          relationship: {
            viewerFollowsUser: rel.viewerFollows.has(u.id),
            userFollowsViewer: rel.followsViewer.has(u.id),
            viewerPostNotificationsEnabled: rel.viewerBellEnabled.has(u.id),
          },
        }),
      );

    const sections: LocationBrowseResponseDto['sections'] = [
      ...(zip ? [{ key: 'sameZip' as const, label: 'Same ZIP code', users: mapUsers(zipRows) }] : []),
      ...(city ? [{ key: 'sameCity' as const, label: 'Same city', users: mapUsers(cityRows) }] : []),
      ...(county ? [{ key: 'sameCounty' as const, label: 'Same county', users: mapUsers(countyRows) }] : []),
      { key: 'sameState' as const, label: `Members in ${stateDisplay}`, users: mapUsers(stateRows) },
    ];

    return {
      data: {
        location: {
          ...(zip ? { zip } : {}),
          ...(city ? { city } : {}),
          ...(county ? { county } : {}),
          state: stateCode,
          stateDisplay,
        },
        memberCount,
        sections,
      },
    };
  }

  @UseGuards(AuthGuard)
  @Throttle({
    default: {
      limit: rateLimitLimit('interact', 180),
      ttl: rateLimitTtl('interact', 60),
    },
  })
  @Get('me/article-tag-preferences')
  async getMyArticleTagPreferences(@CurrentUserId() userId: string) {
    // Legacy endpoint: read canonical taxonomy preferences first, fallback to historical rows.
    const canonical = await this.prisma.userTaxonomyPreference.findMany({
      where: { userId },
      include: { term: { select: { slug: true, label: true } } },
      orderBy: [{ createdAt: 'asc' }],
    });
    if (canonical.length > 0) {
      return {
        data: canonical.map((r) => ({ tag: r.term.slug, label: r.term.label })),
      };
    }
    const legacy = await this.prisma.userArticleTagPreference.findMany({
      where: { userId },
      select: { tag: true, label: true },
      orderBy: [{ createdAt: 'asc' }, { tag: 'asc' }],
    });
    return { data: legacy };
  }

  @UseGuards(AuthGuard)
  @Throttle({
    default: {
      limit: rateLimitLimit('interact', 180),
      ttl: rateLimitTtl('interact', 60),
    },
  })
  @Put('me/article-tag-preferences')
  async setMyArticleTagPreferences(
    @CurrentUserId() userId: string,
    @Body() body: unknown,
  ) {
    const parsed = articleTagPreferencesSchema.parse(body);
    const deduped = new Map<string, string>();
    for (const raw of parsed.tags) {
      const tag = normalizeTag(raw);
      const label = raw.trim().substring(0, 50);
      if (!tag || !label) continue;
      if (!deduped.has(tag)) deduped.set(tag, label);
    }
    const rows = [...deduped.entries()].map(([tag, label]) => ({ userId, tag, label }));

    const slugs = rows.map((r) => r.tag);
    const terms = slugs.length > 0
      ? await this.prisma.taxonomyTerm.findMany({
          where: { slug: { in: slugs }, status: 'active' },
          select: { id: true, slug: true, label: true },
        })
      : [];
    const bySlug = new Map(terms.map((t) => [t.slug, t]));

    await this.prisma.$transaction(async (tx) => {
      await tx.userArticleTagPreference.deleteMany({ where: { userId } });
      if (rows.length > 0) {
        await tx.userArticleTagPreference.createMany({ data: rows, skipDuplicates: true });
      }
      await tx.userTaxonomyPreference.deleteMany({ where: { userId } });
      const prefRows = rows
        .map((r) => bySlug.get(r.tag))
        .filter(Boolean)
        .map((t) => ({ userId, termId: (t as { id: string }).id }));
      if (prefRows.length > 0) {
        await tx.userTaxonomyPreference.createMany({ data: prefRows, skipDuplicates: true });
      }
    });

    return {
      data: rows.map((r) => ({ tag: r.tag, label: r.label })),
    };
  }

  @UseGuards(AuthGuard)
  @Throttle({
    default: {
      limit: rateLimitLimit('interact', 180),
      ttl: rateLimitTtl('interact', 60),
    },
  })
  @Get('me/taxonomy-preferences')
  async getMyTaxonomyPreferences(@CurrentUserId() userId: string) {
    const rows = await this.prisma.userTaxonomyPreference.findMany({
      where: { userId },
      include: {
        term: { select: { id: true, slug: true, label: true, kind: true } },
      },
      orderBy: [{ createdAt: 'asc' }],
    });
    return {
      data: rows.map((r) => ({
        termId: r.term.id,
        slug: r.term.slug,
        label: r.term.label,
        kind: r.term.kind,
      })),
    };
  }

  @UseGuards(AuthGuard)
  @Throttle({
    default: {
      limit: rateLimitLimit('interact', 180),
      ttl: rateLimitTtl('interact', 60),
    },
  })
  @Put('me/taxonomy-preferences')
  async setMyTaxonomyPreferences(@CurrentUserId() userId: string, @Body() body: unknown) {
    const parsed = taxonomyPreferencesSchema.parse(body);
    const termIds = [...new Set((parsed.termIds ?? []).map((v) => v.trim()).filter(Boolean))];
    const slugs = [...new Set((parsed.slugs ?? []).map((v) => normalizeTag(v)).filter(Boolean))];

    const terms = (termIds.length > 0 || slugs.length > 0)
      ? await this.prisma.taxonomyTerm.findMany({
          where: {
            status: 'active',
            OR: [
              ...(termIds.length > 0 ? [{ id: { in: termIds } }] : []),
              ...(slugs.length > 0 ? [{ slug: { in: slugs } }] : []),
            ],
          },
          select: { id: true, slug: true, label: true, kind: true },
          take: 30,
        })
      : [];

    await this.prisma.$transaction(async (tx) => {
      await tx.userTaxonomyPreference.deleteMany({ where: { userId } });
      if (terms.length > 0) {
        await tx.userTaxonomyPreference.createMany({
          data: terms.map((t) => ({ userId, termId: t.id })),
          skipDuplicates: true,
        });
      }
      // Keep legacy table dual-written during rollout.
      await tx.userArticleTagPreference.deleteMany({ where: { userId } });
      if (terms.length > 0) {
        await tx.userArticleTagPreference.createMany({
          data: terms.map((t) => ({ userId, tag: t.slug, label: t.label.slice(0, 50) })),
          skipDuplicates: true,
        });
      }
    });

    return {
      data: terms.map((t) => ({
        termId: t.id,
        slug: t.slug,
        label: t.label,
        kind: t.kind,
      })),
    };
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
      this.presence.markSeenFromHttp(userId);
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
      this.usersMeRealtime.emitMeUpdatedFromUser(updated, 'username_set');
      this.presence.markSeenFromHttp(userId);
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

  /**
   * Lightweight batch lookup for chat @mention validation.
   *
   * Returns one entry per requested username with `id` (null when the username
   * doesn't resolve to a real user) plus tier signals (`premium`, `premiumPlus`,
   * `isOrganization`, `verifiedStatus`) that the chat UI uses to color the mention.
   *
   * Replaces the per-message GET /users/:username/preview fan-out that was
   * dispatched on chat mount — at 50 messages with a few mentions each, the old
   * shape produced 50+ HTTP requests; this is one round-trip.
   */
  @Throttle({
    default: {
      limit: rateLimitLimit('publicRead', 300),
      ttl: rateLimitTtl('publicRead', 60),
    },
  })
  @UseGuards(OptionalAuthGuard)
  @Post('preview/batch')
  @HttpCode(200)
  async userPreviewBatch(@Body() body: unknown) {
    const parsed = previewBatchSchema.parse(body);

    // Normalize + dedupe input (preserve insertion order for the response shape).
    const requested: string[] = [];
    const seen = new Set<string>();
    for (const raw of parsed.usernames) {
      const un = (raw ?? '').toLowerCase().trim();
      if (!un || seen.has(un)) continue;
      seen.add(un);
      requested.push(un);
    }
    if (requested.length === 0) return { data: { results: [] as PreviewBatchEntry[] } };

    const rows = await this.prisma.user.findMany({
      where: {
        username: { in: requested, mode: 'insensitive' },
        bannedAt: null,
      },
      select: {
        id: true,
        username: true,
        premium: true,
        premiumPlus: true,
        isOrganization: true,
        verifiedStatus: true,
      },
    });

    const byLowerUsername = new Map<string, (typeof rows)[number]>();
    for (const row of rows) {
      const key = (row.username ?? '').toLowerCase().trim();
      if (key) byLowerUsername.set(key, row);
    }

    const results: PreviewBatchEntry[] = requested.map((username) => {
      const found = byLowerUsername.get(username);
      if (!found) return { username, id: null };
      return {
        username,
        id: found.id,
        premium: Boolean(found.premium),
        premiumPlus: Boolean(found.premiumPlus),
        isOrganization: Boolean(found.isOrganization),
        verifiedStatus: String(found.verifiedStatus ?? 'none'),
      };
    });

    return { data: { results } };
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

    const profileResult = await this.publicProfiles.getByUsernameOrId(username);
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

    let viewerHasBlockedUser = false;
    let userHasBlockedViewer = false;
    if (viewerUserId && profile.id && viewerUserId !== profile.id) {
      const blockRows = await this.prisma.userBlock.findMany({
        where: {
          OR: [
            { blockerId: viewerUserId, blockedId: profile.id },
            { blockerId: profile.id, blockedId: viewerUserId },
          ],
        },
        select: { blockerId: true },
      });
      for (const row of blockRows) {
        if (row.blockerId === viewerUserId) viewerHasBlockedUser = true;
        else userHasBlockedViewer = true;
      }
    }

    const payload: UserPreviewPayload = {
      id: profile.id,
      username: profile.username,
      name: profile.name,
      bio: profile.bio,
      premium: profile.premium,
      premiumPlus: profile.premiumPlus,
      isOrganization: Boolean((profile as any).isOrganization),
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
      viewerHasBlockedUser,
      userHasBlockedViewer,
      isBot: Boolean((profile as any).isBot),
      locationDisplay: (profile as any).locationDisplay ?? null,
      locationState: (profile as any).locationState ?? null,
    };

    // Preview includes viewer-specific relationship when authenticated.
    // Allow longer caching for anonymous reads; authenticated must be private.
    res.setHeader(
      'Cache-Control',
      viewerUserId ? 'private, max-age=60, stale-while-revalidate=120' : 'public, max-age=300, stale-while-revalidate=600',
    );
    res.setHeader('Vary', 'Cookie');

    const orgMap = await this.publicProfiles.batchOrgAffiliations([payload.id]);
    return { data: { ...payload, orgAffiliations: orgMap.get(payload.id) ?? [] } };
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
    const profileResult = await this.publicProfiles.getByUsernameOrId(username);
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

    const profileId = (payload as any).id as string | undefined;
    const [orgMap, crewMember, postCount, articleCount] = await Promise.all([
      profileId ? this.publicProfiles.batchOrgAffiliations([profileId]) : Promise.resolve(new Map()),
      profileId
        ? this.prisma.crewMember.findFirst({
            where: { userId: profileId, crew: { deletedAt: null } },
            select: { crewId: true },
          })
        : Promise.resolve(null),
      profileId
        ? this.prisma.post.count({ where: totalUserPostsWhere(profileId) })
        : Promise.resolve(0),
      profileId
        ? this.prisma.article.count({
            where: totalUserArticlesWhere(profileId),
          })
        : Promise.resolve(0),
    ]);

    if (viewerUserId && profileId) {
      this.posthog.capture(viewerUserId, 'profile_viewed', {
        viewed_user_id: profileId,
        is_own_profile: viewerUserId === profileId,
      });
    }

    return {
      data: {
        ...(payload as any),
        lastOnlineAt: canSeeLastOnline ? (payload as any).lastOnlineAt : null,
        orgAffiliations: orgMap.get(profileId ?? '') ?? [],
        postCount,
        articleCount,
        inCrew: Boolean(crewMember),
      },
    };
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

      if (parsed.xUsername !== undefined) {
        const raw = (parsed.xUsername ?? '').trim();
        update.xUsername = raw ? normalizeSocialHandle('x', raw) : null;
      }

      if (parsed.pickaxUsername !== undefined) {
        const raw = (parsed.pickaxUsername ?? '').trim();
        update.pickaxUsername = raw ? normalizeSocialHandle('pickax', raw) : null;
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
      this.presence.markSeenFromHttp(userId);

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

    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: {
        followVisibility: parsed.followVisibility,
        birthdayVisibility: parsed.birthdayVisibility,
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
    let usernameFirstSet = false;

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

    if (parsed.username !== undefined) {
      const resolved = resolveOnboardingUsername({
        desired: parsed.username,
        currentUsername: user.username,
        usernameIsSet: user.usernameIsSet,
      });
      if (resolved) {
        data.username = resolved.username;
        if ('usernameIsSet' in resolved) {
          data.usernameIsSet = true;
          usernameFirstSet = true;
        }
      }
    }

    if (parsed.heardAboutUs !== undefined) {
      const heard = resolveHeardAboutUs({
        heardAboutUs: parsed.heardAboutUs,
        heardAboutUsOther: parsed.heardAboutUsOther,
      });
      data.heardAboutUs = heard.heardAboutUs;
      data.heardAboutUsOther = heard.heardAboutUsOther;
    }

    // Optional ZIP — silently ignored if invalid (non-blocking for onboarding).
    if (parsed.locationQuery) {
      try {
        const loc = this.usersLocation.normalizeUsLocation(parsed.locationQuery);
        data.locationInput = loc.input;
        data.locationDisplay = loc.display;
        data.locationZip = loc.zip;
        data.locationCity = loc.city;
        data.locationCounty = loc.county;
        data.locationState = loc.state;
        data.locationCountry = loc.country;
      } catch {
        // Invalid ZIP — skip silently so onboarding still completes.
      }
    }

    const wasComplete = isFullyOnboarded(user);

    try {
      const updated = await this.prisma.user.update({
        where: { id: userId },
        data,
      });

      if (usernameFirstSet && updated.username) {
        await this.ensureStarterFollowsOnFirstUsernameSet(userId, updated.username);
      }

      if (!wasComplete && isFullyOnboarded(updated) && updated.username) {
        this.posthog.capture(userId, 'onboarding_completed', { username: updated.username });
        const r2PublicBaseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;
        const avatarUrl = r2PublicBaseUrl && updated.avatarKey ? `${r2PublicBaseUrl}/${updated.avatarKey}` : null;
        this.slack.notifyProfileComplete({
          userId,
          username: updated.username,
          name: updated.name ?? null,
          email: updated.email ?? null,
          location: updated.locationDisplay ?? updated.locationInput ?? null,
          interests: updated.interests ?? [],
          avatarUrl,
        });
      }

      await this.publicProfileCache.invalidateForUser({ id: updated.id, username: updated.username ?? null });
      // Bust the Redis session cache so the next /auth/me SSR call reads fresh user data
      // instead of the 30-second stale cache (which would re-show the onboarding gate on refresh).
      void this.auth.bustSessionCachesForUser(userId);
      await this.emitUserSelfUpdated(updated.id);
      this.usersMeRealtime.emitMeUpdatedFromUser(updated, emailChanged ? 'email_changed' : 'onboarding_changed');
      this.presence.markSeenFromHttp(userId);

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

