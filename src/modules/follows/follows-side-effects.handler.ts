import { NotificationFollowPolicyService } from "../notifications";
import { NotificationCleanupService } from "../notifications/notification-cleanup.service";
import { NotificationCreatorService } from "../notifications/notification-creator.service";
import { Injectable, type OnModuleInit, Inject } from "@nestjs/common";
import type { SideEffectPayloads } from "../side-effects/side-effects.constants";
import { SideEffectsRegistry } from "../side-effects/side-effects.registry";

/** Don't re-notify the same person about the same follower more than once a day. */
const FOLLOW_NOTIFY_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Follow / unfollow notification bookkeeping.
 *
 * The 24h de-dupe window lives here rather than at the call site so that a retried job can't
 * produce a second "followed you" row, and so an unfollow-refollow loop can't be used to spam
 * someone's bell.
 */
@Injectable()
export class FollowsSideEffectsHandler implements OnModuleInit {
  constructor(
    @Inject(NotificationFollowPolicyService)
    private readonly notificationFollowPolicyService: Pick<
      NotificationFollowPolicyService,
      "hasRecentFollowNotification"
    >,
    @Inject(NotificationCleanupService)
    private readonly notificationCleanupService: Pick<
      NotificationCleanupService,
      "deleteFollowNotification"
    >,
    @Inject(NotificationCreatorService)
    private readonly notificationCreatorService: Pick<
      NotificationCreatorService,
      "create"
    >,
    private readonly registry: SideEffectsRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register("follow.created", (p) => this.onFollowCreated(p));
    this.registry.register("follow.removed", (p) => this.onFollowRemoved(p));
  }

  private async onFollowCreated(
    payload: SideEffectPayloads["follow.created"],
  ): Promise<void> {
    const alreadyNotified =
      await this.notificationFollowPolicyService.hasRecentFollowNotification(
        payload.targetUserId,
        payload.actorUserId,
        FOLLOW_NOTIFY_WINDOW_MS,
      );
    if (alreadyNotified) return;

    await this.notificationCreatorService.create({
      recipientUserId: payload.targetUserId,
      kind: "follow",
      actorUserId: payload.actorUserId,
      subjectUserId: payload.actorUserId,
      title: "followed you",
    });
  }

  private async onFollowRemoved(
    payload: SideEffectPayloads["follow.removed"],
  ): Promise<void> {
    await this.notificationCleanupService.deleteFollowNotification(
      payload.targetUserId,
      payload.actorUserId,
    );
  }
}
