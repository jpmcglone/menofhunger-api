import type {
  IntegrationSpendDiagnosticsDto,
  IntegrationOperationsDto,
  IntegrationSpendControlDto,
  IntegrationReconciliationResultDto,
} from "../../common/dto/integrations.dto";
import { ConflictException, Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { AppConfigService } from "../app/app-config.service";
import { integrationMonth } from "./integration-budget.policy";

type SpendControlPatch = Omit<IntegrationSpendControlDto, "revision">;

@Injectable()
export class IntegrationAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
  ) {}

  async operations(): Promise<IntegrationOperationsDto> {
    const [control, alerts, changes] = await Promise.all([
      this.prisma.integrationSpendControl.findUnique({
        where: { id: "global" },
      }),
      this.prisma.integrationOperationalAlert.findMany({
        where: { resolvedAt: null },
        orderBy: { openedAt: "asc" },
        take: 30,
      }),
      this.prisma.integrationControlAudit.findMany({
        orderBy: { createdAt: "desc" },
        take: 20,
        select: {
          id: true,
          adminUserId: true,
          revision: true,
          reason: true,
          createdAt: true,
        },
      }),
    ]);
    return {
      control: control
        ? this.controlDto(control)
        : {
            revision: 0,
            paused: false,
            companyMonthlyMicros: null,
            companyDailyMicros: null,
            xMonthlyMicros: null,
            reserveMonthlyMicros: null,
          },
      alerts: alerts.map(
        ({ key, severity, message, openedAt, observedAt }) => ({
          key,
          severity,
          message,
          openedAt: openedAt.toISOString(),
          observedAt: observedAt.toISOString(),
        }),
      ),
      changes: changes.map((row) => ({
        ...row,
        createdAt: row.createdAt.toISOString(),
      })),
    };
  }

  updateControls(
    adminUserId: string,
    input: { expectedRevision: number; reason: string } & SpendControlPatch,
  ): Promise<IntegrationSpendControlDto> {
    const { expectedRevision, reason, ...patch } = input;
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('integration-spend'))`;
      const old = await tx.integrationSpendControl.findUnique({
        where: { id: "global" },
      });
      if ((old?.revision ?? 0) !== expectedRevision)
        throw new ConflictException(
          "Spending controls changed. Reload before saving.",
        );
      const policy = this.config.integrationBudget("reserve");
      for (const [value, maximum] of [
        [patch.companyMonthlyMicros, policy.companyMonthlyMicros],
        [patch.companyDailyMicros, policy.companyDailyMicros],
        [patch.xMonthlyMicros, policy.providerMonthlyMicros],
        [patch.reserveMonthlyMicros, policy.sharedMonthlyMicros],
      ]) {
        if (value !== null && value > maximum!)
          throw new ConflictException(
            "A control cannot exceed its configured ceiling.",
          );
      }
      const next = await tx.integrationSpendControl.upsert({
        where: { id: "global" },
        create: { id: "global", ...patch, revision: 1 },
        update: { ...patch, revision: expectedRevision + 1 },
      });
      await tx.integrationControlAudit.create({
        data: {
          adminUserId,
          revision: next.revision,
          reason,
          before: old ? this.controlDto(old) : {},
          after: this.controlDto(next),
        },
      });
      return this.controlDto(next);
    });
  }

  async spend(month?: string): Promise<IntegrationSpendDiagnosticsDto> {
    const period = month
      ? new Date(`${month}-01T00:00:00.000Z`)
      : integrationMonth(new Date());
    const groups = await this.prisma.integrationUsageReservation.groupBy({
      by: ["provider", "bucket", "status", "priceVersion"],
      where: { month: period },
      _sum: {
        reservedMicros: true,
        chargedMicros: true,
        publicationCount: true,
      },
      _count: { id: true },
    });
    const pending = await this.prisma.integrationUsageReservation.findMany({
      where: { status: { in: ["reserved", "uncertain"] } },
      orderBy: { createdAt: "asc" },
      take: 100,
      select: {
        id: true,
        userId: true,
        provider: true,
        action: true,
        bucket: true,
        status: true,
        reservedMicros: true,
        chargedMicros: true,
        createdAt: true,
        priceVersion: true,
      },
    });
    const policy = this.config.integrationBudget("reserve");
    return {
      month: period.toISOString(),
      groups: groups.map((group) => ({
        provider: group.provider,
        bucket: group.bucket,
        status: group.status,
        priceVersion: group.priceVersion,
        reservedMicros: group._sum.reservedMicros ?? 0,
        chargedMicros: group._sum.chargedMicros ?? 0,
        publicationCount: group._sum.publicationCount ?? 0,
        operationCount: group._count.id,
      })),
      pending: pending.map((row) => ({
        ...row,
        createdAt: row.createdAt.toISOString(),
      })),
      limits: {
        enabled: policy.enabled,
        companyMonthlyMicros: policy.companyMonthlyMicros,
        companyDailyMicros: policy.companyDailyMicros,
        xMonthlyMicros: policy.providerMonthlyMicros,
        fundedReserveMicros: policy.sharedMonthlyMicros,
        removalHeadroomMicros: policy.removalHeadroomMicros ?? 0,
      },
    };
  }

  reconcile(
    adminUserId: string,
    id: string,
    input: {
      status: "settled" | "released";
      chargedMicros: number;
      expectedStatus: "reserved" | "uncertain" | "settled" | "released";
      evidence: string;
    },
  ): Promise<IntegrationReconciliationResultDto> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('integration-spend'))`;
      const row = await tx.integrationUsageReservation.findUnique({
        where: { id },
      });
      if (!row || row.status !== input.expectedStatus)
        throw new ConflictException(
          "The reservation changed. Reload it before reconciling.",
        );
      await tx.integrationReconciliation.create({
        data: {
          operationId: id,
          adminUserId,
          previousStatus: row.status,
          previousChargedMicros: row.chargedMicros,
          status: input.status,
          chargedMicros: input.chargedMicros,
          evidence: input.evidence,
        },
      });
      await tx.integrationUsageReservation.update({
        where: { id },
        data: { status: input.status, chargedMicros: input.chargedMicros },
      });
      return { id, status: input.status, chargedMicros: input.chargedMicros };
    });
  }

  private controlDto(
    value: IntegrationSpendControlDto,
  ): IntegrationSpendControlDto {
    const {
      revision,
      paused,
      companyMonthlyMicros,
      companyDailyMicros,
      xMonthlyMicros,
      reserveMonthlyMicros,
    } = value;
    return {
      revision,
      paused,
      companyMonthlyMicros,
      companyDailyMicros,
      xMonthlyMicros,
      reserveMonthlyMicros,
    };
  }
}
