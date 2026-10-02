import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfigService } from '../app/app-config.service';

export const CALL_BUDGET_BYTES = 1_000_000_000_000n; // $50 at $0.05/GB; deliberately excludes the shared free allowance.
export const CALL_BUDGET_LEASE_MS = 120_000;
export const CALL_BUDGET_WARNING_MS = 60_000;
const CLEANUP_AND_REPORTING_MS = 60_000;

export function reservationMonths(now: Date, expiresAt: Date): string[] {
  return [...new Set([now.toISOString().slice(0, 7), new Date(expiresAt.getTime() + CLEANUP_AND_REPORTING_MS).toISOString().slice(0, 7)])];
}

type Lease = { callId: string; expiresAt: Date; capacity: number };
export type BudgetAdmission = { expiresAt: string } | { error: 'budget_exhausted' | 'calling_unavailable' };

/** Durable, conservative estimated traffic reservations. Never refunds estimates or accepts client usage reports.
 * The configured estimate includes headroom for TURN, retries, and cleanup.
 * This is an application allowance, not a guaranteed Cloudflare invoice cap.
 */
@Injectable()
export class CallBudgetService {
  constructor(private readonly prisma: PrismaService, private readonly config: AppConfigService) {}

  async reserve(callId: string, capacity: number): Promise<BudgetAdmission> {
    const rate = this.config.callsBudgetBytesPerSecond();
    if (!rate || ![2, 4].includes(capacity)) return { error: 'calling_unavailable' };
    try {
      return await this.prisma.$transaction(async (tx) => {
        // Serialize all instances, including rollover and duplicate renewal attempts.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(72604102)`;
        const [{ now }] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
        const [previous] = await tx.$queryRaw<Lease[]>`SELECT * FROM "CallBudgetLease" WHERE "callId" = ${callId}`;
        if (previous && previous.capacity !== capacity) return { error: 'calling_unavailable' as const };
        if (previous && previous.expiresAt.getTime() <= now.getTime()) return { error: 'budget_exhausted' as const };
        if (previous && previous.expiresAt.getTime() - now.getTime() > 90_000) {
          return { expiresAt: previous.expiresAt.toISOString() };
        }
        const expiresAt = new Date(now.getTime() + CALL_BUDGET_LEASE_MS);
        // Rate is a server-owned reservation estimate, not a guaranteed provider traffic limit.
        const bytes = BigInt(rate) * BigInt(capacity * capacity) * BigInt((CALL_BUDGET_LEASE_MS + CLEANUP_AND_REPORTING_MS) / 1000);
        const months = reservationMonths(now, expiresAt);
        // Reserve a whole interval in both months when it straddles rollover. Conservative, never free capacity on reset.
        for (const month of months) {
          await tx.$executeRaw`INSERT INTO "CallBudgetMonth" ("month", "reservedBytes") VALUES (${month}, 0) ON CONFLICT DO NOTHING`;
          const updated = await tx.$executeRaw`UPDATE "CallBudgetMonth" SET "reservedBytes" = "reservedBytes" + ${bytes}
            WHERE "month" = ${month} AND "reservedBytes" + ${bytes} <= ${CALL_BUDGET_BYTES}`;
          if (!updated) throw new BudgetExhausted();
        }
        await tx.$executeRaw`INSERT INTO "CallBudgetLease" ("callId", "capacity", "expiresAt") VALUES (${callId}, ${capacity}, ${expiresAt})
          ON CONFLICT ("callId") DO UPDATE SET "expiresAt" = EXCLUDED."expiresAt"`;
        return { expiresAt: expiresAt.toISOString() };
      });
    } catch (error) {
      return { error: error instanceof BudgetExhausted ? 'budget_exhausted' : 'calling_unavailable' };
    }
  }

  /** Every provider allocation checks the durable allowance. Database outages block new media. */
  async allowsAllocation(callId: string): Promise<boolean> {
    if (!this.config.callsBudgetBytesPerSecond()) return false;
    try {
      const rows = await this.prisma.$queryRaw<Array<{ callId: string }>>`SELECT "callId" FROM "CallBudgetLease"
        WHERE "callId" = ${callId} AND "expiresAt" > clock_timestamp() + interval '60 seconds'`;
      return rows.length === 1;
    } catch { return false; }
  }
}
class BudgetExhausted extends Error {}
