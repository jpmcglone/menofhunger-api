import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { MarvinMode, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { MarvinCreditService, type MarvCreditSummary } from './marvin-credit.service';
import { MarvinContextCardService } from './marvin-context-card.service';

export type MarvDailyCostRow = {
  dayKey: string;
  totalRequests: number;
  totalCreditsSpent: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
};

const GLOBAL_SETTINGS_ID = 1;

export type MarvGlobalSettings = {
  enabled: boolean;
  fastCost: number | null;
  regularCost: number | null;
  smartCost: number | null;
  fastModel: string | null;
  regularModel: string | null;
  smartModel: string | null;
  updatedAt: Date;
};

export type MarvAdminUserRow = {
  userId: string;
  username: string | null;
  displayName: string | null;
  premium: boolean;
  premiumPlus: boolean;
  isBot: boolean;
  credits: number;
  creditsLastRefilledAt: Date | null;
  preferredMode: MarvinMode;
  disabledByAdmin: boolean;
  totalCreditsSpent30d: number;
  totalEvents30d: number;
};

/**
 * Admin-only operations for Marv: global toggle, per-user credit/disable controls, and
 * usage queries that back the admin dashboard. All mutations log a structured line so we
 * have a tamper-evident trail for auditing.
 */
@Injectable()
export class MarvinAdminService {
  private readonly logger = new Logger(MarvinAdminService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly credits: MarvinCreditService,
    private readonly contextCards: MarvinContextCardService,
  ) {}

  async getGlobalSettings(): Promise<MarvGlobalSettings> {
    const row = await this.prisma.marvinGlobalSettings.upsert({
      where: { id: GLOBAL_SETTINGS_ID },
      update: {},
      create: { id: GLOBAL_SETTINGS_ID },
      select: {
        enabled: true,
        fastCost: true,
        regularCost: true,
        smartCost: true,
        fastModel: true,
        regularModel: true,
        smartModel: true,
        updatedAt: true,
      },
    });
    return row;
  }

  async updateGlobalSettings(args: {
    actingAdminUserId: string;
    enabled?: boolean;
    fastCost?: number | null;
    regularCost?: number | null;
    smartCost?: number | null;
    fastModel?: string | null;
    regularModel?: string | null;
    smartModel?: string | null;
  }): Promise<MarvGlobalSettings> {
    const data: Prisma.MarvinGlobalSettingsUpdateInput = {};
    if (typeof args.enabled === 'boolean') data.enabled = args.enabled;
    if (args.fastCost !== undefined) data.fastCost = args.fastCost;
    if (args.regularCost !== undefined) data.regularCost = args.regularCost;
    if (args.smartCost !== undefined) data.smartCost = args.smartCost;
    if (args.fastModel !== undefined) data.fastModel = args.fastModel;
    if (args.regularModel !== undefined) data.regularModel = args.regularModel;
    if (args.smartModel !== undefined) data.smartModel = args.smartModel;

    const updated = await this.prisma.marvinGlobalSettings.upsert({
      where: { id: GLOBAL_SETTINGS_ID },
      update: data,
      create: {
        id: GLOBAL_SETTINGS_ID,
        enabled: args.enabled ?? true,
        fastCost: args.fastCost ?? null,
        regularCost: args.regularCost ?? null,
        smartCost: args.smartCost ?? null,
        fastModel: args.fastModel ?? null,
        regularModel: args.regularModel ?? null,
        smartModel: args.smartModel ?? null,
      },
      select: {
        enabled: true,
        fastCost: true,
        regularCost: true,
        smartCost: true,
        fastModel: true,
        regularModel: true,
        smartModel: true,
        updatedAt: true,
      },
    });
    this.logger.log(
      `[marv] admin updated global settings (admin=${args.actingAdminUserId}) enabled=${updated.enabled}`,
    );
    return updated;
  }

  async listUsers(args: {
    take?: number;
    cursorUserId?: string | null;
    /** Filter by username substring (case-insensitive) when provided. */
    q?: string | null;
  }): Promise<{ rows: MarvAdminUserRow[]; nextCursor: string | null }> {
    const take = Math.min(50, Math.max(1, args.take ?? 25));
    const since30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const filters: Prisma.UserWhereInput[] = [];
    const q = (args.q ?? '').trim();
    if (q) {
      filters.push({
        OR: [
          { username: { contains: q, mode: 'insensitive' } },
          { name: { contains: q, mode: 'insensitive' } },
        ],
      });
    }
    // Show users who have either a credit balance OR a usage event (i.e., have interacted with Marv).
    filters.push({
      OR: [{ marvinCreditBalance: { isNot: null } }, { marvinUsageEvents: { some: {} } }],
    });
    const where: Prisma.UserWhereInput = filters.length > 1 ? { AND: filters } : filters[0]!;

    const users = await this.prisma.user.findMany({
      where,
      take: take + 1,
      ...(args.cursorUserId ? { cursor: { id: args.cursorUserId }, skip: 1 } : {}),
      orderBy: { id: 'asc' },
      select: {
        id: true,
        username: true,
        name: true,
        premium: true,
        premiumPlus: true,
        isBot: true,
        marvinCreditBalance: { select: { credits: true, lastRefilledAt: true } },
        marvinUserSettings: { select: { preferredMode: true, disabledByAdmin: true } },
      },
    });
    const hasMore = users.length > take;
    const trimmed = hasMore ? users.slice(0, take) : users;

    const userIds = trimmed.map((u) => u.id);
    const aggregates = userIds.length
      ? await this.prisma.marvinUsageEvent.groupBy({
          by: ['userId'],
          where: { userId: { in: userIds }, createdAt: { gte: since30d } },
          _sum: { creditsSpent: true },
          _count: { _all: true },
        })
      : [];
    const aggByUser = new Map(aggregates.map((a) => [a.userId, a]));

    const rows: MarvAdminUserRow[] = trimmed.map((u) => {
      const agg = aggByUser.get(u.id);
      return {
        userId: u.id,
        username: u.username,
        displayName: u.name,
        premium: u.premium,
        premiumPlus: u.premiumPlus,
        isBot: u.isBot,
        credits: u.marvinCreditBalance?.credits ?? 0,
        creditsLastRefilledAt: u.marvinCreditBalance?.lastRefilledAt ?? null,
        preferredMode: u.marvinUserSettings?.preferredMode ?? 'regular',
        disabledByAdmin: u.marvinUserSettings?.disabledByAdmin ?? false,
        totalCreditsSpent30d: agg?._sum.creditsSpent ?? 0,
        totalEvents30d: agg?._count._all ?? 0,
      };
    });
    return { rows, nextCursor: hasMore ? trimmed[trimmed.length - 1]!.id : null };
  }

  async setUserCredits(args: {
    actingAdminUserId: string;
    targetUserId: string;
    credits: number;
  }): Promise<MarvCreditSummary> {
    const summary = await this.credits.setCredits(args.targetUserId, args.credits);
    this.logger.log(
      `[marv] admin set credits user=${args.targetUserId} -> ${summary.credits} (admin=${args.actingAdminUserId})`,
    );
    return summary;
  }

  async setUserDisabled(args: {
    actingAdminUserId: string;
    targetUserId: string;
    disabled: boolean;
  }): Promise<{ disabledByAdmin: boolean }> {
    const target = await this.prisma.user.findUnique({
      where: { id: args.targetUserId },
      select: { id: true },
    });
    if (!target) throw new NotFoundException('User not found.');
    const updated = await this.prisma.marvinUserSettings.upsert({
      where: { userId: args.targetUserId },
      update: { disabledByAdmin: args.disabled },
      create: { userId: args.targetUserId, disabledByAdmin: args.disabled },
      select: { disabledByAdmin: true },
    });
    this.logger.log(
      `[marv] admin set disabled user=${args.targetUserId} -> ${updated.disabledByAdmin} (admin=${args.actingAdminUserId})`,
    );
    return updated;
  }

  async listUsageEvents(args: {
    take?: number;
    cursorEventId?: string | null;
    userId?: string | null;
    source?: 'public_thread' | 'private_session' | 'catch_up' | null;
  }): Promise<{ rows: Array<Prisma.MarvinUsageEventGetPayload<object>>; nextCursor: string | null }> {
    const take = Math.min(100, Math.max(1, args.take ?? 50));
    const where: Prisma.MarvinUsageEventWhereInput = {};
    if (args.userId) where.userId = args.userId;
    if (args.source) where.source = args.source;

    const rows = await this.prisma.marvinUsageEvent.findMany({
      where,
      take: take + 1,
      ...(args.cursorEventId ? { cursor: { id: args.cursorEventId }, skip: 1 } : {}),
      orderBy: { createdAt: 'desc' },
    });
    const hasMore = rows.length > take;
    const trimmed = hasMore ? rows.slice(0, take) : rows;
    return { rows: trimmed, nextCursor: hasMore ? trimmed[trimmed.length - 1]!.id : null };
  }

  /**
   * Force-refresh a user's context card. Returns the new card text or `null`
   * if the user is a bot (cards aren't generated for bot accounts).
   */
  async regenerateContextCard(args: {
    actingAdminUserId: string;
    targetUserId: string;
  }): Promise<{ cardText: string | null }> {
    const target = await this.prisma.user.findUnique({
      where: { id: args.targetUserId },
      select: { id: true },
    });
    if (!target) throw new NotFoundException('User not found.');
    const cardText = await this.contextCards.refreshCardForUser(args.targetUserId);
    this.logger.log(
      `[marv] admin regenerated context card user=${args.targetUserId} (admin=${args.actingAdminUserId}) ${cardText ? 'ok' : 'skipped'}`,
    );
    return { cardText };
  }

  /**
   * Read the per-user context card directly (admin-only). Useful for the
   * regenerate dialog where the admin wants to see what changed.
   */
  async getContextCard(targetUserId: string): Promise<{
    cardText: string | null;
    source: string | null;
    updatedAt: Date | null;
  }> {
    const row = await this.prisma.userContextCard.findUnique({
      where: { userId: targetUserId },
      select: { cardText: true, source: true, updatedAt: true },
    });
    if (!row) return { cardText: null, source: null, updatedAt: null };
    return row;
  }

  /**
   * Aggregates daily totals across all users for the admin dashboard chart.
   *
   * Historical days come from the pre-aggregated `MarvinCostRollup` table (written
   * by the nightly cron). Today's data is always live-queried from `MarvinUsageEvent`
   * so the chart reflects the current day without waiting for the next cron run.
   */
  async listDailyCostRollups(args: { sinceDays?: number } = {}): Promise<MarvDailyCostRow[]> {
    const days = Math.min(90, Math.max(1, args.sinceDays ?? 30));
    const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;
    const cutoffKey = toDayKey(new Date(cutoffMs));
    const todayKey = toDayKey(new Date());

    // Historical rollups (nightly cron covers previous days, never today).
    const grouped = await this.prisma.marvinCostRollup.groupBy({
      by: ['dayKey'],
      where: { dayKey: { gte: cutoffKey } },
      _sum: {
        totalRequests: true,
        totalCreditsSpent: true,
        totalInputTokens: true,
        totalOutputTokens: true,
        totalCostUsd: true,
      },
      orderBy: { dayKey: 'asc' },
    });
    const rows: MarvDailyCostRow[] = grouped.map((g) => ({
      dayKey: g.dayKey,
      totalRequests: g._sum.totalRequests ?? 0,
      totalCreditsSpent: g._sum.totalCreditsSpent ?? 0,
      totalInputTokens: g._sum.totalInputTokens ?? 0,
      totalOutputTokens: g._sum.totalOutputTokens ?? 0,
      totalCostUsd: g._sum.totalCostUsd ? Number(g._sum.totalCostUsd) : 0,
    }));

    // Live data for today — queried directly so it's always up to date.
    const todayStart = new Date(`${todayKey}T00:00:00.000Z`);
    const todayAgg = await this.prisma.marvinUsageEvent.aggregate({
      where: { createdAt: { gte: todayStart }, errorCode: null },
      _count: { _all: true },
      _sum: { creditsSpent: true, inputTokens: true, outputTokens: true, estimatedCostUsd: true },
    });
    if (todayAgg._count._all > 0) {
      // Replace any partial rollup for today (cron shouldn't produce one, but be safe).
      const existingIdx = rows.findIndex((r) => r.dayKey === todayKey);
      const todayRow: MarvDailyCostRow = {
        dayKey: todayKey,
        totalRequests: todayAgg._count._all,
        totalCreditsSpent: todayAgg._sum.creditsSpent ?? 0,
        totalInputTokens: todayAgg._sum.inputTokens ?? 0,
        totalOutputTokens: todayAgg._sum.outputTokens ?? 0,
        totalCostUsd: todayAgg._sum.estimatedCostUsd ? Number(todayAgg._sum.estimatedCostUsd) : 0,
      };
      if (existingIdx >= 0) rows[existingIdx] = todayRow;
      else rows.push(todayRow);
    }

    return rows;
  }
}

/** Format a Date as YYYY-MM-DD in UTC. Mirrors `MarvinCostRollupProcessor`. */
function toDayKey(d: Date): string {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}
