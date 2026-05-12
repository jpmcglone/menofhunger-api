import { Injectable, Logger } from '@nestjs/common';
import type { MarvinMode, MarvinSource, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { PresenceRealtimeService } from '../../presence/presence-realtime.service';
import type { MarvCreditSummary } from './marvin-credit.service';
import type { MarvErrorCode } from '../marvin.constants';

export type RecordEventInput = {
  userId: string;
  source: MarvinSource;
  /** post id (public) or conversation id (private). */
  sourceId: string;
  rootPostId?: string | null;
  requestedMode: MarvinMode;
  effectiveMode: MarvinMode;
  creditsSpent: number;
  inputTokens?: number | null;
  outputTokens?: number | null;
  cachedInputTokens?: number | null;
  modelUsed?: string | null;
  estimatedCostUsd?: number | null;
  responseId?: string | null;
  routingReason?: string | null;
  errorCode?: MarvErrorCode | null;
  latencyMs?: number | null;
  /** Pass the credit-summary AFTER spending so we can emit the realtime update. */
  postSpendSummary?: MarvCreditSummary | null;
};

/**
 * Single place to write a `MarvinUsageEvent` and emit the matching `marv:credits-updated`
 * realtime event. Per the realtime-first rule, every Marv interaction (including canned
 * 0-credit ones) lands here so the admin dashboard sees the same row stream.
 */
@Injectable()
export class MarvinUsageService {
  private readonly logger = new Logger(MarvinUsageService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly presenceRealtime: PresenceRealtimeService,
  ) {}

  async recordEvent(input: RecordEventInput): Promise<void> {
    try {
      await this.prisma.marvinUsageEvent.create({
        data: {
          userId: input.userId,
          source: input.source,
          sourceId: input.sourceId,
          rootPostId: input.rootPostId ?? null,
          requestedMode: input.requestedMode,
          effectiveMode: input.effectiveMode,
          creditsSpent: input.creditsSpent,
          inputTokens: input.inputTokens ?? null,
          outputTokens: input.outputTokens ?? null,
          cachedInputTokens: input.cachedInputTokens ?? null,
          modelUsed: input.modelUsed ?? null,
          estimatedCostUsd: input.estimatedCostUsd != null ? toDecimal(input.estimatedCostUsd) : null,
          responseId: input.responseId ?? null,
          routingReason: input.routingReason ?? null,
          errorCode: input.errorCode ?? null,
          latencyMs: input.latencyMs ?? null,
        },
      });
    } catch (err) {
      this.logger.warn(
        `[marv] Failed to record MarvinUsageEvent: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    this.logger.log(
      `[marv] reply user=${input.userId} source=${input.source} requested=${input.requestedMode} ` +
        `effective=${input.effectiveMode} model=${input.modelUsed ?? '-'} spent=${input.creditsSpent} ` +
        `latencyMs=${input.latencyMs ?? '-'} cost=${input.estimatedCostUsd ?? '-'} reason=${input.routingReason ?? '-'} ` +
        `error=${input.errorCode ?? '-'}`,
    );

    if (input.postSpendSummary) {
      this.emitCreditsUpdated(input.userId, input.postSpendSummary);
    }
  }

  /**
   * Emit the realtime update so the credits chip in the chat page / settings refreshes
   * without polling. Carries everything the UI needs to render fresh state.
   */
  emitCreditsUpdated(userId: string, summary: MarvCreditSummary): void {
    try {
      this.presenceRealtime.emitMarvCreditsUpdated(userId, {
        credits: summary.credits,
        maxCredits: summary.maxCredits,
        creditsPerDay: summary.creditsPerDay,
        lastRefilledAt: summary.lastRefilledAt.toISOString(),
      });
    } catch (err) {
      this.logger.debug(
        `[marv] emitCreditsUpdated failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Returns the count of public Marv replies + (separately) private replies the user has
   * received in a recent time window. Used for rate limiting in the public/private processors.
   */
  async countRecent(args: {
    userId: string;
    source: MarvinSource;
    /** Window in minutes. */
    windowMinutes: number;
    /** Only count successful replies (errorCode IS NULL). */
    successOnly?: boolean;
  }): Promise<number> {
    const since = new Date(Date.now() - args.windowMinutes * 60 * 1000);
    const where: Prisma.MarvinUsageEventWhereInput = {
      userId: args.userId,
      source: args.source,
      createdAt: { gte: since },
    };
    if (args.successOnly !== false) where.errorCode = null;
    return await this.prisma.marvinUsageEvent.count({ where });
  }

  /**
   * Count successful Marv replies for a (thread, requesting user) pair within a sliding window.
   *
   * Used by the public-reply processor as a burst limiter: allow a small burst of mentions
   * in quick succession (e.g. 3) before the cooldown DM kicks in. Scoped by `userId` so
   * different users in the same thread don't block each other.
   */
  async countRecentRepliesForRootAndUser(args: {
    rootPostId: string;
    userId: string;
    windowSeconds: number;
  }): Promise<number> {
    const since = new Date(Date.now() - args.windowSeconds * 1_000);
    return await this.prisma.marvinUsageEvent.count({
      where: {
        source: 'public_thread',
        rootPostId: args.rootPostId,
        userId: args.userId,
        errorCode: null,
        createdAt: { gte: since },
      },
    });
  }
}

function toDecimal(n: number): Prisma.Decimal | string {
  // Prisma can take a string or Decimal; string is portable + avoids a bigint dep.
  return Number.isFinite(n) ? n.toFixed(6) : '0';
}
