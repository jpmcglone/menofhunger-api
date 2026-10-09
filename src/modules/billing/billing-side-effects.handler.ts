import { NotificationWriterFanoutService } from "../notifications";
import { NotificationCreatorService } from "../notifications/notification-creator.service";
import { Injectable, type OnModuleInit, Inject } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import type { SideEffectPayloads } from "../side-effects/side-effects.constants";
import { SideEffectsRegistry } from "../side-effects/side-effects.registry";
import { SideEffectsService } from "../side-effects/side-effects.service";
import { BillingService } from "./billing.service";
import { ReferralService } from "./referral.service";
import { USER_BRIEF_SELECT } from "../../common/prisma-selects/user.select";

/**
 * Billing side effects: sends a bell notification when the user's premium access
 * crosses the none <-> premium boundary, and syncs Stripe trial windows after a
 * referral bonus is granted so the free month actually defers the next charge.
 *
 * The handler re-reads current DB state before writing so a delayed retry is safe:
 * if the DB already reflects the *opposite* of `direction`, the write is skipped.
 *
 * On `direction: 'started'`, also dispatches `marv.premium.welcome` so Marv can
 * send its one-shot welcome DM without Billing importing Messages/Marv.
 */
@Injectable()
export class BillingSideEffectsHandler implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(NotificationWriterFanoutService)
    private readonly notificationWriterFanoutService: Pick<
      NotificationWriterFanoutService,
      "upsertPremiumStatusNotification"
    >,
    @Inject(NotificationCreatorService)
    private readonly notificationCreatorService: Pick<
      NotificationCreatorService,
      "create"
    >,
    private readonly registry: SideEffectsRegistry,
    private readonly billing: BillingService,
    private readonly sideEffects: SideEffectsService,
    private readonly referral: ReferralService,
  ) {}

  onModuleInit(): void {
    this.registry.register("billing.premium.changed", (p) =>
      this.onPremiumChanged(p),
    );
    this.registry.register("referral.bonus.granted", (p) =>
      this.onReferralBonusGranted(p),
    );
    this.registry.register("referral.verified", (p) =>
      this.onReferralVerified(p),
    );
  }

  private async onPremiumChanged(
    payload: SideEffectPayloads["billing.premium.changed"],
  ): Promise<void> {
    const { userId, direction } = payload;

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { premium: true, premiumPlus: true },
    });
    if (!user) return;

    // Idempotency guard: skip if current state contradicts the direction.
    // e.g. direction='started' but user.premium is now false means the user
    // has already lost premium again — don't send a stale "you're premium" bell.
    if (direction === "started" && !user.premium) return;
    if (direction === "ended" && user.premium) return;

    await this.notificationWriterFanoutService.upsertPremiumStatusNotification({
      recipientUserId: userId,
      kind: direction === "started" ? "premium_started" : "premium_ended",
      isPremiumPlus: user.premiumPlus,
    });

    if (direction === "started") {
      this.sideEffects.dispatch("marv.premium.welcome", { userId });
    }
  }

  /**
   * Sync Stripe trial windows for both the recruit and the recruiter so the
   * referral grant actually defers their next Stripe charge.
   * Best-effort and idempotent — syncGrantTrialToSubscription is a no-op when the
   * user has no active Stripe subscription.
   */
  private async onReferralBonusGranted(
    payload: SideEffectPayloads["referral.bonus.granted"],
  ): Promise<void> {
    const { recruitId, recruiterId } = payload;
    await this.billing.syncGrantTrialToSubscription(recruiterId);
    await this.billing.syncGrantTrialToSubscription(recruitId);
    await this.notifyReferralBonus(recruitId, recruiterId);
  }

  /** Tells both men about the free month. Re-reads names so a delayed retry stays current. */
  private async notifyReferralBonus(
    recruitId: string,
    recruiterId: string,
  ): Promise<void> {
    const people = await this.prisma.user.findMany({
      where: { id: { in: [recruitId, recruiterId] } },
      select: USER_BRIEF_SELECT,
    });
    const label = (id: string) => {
      const person = people.find((p) => p.id === id);
      return (
        person?.name?.trim() ||
        (person?.username ? `@${person.username}` : "Your friend")
      );
    };
    await this.notificationCreatorService.create({
      recipientUserId: recruiterId,
      kind: "generic",
      subjectUserId: recruitId,
      title: `${label(recruitId)} verified. You both got a free month`,
      body: "A free month of Premium is on your account.",
    });
    await this.notificationCreatorService.create({
      recipientUserId: recruitId,
      kind: "generic",
      subjectUserId: recruiterId,
      title: "Welcome. You got a free month of Premium",
      body: `You and ${label(recruiterId)} both got a free month.`,
    });
  }

  private async onReferralVerified(
    payload: SideEffectPayloads["referral.verified"],
  ): Promise<void> {
    await this.referral.onMemberVerified(payload.userId);
  }
}
