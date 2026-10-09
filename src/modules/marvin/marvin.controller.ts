import { adminUserPatchSchema } from './marvin-admin.schemas';
import { Body, Controller, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth-public-api';
import { type AdminRequest } from '../admin/admin.guard';
import { AdminGuard } from '../admin/admin.guard';
import { CurrentUserId } from '../users/users.decorator';
import type { MarvinCatchUpDto, MarvinContextCardDto, MarvinCreditSummaryDto, MarvinMeDto, MarvinModeDto, MarvinUsageEventDto } from '../../common/dto/marvin';
import { MarvinMeService, creditSummaryToDto } from './services/marvin-me.service';
import { MarvinAdminService } from './services/marvin-admin.service';
import { MarvinCatchUpService } from './services/marvin-catch-up.service';
import {
  updatePreferencesSchema,
  catchUpBodySchema,
  adminUsersQuerySchema,
  myUsageQuerySchema,
  adminUsageQuerySchema,
  adminCostQuerySchema,
  adminConfigPatchSchema,
} from './marvin.schemas';

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
    private readonly me: MarvinMeService,
    private readonly admin: MarvinAdminService,
    private readonly catchUpService: MarvinCatchUpService,
  ) {}

  @UseGuards(AuthGuard)
  @Get('marvin/me')
  async getMe(@CurrentUserId() userId: string): Promise<{ data: MarvinMeDto }> {
    return { data: await this.me.buildMe(userId) };
  }

  @UseGuards(AuthGuard)
  @Patch('marvin/me/preferences')
  async patchPreferences(
    @CurrentUserId() userId: string,
    @Body() body: unknown,
  ): Promise<{ data: MarvinMeDto }> {
    const parsed = updatePreferencesSchema.parse(body ?? {});
    await this.me.updatePreferences(userId, parsed);
    return { data: await this.me.buildMe(userId) };
  }

  /**
   * What Marv currently knows about the viewer (public profile + public posts card).
   * Read-only transparency — does not generate a card on miss.
   */
  @UseGuards(AuthGuard)
  @Get('marvin/me/context-card')
  async getMyContextCard(
    @CurrentUserId() userId: string,
  ): Promise<{ data: MarvinContextCardDto | null }> {
    return { data: await this.me.getContextCard(userId) };
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

  /**
   * "Catch me up" — summarize the conversation above AND below a post. Premium-only,
   * mode-routed, spends credits (cache hits are free). Visibility is enforced through
   * `PostsFeedLookupService.getById`, so gated/private posts return the same 403/404 as the
   * permalink endpoint.
   */
  @UseGuards(AuthGuard)
  @Post('marvin/catch-up/:postId')
  async catchUp(
    @CurrentUserId() userId: string,
    @Param('postId') postId: string,
    @Body() body: unknown,
  ): Promise<{ data: MarvinCatchUpDto | null }> {
    const parsed = catchUpBodySchema.parse(body ?? {});
    // Peek: return the free cached summary if present, else null. No AI call, no credits.
    if (parsed.cacheOnly) {
      const data = await this.catchUpService.peekCached({
        userId,
        postId,
        requestedMode: parsed.mode ?? null,
        includeImages: parsed.includeImages ?? true,
      });
      return { data };
    }
    const data = await this.catchUpService.catchUp({
      userId,
      postId,
      requestedMode: parsed.mode ?? null,
      forceRefresh: parsed.refresh ?? false,
      includeImages: parsed.includeImages ?? true,
    });
    return { data };
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
    reasoningTokens: r.reasoningTokens,
    modelUsed: r.modelUsed,
    estimatedCostUsd: r.estimatedCostUsd === null ? null : Number(r.estimatedCostUsd),
    responseId: r.responseId,
    routingReason: r.routingReason,
    errorCode: r.errorCode,
    latencyMs: r.latencyMs,
    createdAt: r.createdAt.toISOString(),
  };
}
