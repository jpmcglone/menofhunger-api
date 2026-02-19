import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Req,
  NotFoundException,
  Param,
  Post,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ModuleRef } from '@nestjs/core';
import { z } from 'zod';
import { normalizePhone } from '../auth/auth.utils';
import { AppConfigService } from '../app/app-config.service';
import { toUserDto } from '../../common/dto';
import { PrismaService } from '../prisma/prisma.service';
import { validateUsername } from '../users/users.utils';
import { PublicProfileCacheService } from '../users/public-profile-cache.service';
import { AdminGuard, type AdminRequest } from './admin.guard';
import { UsersMeRealtimeService } from '../users/users-me-realtime.service';
import { UsersPublicRealtimeService } from '../users/users-public-realtime.service';
import { AuthService } from '../auth/auth.service';
import { PresenceRealtimeService } from '../presence/presence-realtime.service';

const searchSchema = z.object({
  q: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
  cursor: z.string().optional(),
});

const bannedListSchema = z.object({
  q: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
  cursor: z.string().optional(),
});

const adminUsernameSchema = z.object({
  username: z.string().optional(),
});

const banSchema = z.object({
  reason: z.string().trim().max(500).optional(),
});

const updateUserSchema = z.object({
  phone: z.string().trim().min(1).optional(),
  username: z.union([z.string().trim().min(1), z.null()]).optional(),
  name: z.string().trim().max(50).nullable().optional(),
  bio: z.string().trim().max(160).nullable().optional(),
  premium: z.boolean().optional(),
  premiumPlus: z.boolean().optional(),
  isOrganization: z.boolean().optional(),
  verifiedStatus: z.enum(['none', 'identity', 'manual']).optional(),
});

