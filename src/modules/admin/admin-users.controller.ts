import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
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
import { toUserDto, type OrgAffiliationDto } from '../../common/dto';
import { publicAssetUrl } from '../../common/assets/public-asset-url';
import { PrismaService } from '../prisma/prisma.service';
import { validateUsername } from '../users/users.utils';
import { PublicProfileCacheService } from '../users/public-profile-cache.service';
import { AdminGuard, type AdminRequest } from './admin.guard';
import { UsersMeRealtimeService } from '../users/users-me-realtime.service';
import { UsersPublicRealtimeService } from '../users/users-public-realtime.service';
import { AuthService } from '../auth/auth.service';
import { PresenceRealtimeService } from '../presence/presence-realtime.service';
import { SlackService } from '../../common/slack/slack.service';
import { EntitlementService } from '../billing/entitlement.service';
import { BillingService } from '../billing/billing.service';
import { APP_FEATURE_TOGGLES, sanitizeFeatureToggles } from '../../common/feature-toggles';

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
  isOrganization: z.boolean().optional(),
  verifiedStatus: z.enum(['none', 'identity', 'manual']).optional(),
  featureToggles: z.array(z.enum(APP_FEATURE_TOGGLES)).max(50).optional(),
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
    private readonly slack: SlackService,
    private readonly entitlementService: EntitlementService,
    private readonly billingService: BillingService,
  ) {}

  /** Single-user admin DTO with org affiliations included. */
  private async toAdminUserDto(user: Parameters<typeof toUserDto>[0], publicBaseUrl: string | null) {
    const orgMap = await this.batchOrgAffiliations([user.id]);
    return { ...toUserDto(user, publicBaseUrl), orgAffiliations: orgMap.get(user.id) ?? [] };
  }

  /** Batch-fetch org affiliations. Returns map of userId → OrgAffiliationDto[]. */
  private async batchOrgAffiliations(userIds: string[]): Promise<Map<string, OrgAffiliationDto[]>> {
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
    for (const m of memberships) {
      const list = map.get(m.userId) ?? [];
      list.push({
        id: m.org.id,
        username: m.org.username,
        name: m.org.name,
        avatarUrl: publicAssetUrl({ publicBaseUrl, key: m.org.avatarKey ?? null, updatedAt: m.org.avatarUpdatedAt ?? null }),
      });
      map.set(m.userId, list);
    }
    return map;
  }

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
      orderBy: [{ bannedAt: 'desc' }, { id: 'desc' }],
      take: take + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });

    const slice = users.slice(0, take);
    const nextCursor = users.length > take ? slice[slice.length - 1]?.id ?? null : null;
    const publicBaseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;
    const orgMap = await this.batchOrgAffiliations(slice.map((u) => u.id));

    return {
      data: slice.map((u) => ({ ...toUserDto(u, publicBaseUrl), orgAffiliations: orgMap.get(u.id) ?? [] })),
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
    const orgMap = await this.batchOrgAffiliations(slice.map((u) => u.id));

    return {
      data: slice.map((u) => ({ ...toUserDto(u, publicBaseUrl), orgAffiliations: orgMap.get(u.id) ?? [] })),
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

    return { data: await this.toAdminUserDto(updated, this.appConfig.r2()?.publicBaseUrl ?? null) };
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

    return { data: await this.toAdminUserDto(updated, this.appConfig.r2()?.publicBaseUrl ?? null) };
  }

  @Get(':id')
  async getUser(@Param('id') id: string) {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundException('User not found.');
    return { data: await this.toAdminUserDto(user, this.appConfig.r2()?.publicBaseUrl ?? null) };
  }

  @Patch(':id/profile')
  async updateUser(@Param('id') id: string, @Body() body: unknown) {
    const parsed = updateUserSchema.parse(body);

    const current = await this.prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        username: true,
        verifiedStatus: true,
        unverifiedAt: true,
        premium: true,
        premiumPlus: true,
        isOrganization: true,
      },
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

    // Org invariant: org accounts must be verified AND have at least some form of premium access.
    // current.premium reflects all sources (Stripe + grants) as computed by EntitlementService.
    const effectiveVerifiedStatus = parsed.verifiedStatus ?? current.verifiedStatus;
    const effectiveIsOrganization = parsed.isOrganization ?? current.isOrganization;
    if (effectiveIsOrganization === true && (!current.premium || effectiveVerifiedStatus === 'none')) {
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

    if (parsed.featureToggles !== undefined) {
      data.featureToggles = sanitizeFeatureToggles(parsed.featureToggles);
    }

    try {
      await this.prisma.user.update({ where: { id }, data });

      // Run verification lifecycle hooks when verifiedStatus changes.
      if (parsed.verifiedStatus !== undefined) {
        const wasVerified = current.verifiedStatus !== 'none';
        const nowVerified = parsed.verifiedStatus !== 'none';
        if (!wasVerified && nowVerified) {
          // Re-verifying: restore banked grant time, resume Stripe sub, recompute tier.
          await this.billingService.onUserVerified(id, current.unverifiedAt);
        } else if (wasVerified && !nowVerified) {
          // Unverifying: pause Stripe sub, recompute tier (strips premium access).
          await this.billingService.onUserUnverified(id);
        } else {
          // Same verified/unverified category (e.g. identity → manual): just recompute.
          await this.entitlementService.recomputeAndApply(id);
        }
      }

      // Fetch the fresh user after all writes so the response reflects the computed state.
      const updated = await this.prisma.user.findUnique({ where: { id } });
      if (!updated) throw new NotFoundException('User not found.');

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
        this.usersMeRealtime.emitMeUpdatedFromUser(updated, 'admin_user_updated');
      } catch {
        // Best-effort
      }

      if (!current.premium && (updated.premium || updated.premiumPlus)) {
        this.slack.notifyPremiumGranted({
          userId: updated.id,
          username: updated.username ?? null,
          name: updated.name ?? null,
          tier: updated.premiumPlus ? 'premiumPlus' : 'premium',
          source: 'admin',
        });
      }

      return { data: await this.toAdminUserDto(updated, this.appConfig.r2()?.publicBaseUrl ?? null) };
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

  @Get(':id/orgs')
  async listOrgMemberships(@Param('id') id: string) {
    const user = await this.prisma.user.findUnique({ where: { id }, select: { id: true } });
    if (!user) throw new NotFoundException('User not found.');

    const memberships = await this.prisma.userOrgMembership.findMany({
      where: { userId: id },
      include: {
        org: {
          select: { id: true, username: true, name: true, avatarKey: true, avatarUpdatedAt: true },
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    const publicBaseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;
    const data: OrgAffiliationDto[] = memberships.map((m) => ({
      id: m.org.id,
      username: m.org.username,
      name: m.org.name,
      avatarUrl: publicAssetUrl({ publicBaseUrl, key: m.org.avatarKey ?? null, updatedAt: m.org.avatarUpdatedAt ?? null }),
    }));

    return { data };
  }

  @Post(':id/orgs')
  async addOrgMembership(@Param('id') id: string, @Body() body: unknown) {
    const { orgId } = z.object({ orgId: z.string().min(1) }).parse(body);

    const [user, org] = await Promise.all([
      this.prisma.user.findUnique({ where: { id }, select: { id: true, isOrganization: true } }),
      this.prisma.user.findUnique({ where: { id: orgId }, select: { id: true, isOrganization: true } }),
    ]);

    if (!user) throw new NotFoundException('User not found.');
    if (!org) throw new NotFoundException('Org user not found.');
    if (!org.isOrganization) throw new BadRequestException('Target account is not an organization.');
    if (user.isOrganization) throw new BadRequestException('Organization accounts cannot be members of other orgs.');
    if (user.id === org.id) throw new BadRequestException('A user cannot be affiliated with themselves.');

    try {
      await this.prisma.userOrgMembership.create({ data: { userId: id, orgId } });
    } catch (err: unknown) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException('Membership already exists.');
      }
      throw err;
    }

    const publicBaseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;
    const orgFull = await this.prisma.user.findUniqueOrThrow({
      where: { id: orgId },
      select: { id: true, username: true, name: true, avatarKey: true, avatarUpdatedAt: true },
    });

    const data: OrgAffiliationDto = {
      id: orgFull.id,
      username: orgFull.username,
      name: orgFull.name,
      avatarUrl: publicAssetUrl({ publicBaseUrl, key: orgFull.avatarKey ?? null, updatedAt: orgFull.avatarUpdatedAt ?? null }),
    };

    return { data };
  }

  @Delete(':id/orgs/:orgId')
  async removeOrgMembership(@Param('id') id: string, @Param('orgId') orgId: string) {
    const deleted = await this.prisma.userOrgMembership.deleteMany({
      where: { userId: id, orgId },
    });

    if (deleted.count === 0) throw new NotFoundException('Membership not found.');

    return { data: { success: true } };
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
    return { data: await this.toAdminUserDto(updated, publicBaseUrl) };
  }
}

