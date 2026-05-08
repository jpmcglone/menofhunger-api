import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import type { MarvinMode } from '@prisma/client';
import { AuthGuard } from '../auth/auth.guard';
import { AdminGuard, type AdminRequest } from '../admin/admin.guard';
import { CurrentUserId } from '../users/users.decorator';
import { AppConfigService } from '../app/app-config.service';
import { PrismaService } from '../prisma/prisma.service';
import type {
  MarvinCreditSummaryDto,
  MarvinMeDto,
  MarvinModeDto,
  MarvinUsageEventDto,
} from '../../common/dto/marvin';
import { MarvinCreditService, type MarvCreditSummary } from './services/marvin-credit.service';
import { MarvinBotIdentityService } from './services/marvin-bot-identity.service';
import { MarvinAdminService } from './services/marvin-admin.service';
import { publicAssetUrl } from '../../common/assets/public-asset-url';

const updatePreferencesSchema = z.object({
  preferredMode: z.enum(['auto', 'fast', 'regular', 'smart']).optional(),
});

const adminUsersQuerySchema = z.object({
  q: z.string().trim().max(80).optional(),
  cursor: z.string().trim().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});

const myUsageQuerySchema = z.object({
  cursor: z.string().trim().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});

const adminUsageQuerySchema = z.object({
  userId: z.string().trim().max(64).optional(),
  source: z.enum(['public_thread', 'private_session']).optional(),
  cursor: z.string().trim().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

const adminUserPatchSchema = z.object({
  credits: z.number().min(0).max(1_000_000).optional(),
  disabled: z.boolean().optional(),
});

const adminCostQuerySchema = z.object({
  sinceDays: z.coerce.number().int().min(1).max(90).optional(),
});

const adminConfigPatchSchema = z.object({
  enabled: z.boolean().optional(),
  fastCost: z.union([z.number().min(0), z.null()]).optional(),
  regularCost: z.union([z.number().min(0), z.null()]).optional(),
  smartCost: z.union([z.number().min(0), z.null()]).optional(),
  fastModel: z.union([z.string().trim().min(1).max(80), z.null()]).optional(),
  regularModel: z.union([z.string().trim().min(1).max(80), z.null()]).optional(),
  smartModel: z.union([z.string().trim().min(1).max(80), z.null()]).optional(),
});

/**
 * User-facing + admin endpoints for Marv.
 *
 * Per the project rule, admin-only endpoints live under `/admin/marvin/*` and are gated
 * by `AdminGuard` which throws **404** for non-admins (never 401/403). The user-facing
 * endpoints under `/marvin/me*` are auth-only.
 */
@Controller()
export class MarvinController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly appConfig: AppConfigService,
    private readonly credits: MarvinCreditService,
    private readonly identity: MarvinBotIdentityService,
    private readonly admin: MarvinAdminService,
  ) {}

  @UseGuards(AuthGuard)
  @Get('marvin/me')
  async getMe(@CurrentUserId() userId: string): Promise<{ data: MarvinMeDto }> {
    return { data: await this.buildMe(userId) };
  }

  @UseGuards(AuthGuard)
  @Patch('marvin/me/preferences')
  async patchPreferences(
    @CurrentUserId() userId: string,
    @Body() body: unknown,
  ): Promise<{ data: MarvinMeDto }> {
    const parsed = updatePreferencesSchema.parse(body ?? {});
    if (parsed.preferredMode !== undefined) {
      await this.prisma.marvinUserSettings.upsert({
        where: { userId },
        update: { preferredMode: parsed.preferredMode as MarvinMode },
        create: { userId, preferredMode: parsed.preferredMode as MarvinMode },
      });
    }
    return { data: await this.buildMe(userId) };
  }

  /**
   * Returns the viewer's recent Marv interactions (most recent first). Powers the
   * "Recent activity" list in `/settings/marv`. Self-scoped only — admins use the
   * admin-gated `GET /admin/marvin/usage` for the global stream.
   */
  @UseGuards(AuthGuard)
  @Get('marvin/me/usage')
  async getMyUsage(
    @CurrentUserId() userId: string,
    @Query() query: unknown,
  ): Promise<{
    data: MarvinUsageEventDto[];
    pagination: { nextCursor: string | null };
  }> {
    const parsed = myUsageQuerySchema.parse(query ?? {});
    const result = await this.admin.listUsageEvents({
      take: parsed.limit,
      cursorEventId: parsed.cursor ?? null,
      userId,
      source: null,
    });
    return {
      data: result.rows.map(usageRowToDto),
      pagination: { nextCursor: result.nextCursor },
    };
  }

  // ─── Admin ─────────────────────────────────────────────────────────────────

  @UseGuards(AdminGuard)
  @Get('admin/marvin/config')
  async adminGetConfig() {
    const settings = await this.admin.getGlobalSettings();
    return {
      data: {
        ...settings,
        updatedAt: settings.updatedAt.toISOString(),
      },
    };
  }

  @UseGuards(AdminGuard)
  @Patch('admin/marvin/config')
  async adminPatchConfig(@Body() body: unknown, @Req() req: AdminRequest) {
    const parsed = adminConfigPatchSchema.parse(body ?? {});
    const adminUserId = req.user?.id ?? '';
    const settings = await this.admin.updateGlobalSettings({
      actingAdminUserId: adminUserId,
      ...parsed,
    });
    return {
      data: {
        ...settings,
        updatedAt: settings.updatedAt.toISOString(),
      },
    };
  }

  @UseGuards(AdminGuard)
  @Get('admin/marvin/users')
  async adminListUsers(@Query() query: unknown) {
    const parsed = adminUsersQuerySchema.parse(query ?? {});
    const result = await this.admin.listUsers({
      take: parsed.limit,
      cursorUserId: parsed.cursor ?? null,
      q: parsed.q ?? null,
    });
    return {
      data: result.rows.map((r) => ({
        ...r,
        creditsLastRefilledAt: r.creditsLastRefilledAt
          ? r.creditsLastRefilledAt.toISOString()
          : null,
      })),
      pagination: { nextCursor: result.nextCursor },
    };
  }

  @UseGuards(AdminGuard)
  @Patch('admin/marvin/users/:userId')
  async adminPatchUser(
    @Param('userId') targetUserId: string,
    @Body() body: unknown,
    @Req() req: AdminRequest,
  ) {
    const parsed = adminUserPatchSchema.parse(body ?? {});
    const adminUserId = req.user?.id ?? '';
    const out: { credits?: MarvinCreditSummaryDto; disabledByAdmin?: boolean } = {};
    if (typeof parsed.credits === 'number') {
      const summary = await this.admin.setUserCredits({
        actingAdminUserId: adminUserId,
        targetUserId,
        credits: parsed.credits,
      });
      out.credits = creditSummaryToDto(summary);
    }
    if (typeof parsed.disabled === 'boolean') {
      const r = await this.admin.setUserDisabled({
        actingAdminUserId: adminUserId,
        targetUserId,
        disabled: parsed.disabled,
      });
      out.disabledByAdmin = r.disabledByAdmin;
    }
    return { data: out };
  }

  @UseGuards(AdminGuard)
  @Get('admin/marvin/users/:userId/context-card')
  async adminGetContextCard(@Param('userId') userId: string) {
    const card = await this.admin.getContextCard(userId);
    return {
      data: {
        cardText: card.cardText,
        source: card.source,
        updatedAt: card.updatedAt ? card.updatedAt.toISOString() : null,
      },
    };
  }

  @UseGuards(AdminGuard)
  @Post('admin/marvin/users/:userId/context-card/regenerate')
  async adminRegenerateContextCard(
    @Param('userId') targetUserId: string,
    @Req() req: AdminRequest,
  ) {
    const adminUserId = req.user?.id ?? '';
    const result = await this.admin.regenerateContextCard({
      actingAdminUserId: adminUserId,
      targetUserId,
    });
    return { data: result };
  }

  @UseGuards(AdminGuard)
  @Get('admin/marvin/cost')
  async adminGetCost(@Query() query: unknown) {
    const parsed = adminCostQuerySchema.parse(query ?? {});
    const rows = await this.admin.listDailyCostRollups({ sinceDays: parsed.sinceDays });
    return { data: rows };
  }

  @UseGuards(AdminGuard)
  @Get('admin/marvin/usage')
  async adminListUsage(@Query() query: unknown): Promise<{
    data: MarvinUsageEventDto[];
    pagination: { nextCursor: string | null };
  }> {
    const parsed = adminUsageQuerySchema.parse(query ?? {});
    const result = await this.admin.listUsageEvents({
      take: parsed.limit,
      cursorEventId: parsed.cursor ?? null,
      userId: parsed.userId ?? null,
      source: parsed.source ?? null,
    });
    return {
      data: result.rows.map(usageRowToDto),
      pagination: { nextCursor: result.nextCursor },
    };
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  private async buildMe(userId: string): Promise<MarvinMeDto> {
    const cfg = this.appConfig.marvBot();
    const [viewer, settings, summary] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: userId },
        select: { premium: true, premiumPlus: true },
      }),
      this.prisma.marvinUserSettings.findUnique({
        where: { userId },
        select: { preferredMode: true, disabledByAdmin: true },
      }),
      this.credits.getSummary(userId),
    ]);

    const isPremium = Boolean(viewer?.premium || viewer?.premiumPlus);
    const disabled = settings?.disabledByAdmin ?? false;
    const marvUserId = await this.identity.getMarvUserId();

    let marvAvatarUrl: string | null = null;
    if (marvUserId) {
      const marvRow = await this.prisma.user.findUnique({
        where: { id: marvUserId },
        select: { avatarKey: true, avatarUpdatedAt: true },
      });
      marvAvatarUrl = publicAssetUrl({
        publicBaseUrl: this.appConfig.r2()?.publicBaseUrl ?? null,
        key: marvRow?.avatarKey ?? null,
        updatedAt: marvRow?.avatarUpdatedAt ?? null,
      });
    }

    return {
      enabled: cfg.enabled && !disabled,
      isPremium,
      preferredMode: (settings?.preferredMode ?? 'auto') as MarvinModeDto,
      credits: creditSummaryToDto(summary),
      marv: marvUserId
        ? {
            userId: marvUserId,
            username: cfg.username,
            displayName: cfg.displayName,
            avatarUrl: marvAvatarUrl,
          }
        : null,
    };
  }
}

function creditSummaryToDto(summary: MarvCreditSummary): MarvinCreditSummaryDto {
  return {
    credits: summary.credits,
    maxCredits: summary.maxCredits,
    creditsPerDay: summary.creditsPerDay,
    lastRefilledAt: summary.lastRefilledAt.toISOString(),
  };
}

type UsageRow = Awaited<
  ReturnType<MarvinAdminService['listUsageEvents']>
>['rows'][number];

function usageRowToDto(r: UsageRow): MarvinUsageEventDto {
  return {
    id: r.id,
    userId: r.userId,
    source: r.source,
    sourceId: r.sourceId,
    rootPostId: r.rootPostId,
    requestedMode: r.requestedMode as MarvinModeDto,
    effectiveMode: r.effectiveMode as MarvinModeDto,
    creditsSpent: r.creditsSpent,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    cachedInputTokens: r.cachedInputTokens,
    modelUsed: r.modelUsed,
    estimatedCostUsd: r.estimatedCostUsd === null ? null : Number(r.estimatedCostUsd),
    responseId: r.responseId,
    routingReason: r.routingReason,
    errorCode: r.errorCode,
    latencyMs: r.latencyMs,
    createdAt: r.createdAt.toISOString(),
  };
}
