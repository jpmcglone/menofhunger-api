import { Injectable, OnModuleInit, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import * as Sentry from "@sentry/nestjs";
import { PrismaService } from "../prisma/prisma.service";
import { RedisService } from "../redis/redis.service";
import { AppConfigService } from "../app/app-config.service";
import { SideEffectsRegistry } from "../side-effects/side-effects.registry";
import { SideEffectsService } from "../side-effects/side-effects.service";
import { integrationMonth } from "./integration-budget.policy";
import { spendTotals } from "./integration-spend-totals";
import { controlledPolicy } from "./integration-spend-controls";
import { XPublicSnapshotService } from "./x-public-snapshot.service";

export type IntegrationAlertCondition = {
  key: string;
  severity: "warning" | "error";
  message: string;
};
export function spendingAlerts(
  used: { company: number; daily: number; provider: number; bucket: number },
  caps: {
    companyMonthlyMicros: number;
    companyDailyMicros: number;
    providerMonthlyMicros: number;
    sharedMonthlyMicros: number;
  },
): IntegrationAlertCondition[] {
  return (
    [
      ["company-month", used.company, caps.companyMonthlyMicros],
      ["company-day", used.daily, caps.companyDailyMicros],
      ["x-month", used.provider, caps.providerMonthlyMicros],
      ["reserve", used.bucket, caps.sharedMonthlyMicros],
    ] as const
  ).flatMap(([key, cost, cap]) => {
    if (!cost || cost < cap * 0.8) return [];
    return [
      {
        key,
        severity: cost >= cap ? "error" : "warning",
        message: `${key}: $${(cost / 1e6).toFixed(2)} committed against $${(cap / 1e6).toFixed(2)} ceiling.`,
      },
    ];
  });
}

@Injectable()
export class IntegrationOperationsService implements OnModuleInit {
  private readonly logger = new Logger(IntegrationOperationsService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly config: AppConfigService,
    private readonly registry: SideEffectsRegistry,
    private readonly effects: SideEffectsService,
    private readonly snapshots: XPublicSnapshotService,
  ) {}
  onModuleInit() {
    this.registry.register("integrations.monitor", () => this.check());
  }
  @Cron("*/5 * * * *")
  schedule() {
    if (this.config.runSchedulers())
      this.effects.dispatch(
        "integrations.monitor",
        {},
        { jobId: `integration-monitor-${Math.floor(Date.now() / 300000)}` },
      );
  }
  async check() {
    const now = new Date(),
      day = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
      );
    const conditions: IntegrationAlertCondition[] = [];
    try {
      await this.redis.raw().ping();
    } catch {
      conditions.push({
        key: "preview-cache",
        severity: "error",
        message:
          "Redis unavailable. Fresh durable public previews remain readable; paid refreshes fail closed.",
      });
    }
    const control = await this.prisma.integrationSpendControl.findUnique({
      where: { id: "global" },
    });
    const policy = controlledPolicy(
      this.config.integrationBudget("reserve"),
      control,
      "reserve",
    );
    const totals = await spendTotals(this.prisma, {
      month: integrationMonth(now),
      day,
      provider: "x",
      bucket: "reserve",
    });
    conditions.push(...spendingAlerts(totals, policy));
    await this.releaseRefundedCrosspostHolds();
    const held = await this.prisma.integrationUsageReservation.count({
      where: {
        status: { in: ["reserved", "uncertain"] },
        createdAt: { lt: new Date(now.getTime() - 3600000) },
      },
    });
    if (held)
      conditions.push({
        key: "reconciliation",
        severity: "warning",
        message: `${held} operations have held funds for more than one hour. Review vendor outcomes before releasing or retrying.`,
      });
    const recentFailures = await this.prisma.integrationUsageReservation.count({
      where: {
        status: "uncertain",
        updatedAt: {
          gte: new Date(now.getTime() - 3600000),
          lt: new Date(now.getTime() - 120000),
        },
      },
    });
    if (recentFailures >= 5)
      conditions.push({
        key: "provider-failures",
        severity: "error",
        message: `${recentFailures} uncertain provider outcomes in the last hour. Investigate before further publishing.`,
      });
    const drift = await this.prisma.$queryRaw<
      Array<{ count: bigint }>
    >`SELECT COUNT(*)::bigint AS count FROM "IntegrationUsageReservation" WHERE month=${integrationMonth(now)} AND "chargedMicros">"reservedMicros"`;
    if (Number(drift[0].count))
      conditions.push({
        key: "price-drift",
        severity: "error",
        message:
          "Reconciled provider charges exceed reserved estimates. Pause spending and verify the price catalog.",
      });
    const changed = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('integration-monitor'))`;
      const opened: IntegrationAlertCondition[] = [];
      for (const c of conditions) {
        const prior = await tx.integrationOperationalAlert.findUnique({
          where: { key: c.key },
        });
        if (
          !prior ||
          prior.resolvedAt ||
          (prior.severity !== c.severity && c.severity === "error")
        )
          opened.push(c);
        await tx.integrationOperationalAlert.upsert({
          where: { key: c.key },
          create: { ...c, openedAt: now, observedAt: now },
          update: {
            ...c,
            observedAt: now,
            resolvedAt: null,
            ...(prior?.resolvedAt ? { openedAt: now } : {}),
          },
        });
      }
      await tx.integrationOperationalAlert.updateMany({
        where: {
          resolvedAt: null,
          key: { notIn: conditions.map((c) => c.key) },
        },
        data: { resolvedAt: now },
      });
      return opened;
    });
    for (const alert of changed) {
      this.logger.warn(`[${alert.key}] ${alert.message}`);
      Sentry.captureMessage(alert.message, {
        level: alert.severity,
        tags: { area: "integrations", condition: alert.key },
        fingerprint: ["integrations", alert.key],
      });
    }
    await this.snapshots.prune();
  }

  /**
   * A refunded crosspost with no remote id is a finished rejection. Text-only
   * holds from that path used to stay `uncertain` after the member was refunded.
   */
  private async releaseRefundedCrosspostHolds(): Promise<void> {
    const held = await this.prisma.integrationUsageReservation.findMany({
      where: {
        status: { in: ["reserved", "uncertain"] },
        id: { startsWith: "x:post:" },
      },
      select: { id: true },
      take: 100,
    });
    const keys = held.flatMap((row) => {
      const match = /^x:post:([^:]+)$/.exec(row.id);
      return match ? [{ id: row.id, localId: match[1] }] : [];
    });
    if (!keys.length) return;
    const refunded = await this.prisma.xCrosspost.findMany({
      where: {
        kind: "post",
        localId: { in: keys.map((key) => key.localId) },
        remoteId: null,
        refundedAt: { not: null },
      },
      select: { localId: true },
    });
    const localIds = refunded.map((row) => row.localId);
    if (!localIds.length) return;
    const withMedia = await this.prisma.postMedia.findMany({
      where: { postId: { in: localIds }, deletedAt: null },
      select: { postId: true },
    });
    const mediaPosts = new Set(withMedia.map((row) => row.postId));
    const ids = keys
      .filter(
        (key) => localIds.includes(key.localId) && !mediaPosts.has(key.localId),
      )
      .map((key) => key.id);
    if (!ids.length) return;
    await this.prisma.integrationUsageReservation.updateMany({
      where: { id: { in: ids }, status: { in: ["reserved", "uncertain"] } },
      data: { status: "released", chargedMicros: 0 },
    });
  }
}
