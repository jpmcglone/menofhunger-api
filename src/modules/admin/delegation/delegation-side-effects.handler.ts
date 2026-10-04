import { Injectable, OnModuleInit } from "@nestjs/common";
import { createHash } from "node:crypto";
import { PrismaService } from "../../prisma/prisma.service";
import { SideEffectsRegistry } from "../../side-effects/side-effects.registry";
import { NotificationsService } from "../../notifications/notifications.service";
import { RedisService } from "../../redis/redis.service";
import { scheduleSchema } from "./delegation.schemas";

/** Notification authorization is captured when a run is created. Never backfill it
 * from today's job settings: legacy runs and superseded work must remain quiet. */
export function canNotifyDelegationRun(run: {
  jobSnapshot: unknown;
  job: { revision: number; status: string };
}): boolean {
  const snapshot = run.jobSnapshot as {
    revision?: number;
    schedule?: { notification?: string };
  } | null;
  return (
    run.job.status !== "cancelled" &&
    snapshot?.revision === run.job.revision &&
    ["actionable", "all", "digest"].includes(
      snapshot?.schedule?.notification ?? "none",
    )
  );
}

@Injectable()
export class DelegationSideEffectsHandler implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: SideEffectsRegistry,
    private readonly notifications: NotificationsService,
    private readonly redis: RedisService,
  ) {}
  onModuleInit() {
    this.registry.register("delegation.result", (p) => this.deliver(p.runId));
  }
  async deliver(runId: string) {
    const owner = await this.prisma.delegationRun.findUnique({
      where: { id: runId },
      select: { job: { select: { ownerId: true } } },
    });
    if (!owner) return;
    await this.redis.withLock(
      `delegation-delivery:${owner.job.ownerId}`,
      { ttlMs: 30000 },
      async () => {
        const run = await this.prisma.delegationRun.findUnique({
          where: { id: runId },
          include: {
            job: {
              include: {
                owner: { select: { siteAdmin: true, bannedAt: true } },
              },
            },
          },
        });
        if (
          !run ||
          !["review", "failed", "uncertain", "complete"].includes(run.status)
        )
          return;

        const mode =
          scheduleSchema.parse(run.job.schedule).notification ?? "none";
        const actionable = ["review", "failed", "uncertain"].includes(
          run.status,
        );
        const key = `${run.id}-${run.status}`;
        if (
          run.notificationKey === key ||
          (mode === "digest" && run.notifiedAt)
        )
          return;
        if (
          !canNotifyDelegationRun(run) ||
          !run.job.owner.siteAdmin ||
          run.job.owner.bannedAt ||
          mode === "none" ||
          (mode === "actionable" && !actionable)
        ) {
          await this.prisma.delegationRun.update({
            where: { id: runId },
            data: { notifiedAt: new Date(), notificationKey: key },
          });
          return;
        }
        if (mode === "digest" || (!actionable && mode !== "all")) {
          // Deliver routine work in the next 09:00 Eastern digest, rather than once per run.
          const local = new Intl.DateTimeFormat("en-CA", {
            timeZone: "America/New_York",
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            hourCycle: "h23",
          }).formatToParts(new Date());
          const parts = Object.fromEntries(local.map((p) => [p.type, p.value]));
          if (Number(parts.hour) !== 9) return;
          const cutoff = new Date();
          cutoff.setUTCMinutes(0, 0, 0);
          const batch = await this.prisma.delegationRun.findMany({
            where: {
              job: {
                ownerId: run.job.ownerId,
                schedule: { path: ["notification"], equals: "digest" },
              },
              notifiedAt: null,
              createdAt: { lte: cutoff },
              status: { in: ["review", "failed", "uncertain", "complete"] },
            },
            take: 100,
            orderBy: { createdAt: "asc" },
            include: { job: true },
          });
          const rows = batch.filter(
            (r) =>
              canNotifyDelegationRun(r) &&
              (scheduleSchema.parse(r.job.schedule).notification ?? "none") ===
                "digest",
          );
          if (!rows.length) return;
          const digestKey = `delegation-digest-${run.job.ownerId}-${parts.year}-${parts.month}-${parts.day}`;
          await this.notifications.create({
            id: createHash("sha256").update(digestKey).digest("hex"),
            recipientUserId: run.job.ownerId,
            kind: "generic",
            title: "Your MARV work digest is ready",
            body: "Review completed work and any actions waiting for you.",
            actionPath: "/admin/delegation",
          });
          await this.prisma.delegationRun.updateMany({
            where: { id: { in: rows.map((r) => r.id) } },
            data: { notifiedAt: new Date(), notificationKey: digestKey },
          });
          return;
        }
        const title =
          run.status === "review"
            ? "MARV has actions for your review"
            : run.status === "failed"
              ? "MARV could not finish a job"
              : run.status === "uncertain"
                ? "Check the result of a MARV action"
                : "MARV finished your job";
        await this.notifications.create({
          id: createHash("sha256").update(key).digest("hex"),
          recipientUserId: run.job.ownerId,
          kind: "generic",
          title,
          body: "Open Delegated work to see the result and next steps.",
          actionPath: `/admin/delegation/${run.jobId}`,
        });
        await this.prisma.delegationRun.update({
          where: { id: runId },
          data: { notifiedAt: new Date(), notificationKey: key },
        });
      },
    );
  }
}