@UseGuards(AdminGuard)
@Controller('admin/users')
export class AdminUsersController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly appConfig: AppConfigService,
    private readonly publicProfileCache: PublicProfileCacheService<{ id: string; username: string | null }>,
    private readonly usersMeRealtime: UsersMeRealtimeService,
    private readonly usersPublicRealtime: UsersPublicRealtimeService,
    private readonly auth: AuthService,
    private readonly moduleRef: ModuleRef,
  ) {}

  @Get('banned')
  async listBanned(@Query() query: unknown) {
    const { q, limit, cursor } = bannedListSchema.parse(query);
    const take = limit ?? 25;

    const raw = (q ?? '').trim();
    const cleaned = raw.startsWith('@') ? raw.slice(1) : raw;

    const where: Prisma.UserWhereInput = {
      bannedAt: { not: null },
      ...(cleaned
        ? {
            OR: [
              { username: { contains: cleaned, mode: 'insensitive' } },
              { name: { contains: cleaned, mode: 'insensitive' } },
              { email: { contains: cleaned, mode: 'insensitive' } },
              { phone: { contains: cleaned } },
            ],
          }
        : {}),
    };

    const users = await this.prisma.user.findMany({
      where,
      orderBy: { id: 'desc' },
      take: take + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });

    const slice = users.slice(0, take);
    const nextCursor = users.length > take ? slice[slice.length - 1]?.id ?? null : null;
    const publicBaseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;

    return {
      data: slice.map((u) => toUserDto(u, publicBaseUrl)),
      pagination: { nextCursor },
    };
  }

  @Get('search')
  async search(@Query() query: unknown) {
    const { q, limit, cursor } = searchSchema.parse(query);
    const take = limit ?? 20;

    const raw = (q ?? '').trim();
    const cleaned = raw.startsWith('@') ? raw.slice(1) : raw;

    const where: Prisma.UserWhereInput | undefined = cleaned
      ? {
          OR: [
            { username: { contains: cleaned, mode: 'insensitive' } },
            { name: { contains: cleaned, mode: 'insensitive' } },
            { email: { contains: cleaned, mode: 'insensitive' } },
            { phone: { contains: cleaned } },
          ],
        }
      : undefined;

    const users = await this.prisma.user.findMany({
      where,
      orderBy: { id: 'desc' },
      take: take + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });

    const slice = users.slice(0, take);
    const nextCursor = users.length > take ? slice[slice.length - 1]?.id ?? null : null;
    const publicBaseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;

    return {
      data: slice.map((u) => toUserDto(u, publicBaseUrl)),
      pagination: { nextCursor },
    };
  }

  @Get('username/available')
  async usernameAvailable(@Query() query: unknown) {
    const { username } = adminUsernameSchema.parse(query);
    const parsed = validateUsername(username ?? '', { minLen: 2 });
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

  @Post(':id/ban')
  async ban(@Req() req: AdminRequest, @Param('id') id: string, @Body() body: unknown) {
    const { reason } = banSchema.parse(body);
    const adminId = String(req.user?.id ?? '').trim();
    if (!adminId) throw new NotFoundException();

    const current = await this.prisma.user.findUnique({
      where: { id },
      select: { id: true, siteAdmin: true, username: true },
    });
    if (!current) throw new NotFoundException('User not found.');
    if (current.siteAdmin) throw new BadRequestException('Site admins cannot be banned.');

    const now = new Date();
    const updated = await this.prisma.user.update({
      where: { id },
      data: {
        bannedAt: now,
        bannedReason: (reason ?? '').trim() || null,
        bannedByAdminId: adminId,
      },
    });

    // Revoke all active sessions immediately.
    await this.auth.revokeAllSessionsForUser(updated.id);

    // Best-effort: notify active clients first, then disconnect sockets.
    try {
      this.usersMeRealtime.emitMeUpdatedFromUser(updated, 'account_banned');
    } catch {
      // Best-effort
    }
    try {
      const presenceRealtime = this.moduleRef.get(PresenceRealtimeService, { strict: false });
      presenceRealtime?.disconnectUserSockets(updated.id);
    } catch {
      // Best-effort
    }

    // Invalidate public profile cache (in case they were visible in search, etc).
    try {
      await this.publicProfileCache.invalidateForUser({ id: updated.id, username: updated.username ?? null });
    } catch {
      // Best-effort
    }

    return { data: toUserDto(updated, this.appConfig.r2()?.publicBaseUrl ?? null) };
  }

  @Post(':id/unban')
  async unban(@Param('id') id: string) {
    const existing = await this.prisma.user.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('User not found.');

    const updated = await this.prisma.user.update({
      where: { id },
      data: {
        bannedAt: null,
        bannedReason: null,
        bannedByAdminId: null,
      },
    });

    try {
      await this.publicProfileCache.invalidateForUser({ id: updated.id, username: updated.username ?? null });
    } catch {
      // Best-effort
    }

    // Realtime: refresh their own auth snapshot across devices if they are logged in again later.
    try {
      this.usersMeRealtime.emitMeUpdatedFromUser(updated, 'admin_user_updated');
      await this.usersPublicRealtime.emitPublicProfileUpdated(updated.id);
    } catch {
      // Best-effort
    }

    return { data: toUserDto(updated, this.appConfig.r2()?.publicBaseUrl ?? null) };
  }

  @Get(':id')
  async getUser(@Param('id') id: string) {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundException('User not found.');
    return { data: toUserDto(user, this.appConfig.r2()?.publicBaseUrl ?? null) };
  }

  @Patch(':id/profile')
  async updateUser(@Param('id') id: string, @Body() body: unknown) {
    const parsed = updateUserSchema.parse(body);

    const current = await this.prisma.user.findUnique({
      where: { id },
      select: { id: true, username: true, verifiedStatus: true, premium: true, premiumPlus: true, isOrganization: true },
    });
    if (!current) throw new NotFoundException('User not found.');

    const data: Prisma.UserUpdateInput = {};
    const now = new Date();

    if (parsed.phone !== undefined) {
      try {
        data.phone = normalizePhone(parsed.phone);
      } catch {
        throw new BadRequestException('Invalid phone number format');
      }
    }

    if (parsed.username !== undefined) {
      if (parsed.username === null) {
        data.username = null;
        data.usernameIsSet = false;
      } else {
        const validated = validateUsername(parsed.username, { minLen: 2 });
        if (!validated.ok) throw new BadRequestException(validated.error);
        data.username = validated.username;
        data.usernameIsSet = true;
      }
    }

    if (parsed.name !== undefined) {
      data.name = parsed.name === null ? null : (parsed.name || null);
    }

    if (parsed.bio !== undefined) {
      data.bio = parsed.bio === null ? null : (parsed.bio || null);
    }

    const isSettingPremium = parsed.premium !== undefined || parsed.premiumPlus !== undefined;

    // When setting premium/premiumPlus, enforce verified prerequisite.
    if (isSettingPremium) {
      const verifiedNow =
        parsed.verifiedStatus !== undefined ? parsed.verifiedStatus !== 'none' : current.verifiedStatus !== 'none';

      const wantsPremium = parsed.premium === true || parsed.premiumPlus === true;
      if (wantsPremium && !verifiedNow) {
        throw new BadRequestException('User must be verified before enabling Premium or Premium+.');
      }
    }

    if (parsed.premium !== undefined) {
      data.premium = parsed.premium;
    }

    if (parsed.premiumPlus !== undefined) {
      data.premiumPlus = parsed.premiumPlus;
    }

    // Enforce invariants:
    // - premiumPlus implies premium
    // - disabling premium disables premiumPlus
    if (data.premiumPlus === true) data.premium = true;
    if (data.premium === false) data.premiumPlus = false;

    // Compute effective next-state values (current + patch), so admins can update multiple fields atomically.
    const effectiveVerifiedStatus = parsed.verifiedStatus ?? current.verifiedStatus;
    let effectivePremium = parsed.premium ?? current.premium;
    const effectivePremiumPlus = parsed.premiumPlus ?? current.premiumPlus;
    if (effectivePremiumPlus === true) effectivePremium = true;
    // Enforce "premium=false disables premiumPlus" invariant for effective state.
    if (parsed.premium === false && parsed.premiumPlus !== true) effectivePremium = false;

    const effectiveIsOrganization = parsed.isOrganization ?? current.isOrganization;
    if (effectiveIsOrganization === true && (effectivePremium !== true || effectiveVerifiedStatus === 'none')) {
      throw new BadRequestException('Organization accounts must be verified and premium.');
    }

    if (parsed.isOrganization !== undefined) {
      data.isOrganization = parsed.isOrganization;
    }

    if (parsed.verifiedStatus !== undefined) {
      if (parsed.verifiedStatus === 'none') {
        data.verifiedStatus = 'none';
        data.verifiedAt = null;
        data.unverifiedAt = now;
      } else {
        data.verifiedStatus = parsed.verifiedStatus;
        data.verifiedAt = now;
        data.unverifiedAt = null;
      }
    }

    try {
      const updated = await this.prisma.user.update({
        where: { id },
        data,
      });

      // Invalidate public profile caches (profile + preview) so tier changes reflect immediately.
      try {
        await this.publicProfileCache.invalidateForUser({ id: current.id, username: current.username ?? null });
        await this.publicProfileCache.invalidateForUser({ id: updated.id, username: updated.username ?? null });
      } catch {
        // Best-effort cache invalidation; never fail admin updates.
      }

      // Realtime: user tier/profile changes should update their own UI and any related users.
      try {
        await this.usersPublicRealtime.emitPublicProfileUpdated(updated.id);
        // Also update the user across their own devices (auth/settings state).
        this.usersMeRealtime.emitMeUpdatedFromUser(updated, 'admin_user_updated');
      } catch {
        // Best-effort
      }

      return { data: toUserDto(updated, this.appConfig.r2()?.publicBaseUrl ?? null) };
    } catch (err: unknown) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
        throw new NotFoundException('User not found.');
      }
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        // Unique constraint violation (phone or username lower-ci index).
        throw new ConflictException('That value is already in use.');
      }
      throw err;
    }
  }

  @Post(':id/email/unverify')
  async unverifyEmail(@Param('id') id: string) {
    const now = new Date();
    const publicBaseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;

    const existing = await this.prisma.user.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('User not found.');

    const updated = await this.prisma.$transaction(async (tx) => {
      const u = await tx.user.update({
        where: { id },
        data: {
          emailVerifiedAt: null,
          emailVerificationRequestedAt: null,
        },
      });

      // Invalidate any outstanding verification links (best-effort).
      await tx.emailActionToken.updateMany({
        where: { userId: id, purpose: 'verifyEmail', consumedAt: null },
        data: { consumedAt: now },
      });

      return u;
    });

    this.usersMeRealtime.emitMeUpdatedFromUser(updated, 'email_unverified');
    return { data: toUserDto(updated, publicBaseUrl) };
  }
}

