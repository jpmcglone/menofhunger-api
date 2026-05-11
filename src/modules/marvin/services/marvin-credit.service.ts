import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AppConfigService } from '../../app/app-config.service';
import type { ResolvedMarvinMode } from './marvin-routing.service';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Window during which a {@link MarvinCreditService.spend} call may reuse a `recentSummary`
 * passed by the caller instead of re-running the inner refill SELECT. 5 seconds is well
 * within the time between a Marv reply's pre-check refill and the post-success spend,
 * but short enough that any meaningful accrual ("creditsPerDay" drift) is negligible.
 */
const RECENT_REFILL_WINDOW_MS = 5_000;

export type MarvCreditState = {
  credits: number;
  lastRefilledAt: Date;
};

export type MarvCreditSummary = MarvCreditState & {
  /** Maximum credits the bucket can hold (cap on rollover). */
  maxCredits: number;
  /** Refill rate in credits per day. */
  creditsPerDay: number;
};

/**
 * Token-bucket Marv credit ledger.
 *
 * - Credits accrue continuously at `creditsPerDay` (default 40/day = 1200/month).
 * - The bucket caps at `maxCredits` (default 1500); excess refill is dropped.
 * - `refill()` is idempotent: it computes elapsed time since `lastRefilledAt` and
 *   adds the proportional refill, capped to the bucket max.
 * - `spend()` checks + decrements inside a single Prisma transaction so two parallel
 *   requests can never spend the same credit twice.
 *
 * The service does NOT decide who can use Marv — that's `MarvinPublicReplyProcessor`'s
 * job. We just account for the credits.
 */
