import { BadRequestException, Body, ConflictException, Controller, Get, NotFoundException, Param, Patch, Query, UseGuards } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service';
import { AuthGuard } from '../auth/auth.guard';
import { AppConfigService } from '../app/app-config.service';
import { FollowsService } from '../follows/follows.service';
import { CurrentUserId } from './users.decorator';
import { validateUsername } from './users.utils';
import { toUserDto } from './user.dto';
import { publicAssetUrl } from '../../common/assets/public-asset-url';
import { Throttle } from '@nestjs/throttler';
import { rateLimitLimit, rateLimitTtl } from '../../common/throttling/rate-limit.resolver';

const setUsernameSchema = z.object({
  username: z.string().min(1),
});

const profileSchema = z.object({
  name: z.string().trim().max(50).optional(),
  bio: z.string().trim().max(160).optional(),
  email: z.union([z.string().trim().email(), z.literal('')]).optional(),
});

const settingsSchema = z.object({
  followVisibility: z.enum(['all', 'verified', 'premium', 'none']).optional(),
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

@Controller('users')
export class UsersController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly appConfig: AppConfigService,
    private readonly followsService: FollowsService,
  ) {}

  /** On production, when a user first sets their username, make them and @john follow each other (unless they are @john). */
  private async ensureMutualFollowWithJohn(userId: string, newUsername: string): Promise<void> {
    if (!this.appConfig.isProd()) return;
    if ((newUsername ?? '').trim().toLowerCase() === JOHN_USERNAME) return;

    try {
      await this.followsService.follow({ viewerUserId: userId, username: JOHN_USERNAME });
    } catch {
      // John may not exist or follow may already exist; ignore.
    }

    const john = await this.prisma.user.findFirst({
      where: {
        usernameIsSet: true,
        username: { equals: JOHN_USERNAME, mode: 'insensitive' },
      },
      select: { id: true },
    });
    if (!john) return;

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
    if (!parsed.ok) return { available: false, normalized: null, error: parsed.error };

    const exists =
      (
        await this.prisma.$queryRaw<Array<{ id: string }>>`
          SELECT "id"
          FROM "User"
          WHERE LOWER("username") = LOWER(${parsed.username})
          LIMIT 1
        `
      )[0] ?? null;

    return { available: !exists, normalized: parsed.usernameLower };
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
      return { user: toUserDto(updated, this.appConfig.r2()?.publicBaseUrl ?? null) };
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

      await this.ensureMutualFollowWithJohn(userId, updated.username ?? parsed.username);

      return {
        user: toUserDto(updated, this.appConfig.r2()?.publicBaseUrl ?? null),
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
  @Get(':username')
  async publicProfile(@Param('username') username: string) {
    const raw = (username ?? '').trim();
    if (!raw) throw new NotFoundException('User not found');

    const normalized = raw.toLowerCase();
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(raw);
    const isCuid = /^c[a-z0-9]{24}$/i.test(raw);

    const user =
      (
        await this.prisma.$queryRaw<
          Array<{
            id: string;
            username: string | null;
            name: string | null;
            bio: string | null;
            premium: boolean;
            verifiedStatus: string;
            avatarKey: string | null;
            avatarUpdatedAt: Date | null;
            bannerKey: string | null;
            bannerUpdatedAt: Date | null;
          }>
        >`
          SELECT "id", "username", "name", "bio", "premium", "verifiedStatus", "avatarKey", "avatarUpdatedAt", "bannerKey", "bannerUpdatedAt"
          FROM "User"
          WHERE (
            (${isUuid || isCuid} = true AND "id" = ${raw})
            OR
            (${isUuid || isCuid} = false AND LOWER("username") = ${normalized})
          )
          AND "usernameIsSet" = true
          LIMIT 1
        `
      )[0] ?? null;

    if (!user) throw new NotFoundException('User not found');
    const publicBaseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;
    return {
      user: {
        id: user.id,
        username: user.username,
        name: user.name,
        bio: user.bio,
        premium: user.premium,
        verifiedStatus: user.verifiedStatus,
        avatarUrl: publicAssetUrl({ publicBaseUrl, key: user.avatarKey, updatedAt: user.avatarUpdatedAt }),
        bannerUrl: publicAssetUrl({ publicBaseUrl, key: user.bannerKey, updatedAt: user.bannerUpdatedAt }),
      },
    };
  }

  @UseGuards(AuthGuard)
  @Patch('me/profile')
  async updateMyProfile(@Body() body: unknown, @CurrentUserId() userId: string) {
    const parsed = profileSchema.parse(body);

    try {
      const updated = await this.prisma.user.update({
        where: { id: userId },
        data: {
          name: parsed.name === undefined ? undefined : (parsed.name || null),
          bio: parsed.bio === undefined ? undefined : (parsed.bio || null),
          email:
            parsed.email === undefined
              ? undefined
              : parsed.email.trim()
                ? parsed.email.trim().toLowerCase()
                : null,
        },
      });

      return {
        user: toUserDto(updated, this.appConfig.r2()?.publicBaseUrl ?? null),
      };
    } catch (err: unknown) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException('That email is already in use.');
      }
      throw err;
    }
  }

  @UseGuards(AuthGuard)
  @Patch('me/settings')
  async updateMySettings(@Body() body: unknown, @CurrentUserId() userId: string) {
    const parsed = settingsSchema.parse(body);

    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: {
        followVisibility: parsed.followVisibility,
      },
    });

    return { user: toUserDto(updated, this.appConfig.r2()?.publicBaseUrl ?? null) };
  }

  @UseGuards(AuthGuard)
  @Patch('me/onboarding')
  async updateMyOnboarding(@Body() body: unknown, @CurrentUserId() userId: string) {
    const parsed = onboardingSchema.parse(body);

    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found.');

    const data: Prisma.UserUpdateInput = {};

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
      data.email = cleaned;
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
      data.interests = cleaned;
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
        await this.ensureMutualFollowWithJohn(userId, updated.username);
      }

      return { user: toUserDto(updated, this.appConfig.r2()?.publicBaseUrl ?? null) };
    } catch (err: unknown) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        // Could be username or email unique violations; keep it generic here.
        throw new ConflictException('That value is already in use.');
      }
      throw err;
    }
  }
}

