import { Injectable, NotFoundException } from "@nestjs/common";
import { z } from "zod";
import { AppConfigService } from "../app/app-config.service";
import { PrismaService } from "../prisma/prisma.service";
import { EntitlementService } from "./entitlement.service";
import { BillingService } from "./billing.service";

export const LOCAL_BILLING_ACCOUNT = {
  id: "local-storekit-tester",
  username: "storekit_tester",
  phone: "+15550000991",
} as const;
const snapshotSchema = z
  .object({
    entitlements: z
      .array(
        z
          .object({
            productId: z.enum([
              "com.menofhunger.premium.monthly",
              "com.menofhunger.premiumplus.monthly",
            ]),
            expiresAt: z.string().datetime(),
          })
          .strict(),
      )
      .max(2),
  })
  .strict();

/** Simulation only. Never accepts receipts or changes Apple's subscription records. */
@Injectable()
export class LocalBillingTestService {
  constructor(
    private readonly config: AppConfigService,
    private readonly prisma: PrismaService,
    private readonly entitlements: EntitlementService,
    private readonly billing: BillingService,
  ) {}

  async sync(userId: string, remoteAddress: string | undefined, body: unknown) {
    if (
      !this.config.localBillingTestsEnabled() ||
      !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remoteAddress ?? "") ||
      userId !== LOCAL_BILLING_ACCOUNT.id
    )
      throw new NotFoundException();
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (
      !user ||
      user.username !== LOCAL_BILLING_ACCOUNT.username ||
      user.phone !== LOCAL_BILLING_ACCOUNT.phone ||
      user.accountKind !== "person" ||
      user.verifiedStatus === "none"
    )
      throw new NotFoundException();
    const { entitlements } = snapshotSchema.parse(body);
    const now = new Date();
    const active = entitlements
      .filter((item) => new Date(item.expiresAt) > now)
      .sort(
        (a, b) =>
          Number(b.productId.includes("premiumplus")) -
            Number(a.productId.includes("premiumplus")) ||
          new Date(b.expiresAt).getTime() - new Date(a.expiresAt).getTime(),
      )[0];
    const id = `local-storekit:${userId}`;
    if (active) {
      // Bound even deliberately fabricated fixture inputs. No financial/referral credit.
      const endsAt = new Date(
        Math.min(
          new Date(active.expiresAt).getTime(),
          now.getTime() + 32 * 86400000,
        ),
      );
      const data = {
        tier: active.productId.includes("premiumplus")
          ? ("premiumPlus" as const)
          : ("premium" as const),
        startsAt: now,
        endsAt,
        revokedAt: null,
        reason:
          "SIMULATED local Xcode StoreKit entitlement — not Apple verified",
      };
      await this.prisma.subscriptionGrant.upsert({
        where: { id },
        update: data,
        create: { id, userId, source: "admin", months: 0, ...data },
      });
    } else {
      await this.prisma.subscriptionGrant.updateMany({
        where: { id, userId },
        data: { revokedAt: now },
      });
    }
    await this.entitlements.recomputeAndApply(userId);
    return { data: await this.billing.getMe(userId) };
  }
}
