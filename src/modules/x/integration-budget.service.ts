import { controlledPolicy } from "./integration-spend-controls";
import { spendTotals, lifetimeSpend } from "./integration-spend-totals";
import { Injectable } from "@nestjs/common";
import type { IntegrationUsageReservation } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { assertMicrodollars, integrationLimits, integrationMonth, integrationReset, type IntegrationBucket, type IntegrationProvider, type IntegrationSpendPolicy } from "./integration-budget.policy";

export interface IntegrationReservationInput {
  id: string;
  userId?: string;
  externalAccountId?: string;
  provider: IntegrationProvider;
  action: string;
  bucket: IntegrationBucket;
  maximumMicros: number;
  publicationCount?: number;
}

/** A failed request can still have a vendor charge. Released rows retain it. */
export function integrationCommittedCost(
  row: Pick<
    IntegrationUsageReservation,
    "status" | "reservedMicros" | "chargedMicros"
  >,
): number {
  if (row.status === "released") return row.chargedMicros ?? 0;
  if (row.status === "settled") return row.chargedMicros ?? row.reservedMicros;
  return Math.max(row.reservedMicros, row.chargedMicros ?? 0);
}

@Injectable()
export class IntegrationBudgetService {
  constructor(private readonly prisma: PrismaService) {}

  async reserve(
    input: IntegrationReservationInput,
    policy: IntegrationSpendPolicy,
    now = new Date(),
  ): Promise<boolean> {
    assertMicrodollars(input.maximumMicros);
    for (const cap of [
      policy.companyMonthlyMicros,
      policy.companyDailyMicros,
      policy.providerMonthlyMicros,
      policy.sharedMonthlyMicros,
    ])
      assertMicrodollars(cap);
    const headroom =
      input.action === "remove" ? 0 : (policy.removalHeadroomMicros ?? 0);
    assertMicrodollars(headroom);
    const publications = input.publicationCount ?? 0;
    if (!Number.isSafeInteger(publications) || publications < 0)
      throw new Error("Invalid publication count.");
    if (
      !policy.enabled ||
      !policy.priceVersion ||
      !policy.companyMonthlyMicros ||
      !policy.companyDailyMicros ||
      !policy.providerMonthlyMicros
    )
      return false;
    const month = integrationMonth(now);
    const day = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
    return this.prisma.$transaction(async (tx) => {
      // One company lock makes the global cap and all overlapping identity/bucket
      // caps atomic. No network request occurs in this short transaction.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('integration-spend'))`;
      policy = controlledPolicy(
        policy,
        await tx.integrationSpendControl.findUnique({
          where: { id: "global" },
        }),
        input.bucket,
        input.provider,
      );
      if (
        !policy.enabled ||
        !policy.companyMonthlyMicros ||
        !policy.companyDailyMicros ||
        !policy.providerMonthlyMicros
      )
        return false;
      const existing = await tx.integrationUsageReservation.findUnique({
        where: { id: input.id },
      });
      if (existing) {
        const sameOperation =
          existing.userId === (input.userId ?? null) &&
          existing.externalAccountId === (input.externalAccountId ?? null) &&
          existing.provider === input.provider &&
          existing.action === input.action &&
          existing.bucket === input.bucket &&
          existing.reservedMicros === input.maximumMicros &&
          existing.priceVersion === policy.priceVersion &&
          existing.publicationCount === publications &&
          existing.month.getTime() === month.getTime();
        if (!sameOperation || existing.status !== "released") return false;
      }
      // A reservation is an exclusive dispatch claim. A duplicate worker may not
      // reuse an active hold, even before the first worker starts its request.
      // Never erase a failed attempt's bill by reusing its ID.
      if (existing?.chargedMicros) return false;
      const user = input.userId
        ? await tx.user.findUnique({
            where: { id: input.userId },
            select: {
              premium: true,
              premiumPlus: true,
              verifiedStatus: true,
              bannedAt: true,
            },
          })
        : null;
      const limits = integrationLimits({
        premium: user?.premium ?? false,
        premiumPlus: user?.premiumPlus ?? false,
        verified: Boolean(user && user.verifiedStatus !== "none"),
        banned: Boolean(user?.bannedAt),
      });
      if (
        (input.bucket === "regular" && !limits.regular) ||
        (input.bucket === "expensive" && !limits.expensive)
      )
        return false;
      if (
        input.bucket === "acquisition" &&
        (!limits.xPublications ||
          input.provider !== "x" ||
          input.action !== "create")
      )
        return false;
      if (input.bucket === "reserve" && input.userId) return false; // Public readers never pay personally.
      if (
        policy.actionLifetimeMicros !== undefined ||
        policy.actionLifetimeRequests !== undefined
      ) {
        if (policy.actionLifetimeMicros !== undefined)
          assertMicrodollars(policy.actionLifetimeMicros);
        const history = await lifetimeSpend(
          tx,
          input.provider,
          input.action,
          input.id,
        );
        if (
          policy.actionLifetimeMicros !== undefined &&
          history.cost + input.maximumMicros > policy.actionLifetimeMicros
        )
          return false;
        if (
          policy.actionLifetimeRequests !== undefined &&
          history.requests >= policy.actionLifetimeRequests
        )
          return false;
      }
      const totals = await spendTotals(tx, {
        month,
        day,
        excludeId: input.id,
        provider: input.provider,
        userId: input.userId,
        externalAccountId: input.externalAccountId,
        bucket: input.bucket,
      });
      const exceeds = (used: number, cap: number) =>
        used + input.maximumMicros > cap;
      if (
        exceeds(
          totals.company,
          Math.max(0, policy.companyMonthlyMicros - headroom),
        ) ||
        exceeds(
          totals.daily,
          Math.max(0, policy.companyDailyMicros - headroom),
        ) ||
        exceeds(
          totals.provider,
          Math.max(0, policy.providerMonthlyMicros - headroom),
        )
      )
        return false;
      const bucketLimit =
        input.bucket === "regular"
          ? limits.regular
          : input.bucket === "expensive"
            ? limits.expensive
            : Math.max(
                0,
                policy.sharedMonthlyMicros -
                  (input.bucket === "reserve" ? headroom : 0),
              );
      if (exceeds(totals.bucket, bucketLimit)) return false;
      if (
        input.action === "analytics" &&
        exceeds(totals.analytics, limits.analytics)
      )
        return false;
      if (
        input.provider === "x" &&
        publications &&
        totals.publications + publications > limits.xPublications
      )
        return false;
      const data = {
        userId: input.userId ?? null,
        externalAccountId: input.externalAccountId ?? null,
        provider: input.provider,
        action: input.action,
        bucket: input.bucket,
        month,
        priceVersion: policy.priceVersion,
        reservedMicros: input.maximumMicros,
        publicationCount: publications,
        status: "reserved",
        chargedMicros: null,
        createdAt: now,
      };
      await tx.integrationUsageReservation.upsert({
        where: { id: input.id },
        create: { id: input.id, ...data },
        update: data,
      });
      return true;
    });
  }

