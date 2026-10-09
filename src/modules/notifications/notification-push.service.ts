import type { AvatarVideoDto } from '../../common/dto/avatar-video.dto';
import { Injectable, Logger } from '@nestjs/common';
import type { NotificationKind } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfigService } from '../app/app-config.service';
import { PresenceService } from '../presence/presence.service';
import { publicAssetUrl } from '../../common/assets/public-asset-url';
import { NotificationPreferencesService } from './notification-preferences.service';
import { ApnsPushService } from './apns-push.service';
import { crewStreakBrokenPushBody } from './crew-streak-broken-copy';
import { NotificationPushDeliveryService } from './notification-push-delivery.service';
import { NotificationPushKindService } from './notification-push-kind.service';
import { actorDisplayName, trimPushBody } from './notification-push-copy';
export type { PushActorContext } from './notification-push.constants';

/**
 * Web Push delivery: subscription management, VAPID setup, per-kind copy,
 * coalescing, and the system-originated pushes (crew streaks, reply nudges, DMs).
 */
@Injectable()
export class NotificationPushService {
  private readonly logger = new Logger(NotificationPushService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly appConfig: AppConfigService,
    private readonly presence: PresenceService,
    private readonly preferences: NotificationPreferencesService,
    private readonly apnsPush: ApnsPushService,
    private readonly delivery: NotificationPushDeliveryService,
    private readonly kindPush: NotificationPushKindService,
  ) {}

  /** Upsert push subscription for a user (idempotent). */
  async pushSubscribe(
    userId: string,
    params: { endpoint: string; keys: { p256dh: string; auth: string }; userAgent?: string | null },
  ): Promise<void> {
    const { endpoint, keys, userAgent } = params;
    const endpointTrim = (endpoint ?? '').trim();
    const p256dh = (keys?.p256dh ?? '').trim();
    const auth = (keys?.auth ?? '').trim();
    if (!endpointTrim || !p256dh || !auth) return;

    // If another user previously registered this endpoint (e.g. user switched without a clean logout),
    // remove their stale binding so they stop receiving this device's push notifications.
    await this.prisma.pushSubscription.deleteMany({
      where: { endpoint: endpointTrim, NOT: { userId } },
    });

    await this.prisma.pushSubscription.upsert({
      where: {
        userId_endpoint: { userId, endpoint: endpointTrim },
      },
      create: {
        userId,
        endpoint: endpointTrim,
        p256dh,
        auth,
        userAgent: userAgent?.trim() || undefined,
      },
      update: {
        p256dh,
        auth,
        userAgent: userAgent?.trim() || undefined,
      },
    });
  }

  /** Remove push subscription by endpoint (current user only). */
  async pushUnsubscribe(userId: string, endpoint: string): Promise<void> {
    const endpointTrim = (endpoint ?? '').trim();
    if (!endpointTrim) return;

    await this.prisma.pushSubscription.deleteMany({
      where: { userId, endpoint: endpointTrim },
    });
  }

  /** Send a single test push (Web Push and/or APNs) to the user (for "Send test notification" in settings). */
  async sendTestPush(userId: string): Promise<{ sent: boolean; message?: string }> {
    if (!this.delivery.pushChannelConfigured()) {
      return { sent: false, message: 'Push notifications are not configured on this server.' };
    }
    const subCount = await this.prisma.pushSubscription.count({ where: { userId } });
    const hasApnsTokens = await this.apnsPush.hasTokens(userId);
    if (subCount === 0 && !hasApnsTokens) {
      return { sent: false, message: 'No push subscription for this account. Enable notifications first.' };
    }
    await this.sendWebPushToRecipient(userId, {
      title: 'Test web push',
      body: 'Web Push is working.',
      subjectPostId: null,
      test: true,
    });
    return { sent: true };
  }

