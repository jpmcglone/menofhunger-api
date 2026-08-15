import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AppConfigService } from '../../app/app-config.service';
import type { ResolvedMarvinMode } from './marvin-routing.service';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Window during which a {@link MarvinCreditService.reserve}/{@link MarvinCreditService.spend}
 * call may reuse a `recentSummary` instead of re-running the inner refill SELECT. 5 seconds
 * covers the gap between an early soft check and the hard reserve before the AI call.
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
 * - Credits accrue continuously at `creditsPerDay` (default 20/day = 600/month).
 * - The bucket caps at `maxCredits` (default 600); excess refill is dropped.
 * - `refill()` is idempotent: it computes elapsed time since `lastRefilledAt` and
 *   adds the proportional refill, capped to the bucket max.
 * - `reserve()` / `spend()` use an atomic guarded decrement (`UPDATE … SET credits = credits - cost
 *   WHERE credits >= cost`) so concurrent transactions serialize on the row lock and
 *   can never both succeed when there are only enough credits for one.
 * - Paid paths use **reserve → AI → settle → deliver**, with `refund()` on AI/deliver failure.
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
   * Atomically refill + decrement. Throws when the user can't afford the amount.
   * Used before the AI turn so credits are held even if concurrent jobs race.
   *
   * The decrement is issued as `UPDATE … SET credits = credits - amount WHERE credits >= amount`,
   * which takes a row-level exclusive lock and prevents two concurrent transactions from
   * both succeeding on the same balance. The optional `recentSummary` fast path skips the
   * inner refill SELECT when the caller refilled within {@link RECENT_REFILL_WINDOW_MS}.
   */
  async reserve(
    userId: string,
    amount: number,
    options?: { now?: Date; recentSummary?: MarvCreditState },
  ): Promise<MarvCreditSummary> {
    return await this.decrement(userId, amount, options);
  }

  /**
   * Alias for {@link reserve}. Prefer reserve/settle on paid paths; spend remains for
   * callers that charge a known amount in one step.
   */
  async spend(
    userId: string,
    cost: number,
    options?: { now?: Date; recentSummary?: MarvCreditState },
  ): Promise<MarvCreditSummary> {
    return await this.reserve(userId, cost, options);
  }

  /**
   * Return previously reserved credits (e.g. AI failed or delivery failed after settle).
   * Caps the resulting balance at `maxCredits` so a refund cannot overflow the bucket.
   */
  async refund(userId: string, amount: number, now: Date = new Date()): Promise<MarvCreditSummary> {
    if (!Number.isFinite(amount) || amount < 0) {
      throw new Error(`Invalid Marv credit refund: ${amount}`);
    }
    const cfg = this.appConfig.marvCredits();
    if (amount === 0) {
      return await this.refill(userId, now);
    }
    return await this.prisma.$transaction(async (tx) => {
      const existing = await tx.marvinCreditBalance.findUnique({
        where: { userId },
        select: { credits: true, lastRefilledAt: true },
      });
      if (!existing) {
        // Nothing to refund into — create a capped bucket with the refund amount.
        const capped = Math.min(cfg.maxCredits, amount);
        const created = await tx.marvinCreditBalance.upsert({
          where: { userId },
          create: { userId, credits: capped, lastRefilledAt: now },
          update: {},
          select: { credits: true, lastRefilledAt: true },
        });
        return {
          credits: created.credits,
          lastRefilledAt: created.lastRefilledAt,
          maxCredits: cfg.maxCredits,
          creditsPerDay: cfg.creditsPerDay,
        };
      }
      const next = Math.min(cfg.maxCredits, existing.credits + amount);
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

  /**
   * After a successful AI turn: adjust the held reservation to the actual cost.
   * - actual < reserved → refund the delta
   * - actual === reserved → no-op (return current summary)
   * - actual > reserved → try to decrement the remainder; on failure refund the
   *   original reservation and throw {@link InsufficientMarvCreditsError}
   */
  async settle(
    userId: string,
    reserved: number,
    actual: number,
    options?: { now?: Date },
  ): Promise<MarvCreditSummary> {
    if (!Number.isFinite(reserved) || reserved < 0 || !Number.isFinite(actual) || actual < 0) {
      throw new Error(`Invalid Marv credit settle: reserved=${reserved} actual=${actual}`);
    }
    const now = options?.now ?? new Date();
    if (actual < reserved) {
      return await this.refund(userId, reserved - actual, now);
    }
    if (actual > reserved) {
      try {
        return await this.decrement(userId, actual - reserved, { now });
      } catch (err) {
        if (err instanceof InsufficientMarvCreditsError) {
          // Release the held reservation so the user is not charged for a reply we won't deliver.
          await this.refund(userId, reserved, now).catch(() => undefined);
        }
        throw err;
      }
    }
    return await this.refill(userId, now);
  }

  private async decrement(
    userId: string,
    amount: number,
    options?: { now?: Date; recentSummary?: MarvCreditState },
  ): Promise<MarvCreditSummary> {
    if (!Number.isFinite(amount) || amount < 0) {
      throw new Error(`Invalid Marv credit cost: ${amount}`);
    }
    if (amount === 0) {
      return await this.refill(userId, options?.now ?? new Date());
    }
    const now = options?.now ?? new Date();
    const cfg = this.appConfig.marvCredits();
    return await this.prisma.$transaction(async (tx) => {
      const refilled = await this.refillOrReuseTx(tx, userId, now, cfg, options?.recentSummary);
      if (refilled.credits < amount) {
        throw new InsufficientMarvCreditsError(refilled.credits, amount);
      }
      const affected = await tx.marvinCreditBalance.updateMany({
        where: { userId, credits: { gte: amount } },
        data: { credits: { decrement: amount }, lastRefilledAt: now },
      });
      if (affected.count === 0) {
        const fresh = await tx.marvinCreditBalance.findUnique({
          where: { userId },
          select: { credits: true },
        });
        throw new InsufficientMarvCreditsError(fresh?.credits ?? 0, amount);
      }
      const updated = await tx.marvinCreditBalance.findUnique({
        where: { userId },
        select: { credits: true, lastRefilledAt: true },
      });
      return {
        credits: updated!.credits,
        lastRefilledAt: updated!.lastRefilledAt,
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
      // Use upsert instead of create to handle the race where two concurrent requests
      // both see no row and both attempt to create the bucket simultaneously.
      const created = await tx.marvinCreditBalance.upsert({
        where: { userId },
        create: { userId, credits: initial, lastRefilledAt: now },
        update: {},
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