  /** Observe legacy sends during rollout so turning the new model on never resets usage. */
  async recordLegacy(input: IntegrationReservationInput): Promise<void> {
    const now = new Date();
    await this.prisma.integrationUsageReservation.upsert({
      where: { id: input.id },
      update: {},
      create: {
        id: input.id,
        userId: input.userId ?? null,
        externalAccountId: input.externalAccountId ?? null,
        provider: input.provider,
        action: input.action,
        bucket: input.bucket,
        month: integrationMonth(now),
        priceVersion: "legacy-x-estimate",
        reservedMicros: input.maximumMicros,
        publicationCount: input.publicationCount ?? 0,
      },
    });
  }

  async settle(
    id: string,
    status: "settled" | "uncertain" | "released",
    chargedMicros?: number,
  ): Promise<void> {
    if (chargedMicros !== undefined) assertMicrodollars(chargedMicros);
    // Unknown vendor outcome cannot release the hold. Only explicit reconciliation
    // may settle/release an uncertain request, using the same durable operation ID.
    await this.prisma.integrationUsageReservation.updateMany({
      where: { id, status: { in: ["reserved", "uncertain"] } },
      data: {
        status,
        ...(chargedMicros === undefined ? {} : { chargedMicros }),
      },
    });
  }

  async allowance(
    userId: string,
    now = new Date(),
    externalAccountId?: string,
  ) {
    const [user, totals] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: userId },
        select: {
          premium: true,
          premiumPlus: true,
          verifiedStatus: true,
          bannedAt: true,
        },
      }),
      spendTotals(this.prisma, {
        month: integrationMonth(now),
        day: now,
        provider: "x",
        userId,
        externalAccountId,
        bucket: "regular",
      }),
    ]);
    const limits = integrationLimits({
      premium: user?.premium ?? false,
      premiumPlus: user?.premiumPlus ?? false,
      verified: Boolean(user && user.verifiedStatus !== "none"),
      banned: Boolean(user?.bannedAt),
    });
    const bucket = (name: "regular" | "expensive") => {
      const committedMicros = totals[name];
      return {
        limitMicros: limits[name],
        committedMicros,
        remainingMicros: Math.max(0, limits[name] - committedMicros),
        pendingMicros:
          name === "regular" ? totals.pendingRegular : totals.pendingExpensive,
      };
    };
    return {
      regular: bucket("regular"),
      expensive: bucket("expensive"),
      resetsAt: integrationReset(now),
    };
  }
}
export type { IntegrationSpendPolicy } from "./integration-budget.policy";