  /**
   * Send a push to all of the user's registered channels: Web Push subscriptions
   * (pruning expired 410/404) and native APNs device tokens. Coalescing is shared
   * across both channels, keyed by the resolved push tag so distinct subjects each
   * have their own window.
   *
   * Always deliver to registered devices. A connected/recently active socket does
   * not prove a browser window is focused; the service worker owns that decision.
   */
  async sendWebPushToRecipient(
    recipientUserId: string,
    params: {
      title: string;
      body?: string;
      notificationId?: string | null;
      subjectPostId?: string | null;
      subjectUserId?: string | null;
      test?: boolean;
      url?: string | null;
      tag?: string | null;
      icon?: string | null;
      badge?: string | null;
      renotify?: boolean;
      kind?: string;
      sourceLabel?: string;
      subtitle?: string | null;
      threadId?: string | null;
      category?: string | null;
      avatarUrl?: string | null; avatarVideo?: AvatarVideoDto | null;
      mediaUrl?: string | null;
      actorUsername?: string | null;
      actorName?: string | null;
      groupInviteId?: string | null;
      postId?: string | null;
      actorUserId?: string | null;
      canDeliver?: () => Promise<boolean>;
    },
  ) {
    return this.delivery.sendWebPushToRecipient(recipientUserId, params);
  }
  /**
   * Send a single "still waiting on you" push for an unread reply notification.
   * The cron is responsible for selecting eligible notifications and stamping `nudgedBackAt`
   * so this method never re-fires for the same notification.
   *
   * Spare on purpose: title carries the actor's name, no body. The whole point is "John still cares."
   */
  async sendReplyNudgePush(params: {
    recipientUserId: string;
    actorUserId: string;
    notificationId: string;
    actorPostId: string | null;
    /** Optional snippet of the original reply, stored on Notification.body. */
    bodySnippet?: string | null;
  }): Promise<void> {
    if (!this.delivery.pushChannelConfigured()) return;
    try {
      const prefs = await this.preferences.getPreferencesInternal(params.recipientUserId);
      if (!prefs.pushReplyNudge) return;
    } catch {
      // Best-effort: if prefs read fails, default to sending.
    }
    const actor = await this.delivery.getActorMini(params.actorUserId);
    if (!actor) return;
    const actorName = actorDisplayName(actor);
    const publicBaseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;
    const icon = publicAssetUrl({
      publicBaseUrl,
      key: actor.avatarKey,
      updatedAt: actor.avatarUpdatedAt,
    });
    const url = params.actorPostId ? `/p/${params.actorPostId}` : '/notifications';
    const snippet = trimPushBody(params.bodySnippet, 120);
    await this.sendWebPushToRecipient(params.recipientUserId, {
      title: `${actorName} is still waiting to hear back`,
      // Replay the original reply text if we have it; otherwise the title carries the whole signal.
      body: snippet ?? '',
      url,
      tag: `reply-nudge-${params.notificationId}`,
      icon,
      badge: '/android-chrome-192x192.png',
      renotify: false,
      kind: 'reply_nudge',
      // Communication UI replaces title with the sender name — keep the "waiting" cue visible.
      subtitle: 'Still waiting to hear back',
      avatarUrl: icon,
      actorUsername: actor.username,
      actorName: actor.name,
    });
  }

