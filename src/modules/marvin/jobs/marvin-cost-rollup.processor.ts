import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Worker handler for `marvin.costRollup`.
 *
 * Aggregates the previous UTC day's `MarvinUsageEvent`s into per-user-per-mode
 * rollups in `MarvinCostRollup`. Idempotent: re-running the same dayKey
 * upserts and overwrites totals (safe because the source events for that day
 * are immutable).
 *
 * The rollup writes one row per `(dayKey, userId, mode)` AND one global
 * `(dayKey, userId=null, mode=null)` row so the admin page can ask either
 * "spend by tier" or "total daily spend" with a single index lookup.
 */
@Injectable()
export class MarvinCostRollupProcessor {
  private readonly logger = new Logger(MarvinCostRollupProcessor.name);

  constructor(private readonly prisma: PrismaService) {}

  async process(): Promise<void> {
    const day = previousUtcDay();
    const start = new Date(`${day}T00:00:00.000Z`);
    const end = new Date(`${day}T23:59:59.999Z`);

    const buckets = await this.prisma.$queryRaw<
      Array<{
        userId: string;
        mode: 'fast' | 'regular' | 'smart';
        totalRequests: number;
        totalCreditsSpent: number;
        totalInputTokens: number;
        totalOutputTokens: number;
        totalCostUsd: Prisma.Decimal;
      }>
    >`
      SELECT
        "userId" as "userId",
        "effectiveMode" as "mode",
        COUNT(*)::int as "totalRequests",
        COALESCE(SUM("creditsSpent"), 0)::float8 as "totalCreditsSpent",
        COALESCE(SUM("inputTokens"), 0)::int as "totalInputTokens",
        COALESCE(SUM("outputTokens"), 0)::int as "totalOutputTokens",
        COALESCE(SUM("estimatedCostUsd"), 0) as "totalCostUsd"
      FROM "MarvinUsageEvent"
      WHERE "createdAt" >= ${start}
        AND "createdAt" <= ${end}
        AND "errorCode" IS NULL
      GROUP BY "userId", "effectiveMode"
    `;

    if (buckets.length === 0) {
      this.logger.debug(`[marv] cost-rollup ${day}: no events`);
      return;
    }

    // Per-(user, mode) rollups. The admin page sums these on read for global
    // 7d/30d charts so we don't have to deal with nullable-compound-unique
    // semantics here.
    let totalRequests = 0;
    let totalCostUsd = new Prisma.Decimal(0);
    for (const b of buckets) {
      await this.prisma.marvinCostRollup.upsert({
        where: {
          dayKey_userId_mode: { dayKey: day, userId: b.userId, mode: b.mode },
        },
        update: {
          totalRequests: b.totalRequests,
          totalCreditsSpent: b.totalCreditsSpent,
          totalInputTokens: b.totalInputTokens,
          totalOutputTokens: b.totalOutputTokens,
          totalCostUsd: b.totalCostUsd,
        },
        create: {
          dayKey: day,
          userId: b.userId,
          mode: b.mode,
          totalRequests: b.totalRequests,
          totalCreditsSpent: b.totalCreditsSpent,
          totalInputTokens: b.totalInputTokens,
          totalOutputTokens: b.totalOutputTokens,
          totalCostUsd: b.totalCostUsd,
        },
      });
      totalRequests += b.totalRequests;
      totalCostUsd = totalCostUsd.add(b.totalCostUsd);
    }

    this.logger.log(
      `[marv] cost-rollup ${day}: ${buckets.length} buckets, ${totalRequests} requests, $${totalCostUsd.toString()}`,
    );
  }
}

function previousUtcDay(): string {
  const d = new Date(Date.now() - 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}
