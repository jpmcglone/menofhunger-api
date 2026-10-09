import { Injectable } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { PrismaService } from "../prisma/prisma.service";
import { AppConfigService } from "../app/app-config.service";
import { SideEffectsService } from "../side-effects/side-effects.service";

@Injectable()
export class EmailLifecycleCron {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
    private readonly effects: SideEffectsService,
  ) {}

  /** Only upcoming grant expiries, never past expiries or an established-user welcome sweep. */
  @Cron("23 * * * *")
  async remindExpiringGrants(): Promise<void> {
    if (!this.config.runSchedulers() || !this.config.email()) return;
    const now = new Date();
    let cursor: string | undefined;
    for (;;) {
      const grants = await this.prisma.subscriptionGrant.findMany({
        where: {
          revokedAt: null,
          startsAt: { lte: now },
          endsAt: {
            gt: new Date(now.getTime() + 48 * 3600000),
            lte: new Date(now.getTime() + 72 * 3600000),
          },
          ...(cursor ? { id: { gt: cursor } } : {}),
        },
        select: { id: true, userId: true, endsAt: true },
        orderBy: { id: "asc" },
        take: 200,
      });
      if (!grants.length) return;
      cursor = grants[grants.length - 1]!.id;
      for (const grant of grants)
        this.effects.dispatch("email.lifecycle", {
          kind: "grantExpiring",
          userId: grant.userId,
          grantId: grant.id,
          eventId: `grant-expiring-${grant.id}-${grant.endsAt.toISOString()}`,
          occurredAt: now.toISOString(),
        });
    }
  }
}