  /**
   * Push every member of a crew when the strict crew streak advances. This is the
   * positive-feedback half of the crew-streak push pair. Per the design simplicity
   * skill we do not also send a "you posted today" confirmation — only the streak
   * milestone itself is a withdrawal worth making.
   */
  async sendCrewStreakAdvancedPush(params: {
    recipientUserIds: string[];
    crewId: string;
    crewSlug: string | null;
    crewName: string | null;
    currentStreakDays: number;
    memberCount: number;
  }): Promise<void> {
    if (!this.delivery.pushChannelConfigured()) return;
    const { currentStreakDays, memberCount } = params;
    if (currentStreakDays <= 0 || params.recipientUserIds.length === 0) return;

    const url = params.crewSlug ? `/c/${encodeURIComponent(params.crewSlug)}` : '/crew';
    const crewLabel = (params.crewName ?? '').trim() || 'Your crew';
    const allClause = memberCount > 0 ? ` All ${memberCount} of you locked it in.` : '';
    const title = `${crewLabel}: ${currentStreakDays}-day streak`;
    const body = `${currentStreakDays === 1 ? 'Day 1 on the board.' : `Day ${currentStreakDays} in a row.`}${allClause}`;
    const tag = `crew-streak-advanced-${params.crewId}-${currentStreakDays}`;

    for (const recipientUserId of params.recipientUserIds) {
      try {
        const prefs = await this.preferences.getPreferencesInternal(recipientUserId);
        if (!prefs.pushCrewStreak) continue;
      } catch {
        // Best effort: if prefs read fails, default to sending.
      }
      try {
        await this.sendWebPushToRecipient(recipientUserId, {
          title,
          body,
          url,
          tag,
          renotify: false,
          kind: 'crew_streak_advanced',
        });
      } catch (err) {
        this.logger.warn(`[push] Failed to send crew-streak-advanced push: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /**
   * Push every member of a crew the morning after a streak breaks. This is the
   * single most behaviorally potent push in the product — it names who didn't
   * check in, which converts to "I won't be the one who broke it next time."
   */
  async sendCrewStreakBrokenPush(params: {
    recipientUserIds: string[];
    crewId: string;
    crewSlug: string | null;
    crewName: string | null;
    missedMembers: Array<{ id: string; displayName: string | null; username: string | null }>;
  }): Promise<void> {
    if (!this.delivery.pushChannelConfigured()) return;
    if (params.recipientUserIds.length === 0) return;

    const url = params.crewSlug ? `/c/${encodeURIComponent(params.crewSlug)}` : '/crew';
    const crewLabel = (params.crewName ?? '').trim() || 'Your crew';
    const title = 'You lost the streak.';
    const tag = `crew-streak-broken-${params.crewId}`;

    for (const recipientUserId of params.recipientUserIds) {
      try {
        const prefs = await this.preferences.getPreferencesInternal(recipientUserId);
        if (!prefs.pushCrewStreak) continue;
      } catch {
        // Best effort: default to sending if prefs read fails.
      }

      const body = crewStreakBrokenPushBody({
        crewLabel,
        recipientUserId,
        missedMembers: params.missedMembers,
      });

      try {
        await this.sendWebPushToRecipient(recipientUserId, {
          title,
          body,
          url,
          tag,
          renotify: false,
          kind: 'crew_streak_broken',
        });
      } catch (err) {
        this.logger.warn(`[push] Failed to send crew-streak-broken push: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  async sendMessagePush(params: {
    recipientUserId: string;
    senderUserId: string;
    senderName: string;
    body?: string | null;
    conversationId: string;
    /** Direct-call rows: the ring reaches iPhones via PushKit/CallKit, so the DM alert would double up. */
    skipIfVoipRegistered?: boolean;
  }): Promise<void> {
    try {
      const prefs = await this.preferences.getPreferencesInternal(params.recipientUserId);
      if (!prefs.pushMessage) return;
    } catch {
      // Best-effort: if prefs read fails, still attempt push (default behavior).
    }
    if (params.skipIfVoipRegistered && (await this.apnsPush.hasVoipToken(params.recipientUserId).catch(() => false))) {
      return;
    }
    if (this.presence.isUserViewingConversation(params.recipientUserId, params.conversationId)) {
      this.logger.debug(
        `[push] Skipping DM push — recipient ${params.recipientUserId} is viewing conversation ${params.conversationId}`,
      );
      return;
    }
    const sender = (params.senderName ?? '').trim();
    const title = sender ? `New message from ${sender}` : 'New message';
    const body = trimPushBody(params.body, 150) ?? 'Open chat to read the message.';
    const url = `/chat?c=${encodeURIComponent(params.conversationId)}`;
    const tag = `message-conversation-${params.conversationId}`;
    const senderUser = await this.delivery.getActorMini(params.senderUserId);
    const publicBaseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;
    const icon = senderUser
      ? publicAssetUrl({
          publicBaseUrl,
          key: senderUser.avatarKey,
          updatedAt: senderUser.avatarUpdatedAt,
        })
      : null;
    try {
      await this.sendWebPushToRecipient(params.recipientUserId, {
        title,
        body,
        url,
        tag,
        icon,
        badge: '/android-chrome-192x192.png',
        renotify: true,
        kind: 'message',
        avatarUrl: icon,
        actorUsername: senderUser?.username ?? null,
        actorName: senderUser?.name ?? null,
        actorUserId: params.senderUserId,
      });
    } catch (err) {
      this.logger.warn(`[push] Failed to send DM web push: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Standard actor-driven push for a notification kind: checks prefs, loads the
   * actor plus current post/group context for rich APNs fields, and sends. Used
   * by the writer after creating rows.
   */
  async sendKindPushForActor(params: {
    recipientUserId: string;
    kind: NotificationKind;
    actorUserId: string | null;
    fallbackTitle?: string | null;
    body?: string | null;
    actorPostId?: string | null;
    subjectArticleId?: string | null;
    subjectPostId?: string | null;
    subjectUserId?: string | null;
    subjectGroupId?: string | null;
    subjectCommunityGroupInviteId?: string | null;
    url?: string | null;
    notificationId?: string | null;
    sourceLabel?: string;
  }) {
    return this.kindPush.sendKindPushForActor(params);
  }
}