@Injectable()
export class MarvinCreditService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly appConfig: AppConfigService,
  ) {}

  /** Return the cost (in credits) for a given mode, reading runtime config. */
  costForMode(mode: ResolvedMarvinMode): number {
    const c = this.appConfig.marvCredits();
    switch (mode) {
      case 'fast':
        return c.fastCost;
      case 'regular':
        return c.regularCost;
      case 'smart':
        return c.smartCost;
      default:
        return c.regularCost;
    }
  }

  /**
   * Fetch the user's bucket, refilling it based on elapsed time. If no row exists yet,
   * lazily create it at the monthly starting balance — premium users start with a full
   * month's worth of credits the first time they use Marv.
   */
  async refill(userId: string, now: Date = new Date()): Promise<MarvCreditSummary> {
    const cfg = this.appConfig.marvCredits();
    return await this.prisma.$transaction(async (tx) => {
      return await this.refillTx(tx, userId, now, cfg);
    });
  }

  /** Returns true when the user has at least `cost` credits after refill. */
  async canUse(userId: string, cost: number): Promise<boolean> {
    const bucket = await this.refill(userId);
    return bucket.credits >= cost;
  }

  /**
   * Atomically refill + spend. Throws when the user can't afford the cost.
   * Returns the post-spend bucket state so the caller can include it in the
   * realtime "credits updated" emit.
   *
   * Hot-path optimization: callers that just ran {@link refill} can pass `recentSummary`.
   * If `lastRefilledAt` is within {@link RECENT_REFILL_WINDOW_MS}, we skip the inner
   * refill SELECT and just decrement — saving one Postgres round-trip per successful
   * Marv reply. The 60s `noWriteNeeded` skip in `refillTx` already covers the slow
   * path; this is for the very common "we just refilled milliseconds ago" case.
   */
  async spend(
    userId: string,
    cost: number,
    options?: { now?: Date; recentSummary?: MarvCreditState },
  ): Promise<MarvCreditSummary> {
    if (!Number.isFinite(cost) || cost < 0) {
      throw new Error(`Invalid Marv credit cost: ${cost}`);
    }
    const now = options?.now ?? new Date();
    const cfg = this.appConfig.marvCredits();
    return await this.prisma.$transaction(async (tx) => {
      const refilled = await this.refillOrReuseTx(tx, userId, now, cfg, options?.recentSummary);
      if (refilled.credits < cost) {
        throw new InsufficientMarvCreditsError(refilled.credits, cost);
      }
      const next = Math.max(0, refilled.credits - cost);
      const updated = await tx.marvinCreditBalance.update({
        where: { userId },
        data: { credits: next, lastRefilledAt: now },
        select: { credits: true, lastRefilledAt: true },
      });
      return {
        credits: updated.credits,
        lastRefilledAt: updated.lastRefilledAt,
        maxCredits: cfg.maxCredits,
        creditsPerDay: cfg.creditsPerDay,
      };
    });
  }

  private async refillOrReuseTx(
    tx: Prisma.TransactionClient,
    userId: string,
    now: Date,
    cfg: ReturnType<AppConfigService['marvCredits']>,
    recent?: MarvCreditState,
  ): Promise<MarvCreditSummary> {
    if (recent) {
      const sinceMs = Math.max(0, now.getTime() - recent.lastRefilledAt.getTime());
      if (sinceMs <= RECENT_REFILL_WINDOW_MS) {
        // Tiny accrual since the recent refill — keep the prior credit count.
        // The credit cost will be deducted by the caller's `update` immediately after,
        // so the lastRefilledAt sliding to `now` matches the existing semantics.
        return {
          credits: recent.credits,
          lastRefilledAt: recent.lastRefilledAt,
          maxCredits: cfg.maxCredits,
          creditsPerDay: cfg.creditsPerDay,
        };
      }
    }
    return await this.refillTx(tx, userId, now, cfg);
  }

  /**
   * Estimate the time until the user accrues `target` more credits.
   * Returns 0 when the user already has enough. Used in the "out of credits" canned DM.
   */
  msUntilCredits(currentCredits: number, target: number): number {
    if (currentCredits >= target) return 0;
    const cfg = this.appConfig.marvCredits();
    if (cfg.creditsPerDay <= 0) return Number.POSITIVE_INFINITY;
    const needed = target - currentCredits;
    return Math.ceil((needed / cfg.creditsPerDay) * MS_PER_DAY);
  }

  /** Format `msUntilCredits` as a human-friendly relative window. */
  static humanizeMs(ms: number): string {
    if (!Number.isFinite(ms)) return 'a while';
    if (ms < 60 * 1000) return 'a moment';
    if (ms < 60 * 60 * 1000) {
      const minutes = Math.max(1, Math.round(ms / (60 * 1000)));
      return `${minutes} minute${minutes === 1 ? '' : 's'}`;
    }
    if (ms < MS_PER_DAY) {
      const hours = Math.max(1, Math.round(ms / (60 * 60 * 1000)));
      return `${hours} hour${hours === 1 ? '' : 's'}`;
    }
    const days = Math.max(1, Math.round(ms / MS_PER_DAY));
    return `${days} day${days === 1 ? '' : 's'}`;
  }

  /** Read-only summary (refilled). Used by the user-facing GET /marvin/me endpoint. */
  async getSummary(userId: string): Promise<MarvCreditSummary> {
    return await this.refill(userId);
  }

  /** Admin: directly set credits to a value, capped at the bucket max. */
  async setCredits(userId: string, credits: number, now: Date = new Date()): Promise<MarvCreditSummary> {
    const cfg = this.appConfig.marvCredits();
    if (!Number.isFinite(credits) || credits < 0) {
      throw new Error('Credits must be a non-negative finite number.');
    }
    const capped = Math.min(cfg.maxCredits, credits);
    const updated = await this.prisma.marvinCreditBalance.upsert({
      where: { userId },
      create: { userId, credits: capped, lastRefilledAt: now },
      update: { credits: capped, lastRefilledAt: now },
      select: { credits: true, lastRefilledAt: true },
    });
    return {
      credits: updated.credits,
      lastRefilledAt: updated.lastRefilledAt,
      maxCredits: cfg.maxCredits,
      creditsPerDay: cfg.creditsPerDay,
    };
  }

  private async refillTx(
    tx: Prisma.TransactionClient,
    userId: string,
    now: Date,
    cfg: ReturnType<AppConfigService['marvCredits']>,
  ): Promise<MarvCreditSummary> {
    const existing = await tx.marvinCreditBalance.findUnique({
      where: { userId },
      select: { credits: true, lastRefilledAt: true },
    });

    if (!existing) {
      const initial = Math.min(cfg.maxCredits, cfg.monthlyCredits);
      const created = await tx.marvinCreditBalance.create({
        data: { userId, credits: initial, lastRefilledAt: now },
        select: { credits: true, lastRefilledAt: true },
      });
      return {
        credits: created.credits,
        lastRefilledAt: created.lastRefilledAt,
        maxCredits: cfg.maxCredits,
        creditsPerDay: cfg.creditsPerDay,
      };
    }

    const elapsedMs = Math.max(0, now.getTime() - existing.lastRefilledAt.getTime());
    const elapsedDays = elapsedMs / MS_PER_DAY;
    const accrued = elapsedDays * cfg.creditsPerDay;
    const next = Math.min(cfg.maxCredits, existing.credits + accrued);

    // Skip the write when nothing meaningfully changed (avoids hot-path churn).
    const noWriteNeeded = next === existing.credits && elapsedMs < 60 * 1000;
    if (noWriteNeeded) {
      return {
        credits: existing.credits,
        lastRefilledAt: existing.lastRefilledAt,
        maxCredits: cfg.maxCredits,
        creditsPerDay: cfg.creditsPerDay,
      };
    }

    const updated = await tx.marvinCreditBalance.update({
      where: { userId },
      data: { credits: next, lastRefilledAt: now },
      select: { credits: true, lastRefilledAt: true },
    });
    return {
      credits: updated.credits,
      lastRefilledAt: updated.lastRefilledAt,
      maxCredits: cfg.maxCredits,
      creditsPerDay: cfg.creditsPerDay,
    };
  }
}

export class InsufficientMarvCreditsError extends Error {
  readonly currentCredits: number;
  readonly requiredCredits: number;
  constructor(currentCredits: number, requiredCredits: number) {
    super(`Insufficient Marv credits: have ${currentCredits.toFixed(2)}, need ${requiredCredits}.`);
    this.name = 'InsufficientMarvCreditsError';
    this.currentCredits = currentCredits;
    this.requiredCredits = requiredCredits;
  }
}
