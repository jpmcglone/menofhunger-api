import { Injectable, Logger } from '@nestjs/common';
import type { NotificationKind } from '@prisma/client';
import * as webpush from 'web-push';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfigService } from '../app/app-config.service';
import { PresenceService } from '../presence/presence.service';
import { CacheService } from '../redis/cache.service';
import { RedisKeys } from '../redis/redis-keys';
import { CacheTtl } from '../redis/cache-ttl';
import { publicAssetUrl } from '../../common/assets/public-asset-url';
import type { NotificationPreferencesDto } from '../../common/dto';
import { NotificationPreferencesService } from './notification-preferences.service';
import { ApnsPushService } from './apns-push.service';

export type PushActorContext = {
  id: string;
  username: string | null;
  name: string | null;
  avatarKey: string | null;
  /** Accepts a Date or an ISO string — publicAssetUrl handles both. */
  avatarUpdatedAt: Date | string | null;
};

/** Coalesce window (ms) per push kind to reduce fatigue. */
const PUSH_COALESCE_MS: Partial<Record<string, number>> = {
  nudge: 15 * 60 * 1000,
  followed_post: 5 * 60 * 1000,
  status_update: 5 * 60 * 1000,
  repost: 2 * 60 * 1000,
  message: 30 * 1000,
};
const DEFAULT_COALESCE_MS = 60 * 1000;

/** Render a small list of names as natural English: "A", "A and B", "A, B, and C". */
function formatNameList(names: string[]): string {
  const list = names.filter((n) => n && n.trim().length > 0);
  if (list.length === 0) return '';
  if (list.length === 1) return list[0];
  if (list.length === 2) return `${list[0]} and ${list[1]}`;
  const head = list.slice(0, -1).join(', ');
  return `${head}, and ${list[list.length - 1]}`;
}

/** Sentence-case a short action phrase for lock-screen subtitles ("checked in" → "Checked in"). */
function sentenceCaseAction(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

/** Lock-screen action lines read as a label before the preview: "Checked in:". */
function withActionColon(value: string): string {
  const text = value.trim();
  if (!text) return '';
  return /[:.!?]$/.test(text) ? text : `${text}:`;
}

/**
 * System / non-actor pushes. Their `fallbackTitle` IS the alert title — never reuse it
 * as subtitle (that produces "Good morning" / "Good morning" on lock screen).
 */
const DAILY_CONTENT_PUSH_KINDS = new Set<NotificationKind>([
  'word_of_the_day',
  'quote_of_the_day',
]);

const SYSTEM_PUSH_KINDS = new Set<NotificationKind>([
  'word_of_the_day',
  'quote_of_the_day',
  'checkin_reminder',
  'on_this_day',
  'account_verified',
  'premium_started',
  'premium_ended',
  'poll_results_ready',
  'space_reminder_day',
  'space_reminder_soon',
  'space_live',
  'space_schedule_cancelled',
  'space_schedule_rescheduled',
]);

/**
 * Prefer a concrete group name over generic "their/your/the/a group" phrasing
 * so Communication-style pushes still name the group after the title becomes the actor.
 */
function actionWithGroupName(action: string, groupName: string): string {
  const replaced = action
    .replace(/\btheir group\b/i, groupName)
    .replace(/\byour group\b/i, groupName)
    .replace(/\bthe group\b/i, groupName)
    .replace(/\ba group\b/i, groupName);
  return replaced;
}

/**
 * Web Push delivery: subscription management, VAPID setup, per-kind copy,
 * coalescing, and the system-originated pushes (streak reminders, crew
 * streaks, reply nudges, DMs).
 */
@Injectable()
export class NotificationPushService {
  private readonly logger = new Logger(NotificationPushService.name);
  private vapidConfigured = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly appConfig: AppConfigService,
    private readonly presence: PresenceService,
    private readonly preferences: NotificationPreferencesService,
    private readonly apnsPush: ApnsPushService,
    private readonly cache: CacheService,
  ) {}

  /**
   * Fetch the minimal user fields needed for APNs rich content. Result is cached
   * in Redis for 5 minutes so fan-out jobs for the same actor (e.g. 10k followers
   * of a new post) avoid N identical DB reads for the same row.
   */
  private async getActorMini(userId: string): Promise<PushActorContext | null> {
    return this.cache.getOrSetNullableJson<PushActorContext>({
      enabled: Boolean(userId),
      key: RedisKeys.pushActorMini(userId),
      ttlSeconds: CacheTtl.pushActorMiniSeconds,
      nullTtlSeconds: CacheTtl.pushActorMiniNullSeconds,
      compute: () =>
        this.prisma.user.findUnique({
          where: { id: userId },
          select: { id: true, username: true, name: true, avatarKey: true, avatarUpdatedAt: true },
        }),
    });
  }

  /** True if at least one push channel (Web Push VAPID or native APNs) can send. */
  private pushChannelConfigured(): boolean {
    return this.appConfig.vapidConfigured() || this.apnsPush.configured();
  }

  shouldSendPushForKind(
    prefs: Pick<
      NotificationPreferencesDto,
      | 'pushComment'
      | 'pushBoost'
      | 'pushFollow'
      | 'pushMention'
      | 'pushRepost'
      | 'pushNudge'
      | 'pushFollowedPost'
      | 'pushMessage'
      | 'pushGroupActivity'
      | 'pushDailyContent'
      | 'pushCheckinReminder'
    >,
    kind: NotificationKind,
  ): boolean {
    if (kind === 'comment') return Boolean(prefs.pushComment);
    if (kind === 'boost') return Boolean(prefs.pushBoost);
    if (kind === 'follow') return Boolean(prefs.pushFollow);
    if (kind === 'mention') return Boolean(prefs.pushMention);
    if (kind === 'repost') return Boolean(prefs.pushRepost);
    if (kind === 'nudge') return Boolean(prefs.pushNudge);
    if (kind === 'followed_post' || kind === 'checkin_post') return Boolean(prefs.pushFollowedPost);
    if (kind === 'followed_article') return Boolean(prefs.pushFollowedPost);
    if (kind === 'status_update') return Boolean(prefs.pushFollowedPost);
    if (kind === 'message') return Boolean(prefs.pushMessage);
    if (
      kind === 'community_group_member_joined' ||
      kind === 'community_group_join_approved' ||
      kind === 'community_group_join_rejected' ||
      kind === 'community_group_member_removed' ||
      kind === 'community_group_disbanded' ||
      kind === 'group_join_request' ||
      kind === 'community_group_invite_received' ||
      kind === 'community_group_invite_accepted' ||
      kind === 'community_group_invite_declined' ||
      kind === 'community_group_invite_cancelled'
    ) return Boolean(prefs.pushGroupActivity);
    // marv_not_in_group is an informational notice, not an action the user needs to
    // act on urgently — skip push to avoid noise.
    if (kind === 'marv_not_in_group') return false;
    if (kind === 'word_of_the_day' || kind === 'quote_of_the_day' || kind === 'on_this_day')
      return Boolean(prefs.pushDailyContent);
    if (kind === 'checkin_reminder') return Boolean(prefs.pushCheckinReminder);
    // Non-mapped kinds pass through default (allow).
    return true;
  }

  actorDisplayName(actor?: PushActorContext | null): string {
    const name = (actor?.name ?? '').trim();
    if (name) return name;
    const username = (actor?.username ?? '').trim();
    if (username) return `@${username}`;
    return 'Someone';
  }

  trimPushBody(body?: string | null, max = 140): string | null {
    const text = (body ?? '').trim().replace(/\s+/g, ' ');
    if (!text) return null;
    if (text.length <= max) return text;
    return `${text.slice(0, Math.max(0, max - 1))}…`;
  }

  buildPushTag(params: {
    recipientUserId: string;
    kind: NotificationKind;
    actorUserId?: string | null;
    subjectPostId?: string | null;
    subjectUserId?: string | null;
  }): string {
    const { recipientUserId, kind, actorUserId, subjectPostId, subjectUserId } = params;
    if (subjectPostId) return `notif-${kind}-post-${subjectPostId}`;
    if (subjectUserId) return `notif-${kind}-user-${subjectUserId}`;
    if (actorUserId) return `notif-${kind}-actor-${actorUserId}`;
    return `notif-${kind}-${recipientUserId}`;
  }

  buildPushCopy(params: {
    kind: NotificationKind;
    actor?: PushActorContext | null;
    fallbackTitle?: string | null;
    body?: string | null;
    subjectArticleId?: string | null;
  }): { title: string; body?: string } {
    const { kind, actor, fallbackTitle, body, subjectArticleId } = params;
    const actorName = this.actorDisplayName(actor);
    const snippet = this.trimPushBody(body);
    // Prefer the role-specific DB title (already encodes "post" vs "comment" / article variants)
    // when it's set, just prefixed with the actor name. This keeps push wording in lockstep
    // with what the in-app row shows.
    const titleFromFallback = (fallbackTitle ?? '').trim();
    if (kind === 'comment') {
      if (titleFromFallback) {
        return {
          title: `${actorName} ${titleFromFallback}`,
          body: snippet ?? (subjectArticleId ? 'Open to view the comment.' : 'Open to view the reply.'),
        };
      }
      if (subjectArticleId) {
        return {
          title: `${actorName} replied to your article`,
          body: snippet ?? 'Open to view the reply.',
        };
      }
      return {
        title: `${actorName} replied to your post`,
        body: snippet ?? 'Open to view the reply.',
      };
    }
    if (kind === 'mention') {
      if (titleFromFallback) {
        return {
          title: `${actorName} ${titleFromFallback}`,
          body: snippet ?? 'Open to view the mention.',
        };
      }
      if (subjectArticleId) {
        return {
          title: `${actorName} mentioned you in an article comment`,
          body: snippet ?? 'Open to view the mention.',
        };
      }
      return {
        title: `${actorName} mentioned you`,
        body: snippet ?? 'Open to view the mention.',
      };
    }
    if (kind === 'follow') {
      return {
        title: `${actorName} followed you`,
        body: snippet ?? 'Open their profile.',
      };
    }
    if (kind === 'boost') {
      if (subjectArticleId) {
        return {
          title: `${actorName} boosted your article`,
          body: snippet ?? 'Your article is getting traction.',
        };
      }
      return {
        title: titleFromFallback
          ? `${actorName} ${titleFromFallback}`
          : `${actorName} boosted your post`,
        body: snippet ?? 'Your post is getting traction.',
      };
    }
    if (kind === 'repost') {
      if (titleFromFallback) {
        return {
          title: `${actorName} ${titleFromFallback}`,
          body: snippet ?? 'Open to view.',
        };
      }
      return {
        title: `${actorName} reposted your post`,
        body: snippet ?? 'Open to view the repost.',
      };
    }
    if (kind === 'followed_post') {
      return {
        title: titleFromFallback
          ? `${actorName} ${titleFromFallback}`
          : `${actorName} posted`,
        body: snippet ?? 'Open to read it.',
      };
    }
    if (kind === 'checkin_post') {
      return {
        title: titleFromFallback
          ? `${actorName} ${titleFromFallback}`
          : `${actorName} checked in`,
        body: snippet ?? 'Open to see their check-in.',
      };
    }
    if (kind === 'status_update') {
      return {
        title: `${actorName} updated their status`,
        body: snippet ?? 'Open their profile to see it.',
      };
    }
    if (kind === 'followed_article') {
      return {
        title: `${actorName} published an article`,
        body: snippet ?? 'Open to read it.',
      };
    }
    if (kind === 'nudge') {
      return {
        title: `${actorName} nudged you`,
        body: snippet ?? 'Open notifications to respond.',
      };
    }
    if (kind === 'poll_results_ready') {
      return {
        title: 'Poll results are ready',
        body: snippet ?? 'Open to see the results.',
      };
    }
    if (kind === 'coin_transfer') {
      return {
        title: `${actorName} sent you coins`,
        body: snippet ?? 'Open to view your coin activity.',
      };
    }
    if (kind === 'group_join_request') {
      return {
        title: `${actorName} asked to join your group`,
        body: snippet ?? 'Open to review the request.',
      };
    }
    if (kind === 'crew_invite_received') {
      return {
        title: `${actorName} invited you to their crew`,
        body: snippet ?? 'Open to see the invite.',
      };
    }
    if (kind === 'crew_invite_accepted') {
      return {
        title: `${actorName} accepted your crew invite`,
        body: snippet ?? 'Welcome them to the crew.',
      };
    }
    if (kind === 'crew_invite_declined') {
      return {
        title: `${actorName} declined your crew invite`,
        body: snippet ?? 'No worries — invite someone else.',
      };
    }
    if (kind === 'crew_member_joined') {
      return {
        title: `${actorName} joined your crew`,
        body: snippet ?? 'Say hello on the wall.',
      };
    }
    if (kind === 'crew_member_left') {
      return {
        title: `${actorName} left your crew`,
        body: snippet ?? 'Your crew roster changed.',
      };
    }
    if (kind === 'crew_member_kicked') {
      return {
        title: 'Crew roster changed',
        body: snippet ?? 'A member was removed from your crew.',
      };
    }
    if (kind === 'crew_owner_transferred') {
      return {
        title: 'Crew ownership transferred',
        body: snippet ?? 'Your crew has a new owner.',
      };
    }
    if (kind === 'crew_owner_transfer_vote') {
      return {
        title: `${actorName} started a vote in your crew`,
        body: snippet ?? 'Open to cast your vote.',
      };
    }
    if (kind === 'crew_wall_mention') {
      return {
        title: `${actorName} mentioned you on the wall`,
        body: snippet ?? 'Open the crew wall to reply.',
      };
    }
    if (kind === 'crew_disbanded') {
      return {
        title: 'Your crew was disbanded',
        body: snippet ?? 'Start a new crew when you\u2019re ready.',
      };
    }
    if (kind === 'crew_invite_cancelled') {
      return {
        title: 'Crew invite cancelled',
        body: snippet ?? 'The invite is no longer active.',
      };
    }
    if (kind === 'community_group_invite_received') {
      return {
        title: `${actorName} invited you to a group`,
        body: snippet ?? 'Open to see the invite.',
      };
    }
    if (kind === 'community_group_invite_accepted') {
      return {
        title: `${actorName} accepted your group invite`,
        body: snippet ?? 'Welcome them to the group.',
      };
    }
    if (kind === 'community_group_invite_declined') {
      return {
        title: `${actorName} declined your group invite`,
        body: snippet ?? 'No worries — invite someone else.',
      };
    }
    if (kind === 'community_group_invite_cancelled') {
      return {
        title: 'Group invite cancelled',
        body: snippet ?? 'The invite is no longer active.',
      };
    }
    if (kind === 'community_group_member_joined') {
      return {
        title: `${actorName} joined the group`,
        body: snippet ?? 'Open to see the new member.',
      };
    }
    if (kind === 'community_group_join_approved') {
      return {
        title: 'Your join request was approved',
        body: snippet ?? 'You\u2019re now a member.',
      };
    }
    if (kind === 'community_group_join_rejected') {
      return {
        title: 'Your join request was not accepted',
        body: snippet ?? 'You can request to join another group.',
      };
    }
    if (kind === 'community_group_member_removed') {
      return {
        title: 'You were removed from a group',
        body: snippet ?? 'Open to see your groups.',
      };
    }
    if (kind === 'community_group_disbanded') {
      return {
        title: 'A group you were in was disbanded',
        body: snippet ?? 'Open to find another group.',
      };
    }
    if (kind === 'message') {
      return {
        title: `${actorName} sent you a message`,
        body: snippet ?? 'Open to read it.',
      };
    }
    if (kind === 'checkin_reminder') {
      return {
        title: titleFromFallback || 'Have you checked in today?',
        body: snippet ?? 'Post your check-in to keep your streak alive.',
      };
    }
    if (kind === 'on_this_day') {
      return {
        title: titleFromFallback || 'On this day',
        body: snippet ?? 'Open to revisit your check-in.',
      };
    }
    if (kind === 'word_of_the_day') {
      return {
        title: titleFromFallback || 'Good morning!',
        body: snippet ?? 'Open for today\u2019s word.',
      };
    }
    if (kind === 'quote_of_the_day') {
      return {
        title: titleFromFallback || 'Quote of the day',
        body: snippet ?? 'Open to read today\u2019s quote.',
      };
    }
    if (kind === 'account_verified') {
      return {
        title: titleFromFallback || "You're verified",
        body: snippet ?? 'Your account is now verified. Welcome.',
      };
    }
    if (kind === 'premium_started') {
      return {
        title: titleFromFallback || "You're Premium",
        body: snippet ?? 'Premium is active. Thanks for backing Men of Hunger.',
      };
    }
    if (kind === 'premium_ended') {
      return {
        title: titleFromFallback || 'Your Premium ended',
        body: snippet ?? 'Premium access has ended. You can restart anytime.',
      };
    }
    if (kind === 'space_reminder_day') {
      return {
        title: titleFromFallback || 'Space today',
        body: snippet ?? 'A space you asked about is scheduled for today.',
      };
    }
    if (kind === 'space_reminder_soon') {
      return {
        title: titleFromFallback || 'Space starting soon',
        body: snippet ?? 'Starts in about 15 minutes.',
      };
    }
    if (kind === 'space_live') {
      return {
        title: titleFromFallback || 'Space is live',
        body: snippet ?? 'Tap to join now.',
      };
    }
    if (kind === 'space_schedule_cancelled') {
      return {
        title: titleFromFallback || 'Space cancelled',
        body: snippet ?? 'The scheduled space was cancelled.',
      };
    }
    if (kind === 'space_schedule_rescheduled') {
      return {
        title: titleFromFallback || 'Space rescheduled',
        body: snippet ?? 'The start time changed.',
      };
    }
    // Generic kind is used for one-off actor-driven events that don't have their own kind
    // (e.g. article emoji reactions). Prefix the DB title with the actor name when both
    // are present so the push reads like "Jane reacted to your article" with body=emoji.
    if (kind === 'generic' && titleFromFallback && actor) {
      return {
        title: `${actorName} ${titleFromFallback}`,
        ...(snippet ? { body: snippet } : { body: 'Open to view it.' }),
      };
    }
    if (kind === 'generic') {
      return {
        title: titleFromFallback || 'New activity',
        body: snippet ?? 'Open to view it.',
      };
    }
    // These kinds do not currently send push notifications, but explicit copy keeps a future
    // delivery path from falling back to technical or generic text.
    if (kind === 'community_group_post') {
      return {
        title: titleFromFallback || 'New group post',
        body: snippet ?? 'Open to read it.',
      };
    }
    if (kind === 'marv_not_in_group') {
      return {
        title: titleFromFallback || 'Group update',
        body: snippet ?? 'Open to view the update.',
      };
    }
    return {
      title: titleFromFallback || 'New notification',
      ...(snippet ? { body: snippet } : { body: 'You have a new notification.' }),
    };
  }

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
    if (!this.pushChannelConfigured()) {
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
   * Returns true if a push with this coalesceKey was already sent within the window for this kind.
   * coalesceKey is the resolved push tag (subject-scoped), so distinct subjects each get their own window.
   */
  private async isPushCoalesced(recipientUserId: string, coalesceKey: string, kind: string): Promise<boolean> {
    const windowMs = PUSH_COALESCE_MS[kind] ?? DEFAULT_COALESCE_MS;
    const since = new Date(Date.now() - windowMs);
    const row = await this.prisma.pushCoalesce.findUnique({
      where: { userId_coalesceKey: { userId: recipientUserId, coalesceKey } },
      select: { sentAt: true },
    });
    return row ? row.sentAt >= since : false;
  }

  private async recordPushSent(recipientUserId: string, coalesceKey: string): Promise<void> {
    await this.prisma.pushCoalesce.upsert({
      where: { userId_coalesceKey: { userId: recipientUserId, coalesceKey } },
      create: { userId: recipientUserId, coalesceKey, sentAt: new Date() },
      update: { sentAt: new Date() },
    });
  }

  /**
   * Send a push to all of the user's registered channels: Web Push subscriptions
   * (pruning expired 410/404) and native APNs device tokens. Coalescing is shared
   * across both channels, keyed by the resolved push tag so distinct subjects each
   * have their own window.
   *
   * When suppressActiveWebChannel is true (actor-driven notifications only):
   *   - The web VAPID channel is skipped if the user has an active web socket.
   *     The realtime event already updates the badge in-app; a browser banner on top
   *     is noise the user didn't ask for.
   *   - iOS / APNs is NEVER suppressed here. The iOS app intercepts foreground
   *     deliveries via UNUserNotificationCenterDelegate and decides whether to
   *     show a banner — that decision belongs to the client, not the server.
   *   - If the web channel is the only one and it's suppressed, the coalesce record
   *     is NOT written so the next event that lands while they're offline isn't blocked.
   * System-originated pushes (streak, reply-nudge, crew-streak) and DMs do NOT pass this flag.
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
      avatarUrl?: string | null;
      mediaUrl?: string | null;
      actorUsername?: string | null;
      actorName?: string | null;
      groupInviteId?: string | null;
      postId?: string | null;
      /** @deprecated Use suppressActiveWebChannel instead. Kept for call-site compat; maps to suppressActiveWebChannel. */
      suppressActiveChannels?: boolean;
      suppressActiveWebChannel?: boolean;
      /** When the recipient is a page, skip this actor if they operate it. */
      actorUserId?: string | null;
    },
  ): Promise<void> {
    if (!this.pushChannelConfigured()) return;
    const kind = params.kind ?? 'generic';

    const baseUrl =
      this.appConfig.pushFrontendBaseUrl() ??
      this.appConfig.allowedOrigins()[0]?.trim() ??
      'https://menofhunger.com';
    const safeBase = baseUrl.replace(/\/$/, '');
    let url = params.url?.trim() || `${safeBase}/notifications`;
    if (!params.url && params.subjectPostId) {
      url = `${safeBase}/p/${params.subjectPostId}`;
    } else if (!params.url && params.subjectUserId) {
      const subjectUser = await this.prisma.user.findUnique({
        where: { id: params.subjectUserId },
        select: { username: true },
      });
      const username = (subjectUser?.username ?? '').trim();
      if (username) {
        url = `${safeBase}/u/${encodeURIComponent(username)}`;
      }
    }

    // Resolve tag before coalesce check so the key is subject-scoped, not kind-only.
    const defaultTag = params.test ? `notification-test-${Date.now()}` : `notification-${recipientUserId}`;
    const tag = params.tag?.trim() || defaultTag;

    if (!params.test && (await this.isPushCoalesced(recipientUserId, tag, kind))) {
      this.logger.debug(`[push] Coalesced ${kind} (tag=${tag}) for user ${recipientUserId}`);
      return;
    }

    // Distinguish "explicit empty body" (e.g. reply-nudge that's title-only) from "no body provided"
    // (legacy callers that want the friendly fallback).
    let body = params.body === undefined ? 'You have a new notification.' : params.body;
    if (params.sourceLabel) {
      body = body ? `${body} · ${params.sourceLabel}` : params.sourceLabel;
    }

    const recipient = await this.prisma.user.findUnique({
      where: { id: recipientUserId },
      select: { accountKind: true, username: true },
    });
    if (recipient?.accountKind === 'page' && DAILY_CONTENT_PUSH_KINDS.has(kind as NotificationKind)) {
      this.logger.debug(`[push] Skipping ${kind} for page ${recipientUserId}`);
      return;
    }
    const actorUserId = (params.actorUserId ?? '').trim();
    const tokenOwners = (
      await this.tokenOwnersForRecipient(recipientUserId, recipient?.accountKind)
    ).filter((ownerId) => !actorUserId || ownerId !== actorUserId);
    if (tokenOwners.length === 0) {
      this.logger.debug(`[push] No token owners for ${kind} after excluding actor`);
      return;
    }
    const recipientUsername = (recipient?.username ?? '').trim() || null;

    const titleForOwner = (tokenOwnerId: string) => {
      if (tokenOwnerId === recipientUserId || !recipientUsername) return params.title;
      return `@${recipientUsername} · ${params.title}`;
    };

    // iOS / APNs: always deliver. The app's UNUserNotificationCenterDelegate decides
    // whether to surface a banner when foregrounded — that is a client-side concern.
    if (this.apnsPush.configured()) {
      const apnsBody = this.apnsBodyWithVisibleAction({
        kind,
        body: body ?? '',
        subtitle: params.subtitle ?? null,
        actorUsername: params.actorUsername ?? null,
      });
      for (const tokenOwnerId of tokenOwners) {
        this.apnsPush
          .sendToUser(tokenOwnerId, {
            title: titleForOwner(tokenOwnerId),
            body: apnsBody,
            url,
            notificationId: params.notificationId ?? null,
            kind,
            collapseId: tag,
            mutableContent: Boolean(params.avatarUrl || params.mediaUrl || params.actorUsername),
            subtitle: params.subtitle ?? null,
            threadId: params.threadId ?? null,
            category: params.category ?? null,
            avatarUrl: params.avatarUrl ?? null,
            mediaUrl: params.mediaUrl ?? null,
            actorUsername: params.actorUsername ?? null,
            actorName: params.actorName ?? null,
            groupInviteId: params.groupInviteId ?? null,
            postId: params.postId ?? null,
            recipientUserId,
            recipientUsername,
          })
          .catch((err) => {
            this.logger.warn(`[apns] Failed to send push (${kind}): ${err instanceof Error ? err.message : String(err)}`);
          });
      }
    }

    // Web VAPID: suppress when the *recipient* is actively connected on the web — the
    // realtime event already updated their badge. suppressActiveChannels is the legacy name.
    const suppressWeb =
      (params.suppressActiveWebChannel === true || params.suppressActiveChannels === true) &&
      this.presence.isUserActivelyOnChannel(recipientUserId, 'web');

    if (!suppressWeb) {
      for (const tokenOwnerId of tokenOwners) {
        await this.sendWebPushOnly(tokenOwnerId, {
          payload: JSON.stringify({
            title: titleForOwner(tokenOwnerId),
            body,
            notificationId: params.notificationId ?? undefined,
            url,
            tag,
            kind,
            icon: params.icon ?? undefined,
            badge: params.badge ?? '/android-chrome-192x192.png',
            renotify: Boolean(params.renotify),
            test: params.test === true,
            recipientUserId,
            recipientUsername,
          }),
        });
      }
    } else {
      this.logger.debug(`[push] Suppressed web push for ${kind} — user ${recipientUserId} is active on web`);
      // Don't record coalesce: the user is online now but may miss the next event while offline.
      return;
    }

    if (!params.test) {
      await this.recordPushSent(recipientUserId, tag).catch(() => {});
    }
  }

  /** Pages never own devices — deliver to each operator. Persons keep their own tokens. */
  private async tokenOwnersForRecipient(
    recipientUserId: string,
    accountKind?: string | null,
  ): Promise<string[]> {
    if (accountKind !== 'page') return [recipientUserId];
    const operators = await this.prisma.userPageOperator.findMany({
      where: { pageUserId: recipientUserId },
      select: { operatorUserId: true },
    });
    return operators.map((row) => row.operatorUserId);
  }

  /** Web Push delivery to all browser subscriptions; prunes expired (410/404). */
  private async sendWebPushOnly(
    recipientUserId: string,
    params: { payload: string },
  ): Promise<void> {
    if (!this.appConfig.vapidConfigured()) return;
    if (!this.vapidConfigured) {
      const publicKey = this.appConfig.vapidPublicKey();
      const privateKey = this.appConfig.vapidPrivateKey();
      if (publicKey && privateKey) {
        webpush.setVapidDetails('mailto:support@menofhunger.com', publicKey, privateKey);
        this.vapidConfigured = true;
      } else return;
    }

    const subs = await this.prisma.pushSubscription.findMany({
      where: { userId: recipientUserId },
      select: { id: true, endpoint: true, p256dh: true, auth: true },
    });

    if (subs.length === 0) {
      this.logger.debug(`[push] No subscriptions for user ${recipientUserId}; skipping web push.`);
      return;
    }

    const expiredIds: string[] = [];
    for (const sub of subs) {
      try {
        await webpush.sendNotification(
          {
            endpoint: sub.endpoint,
            keys: { p256dh: sub.p256dh, auth: sub.auth },
          },
          params.payload,
          { TTL: 60 * 60 * 24 },
        );
      } catch (err: unknown) {
        const statusCode = (err as { statusCode?: number })?.statusCode;
        if (statusCode === 410 || statusCode === 404) {
          expiredIds.push(sub.id);
        }
      }
    }
    if (expiredIds.length > 0) {
      await this.prisma.pushSubscription.deleteMany({ where: { id: { in: expiredIds } } }).catch(() => {});
    }
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
    if (!this.pushChannelConfigured()) return;
    try {
      const prefs = await this.preferences.getPreferencesInternal(params.recipientUserId);
      if (!prefs.pushReplyNudge) return;
    } catch {
      // Best-effort: if prefs read fails, default to sending.
    }
    const actor = await this.getActorMini(params.actorUserId);
    if (!actor) return;
    const actorName = this.actorDisplayName(actor);
    const publicBaseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;
    const icon = publicAssetUrl({
      publicBaseUrl,
      key: actor.avatarKey,
      updatedAt: actor.avatarUpdatedAt,
    });
    const url = params.actorPostId ? `/p/${params.actorPostId}` : '/notifications';
    const snippet = this.trimPushBody(params.bodySnippet, 120);
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
   * Send a streak-at-risk push notification to a single user.
   * Called by the nightly streak-reminder push cron (9 PM ET).
   * Only fires if the user has push subscriptions; silently skips if not.
   */
  async sendStreakReminderPush(params: {
    recipientUserId: string;
    streakDays: number;
    url: string;
  }): Promise<void> {
    if (!this.pushChannelConfigured()) return;
    const { streakDays } = params;
    const title = `${streakDays}-day streak at risk`;
    const body = `Post today before midnight ET — or your streak resets.`;
    await this.sendWebPushToRecipient(params.recipientUserId, {
      title,
      body,
      url: params.url,
      tag: `streak-reminder-${params.recipientUserId}`,
      kind: 'streak_reminder',
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
    if (!this.pushChannelConfigured()) return;
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
    if (!this.pushChannelConfigured()) return;
    if (params.recipientUserIds.length === 0) return;

    const url = params.crewSlug ? `/c/${encodeURIComponent(params.crewSlug)}` : '/crew';
    const crewLabel = (params.crewName ?? '').trim() || 'Your crew';
    const title = 'You lost the streak.';
    const tag = `crew-streak-broken-${params.crewId}`;

    const missedNames = params.missedMembers
      .map((m) => (m.displayName ?? m.username ?? '').trim())
      .filter((n) => n.length > 0);

    for (const recipientUserId of params.recipientUserIds) {
      try {
        const prefs = await this.preferences.getPreferencesInternal(recipientUserId);
        if (!prefs.pushCrewStreak) continue;
      } catch {
        // Best effort: default to sending if prefs read fails.
      }

      // Personalize body so the recipient knows whether *they* missed.
      const recipientMissed = params.missedMembers.some((m) => m.id === recipientUserId);
      const others = missedNames
        .filter((_, idx) => params.missedMembers[idx]?.id !== recipientUserId);

      let body: string;
      if (recipientMissed && others.length === 0) {
        body = `${crewLabel} broke the streak yesterday. You didn't check in.`;
      } else if (recipientMissed && others.length > 0) {
        body = `${crewLabel} broke the streak yesterday. You and ${formatNameList(others)} didn't check in.`;
      } else if (others.length === 0) {
        body = `${crewLabel} broke the streak yesterday.`;
      } else if (others.length === 1) {
        body = `${others[0]} didn't check in yesterday. ${crewLabel} lost the streak.`;
      } else {
        body = `${formatNameList(others)} didn't check in yesterday. ${crewLabel} lost the streak.`;
      }

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
  }): Promise<void> {
    try {
      const prefs = await this.preferences.getPreferencesInternal(params.recipientUserId);
      if (!prefs.pushMessage) return;
    } catch {
      // Best-effort: if prefs read fails, still attempt push (default behavior).
    }
    if (this.presence.isUserViewingConversation(params.recipientUserId, params.conversationId)) {
      this.logger.debug(
        `[push] Skipping DM push — recipient ${params.recipientUserId} is viewing conversation ${params.conversationId}`,
      );
      return;
    }
    const sender = (params.senderName ?? '').trim();
    const title = sender ? `New message from ${sender}` : 'New message';
    const body = this.trimPushBody(params.body, 150) ?? 'Open chat to read the message.';
    const url = `/chat?c=${encodeURIComponent(params.conversationId)}`;
    const tag = `message-conversation-${params.conversationId}`;
    const senderUser = await this.getActorMini(params.senderUserId);
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

  private pushCategory(kind: NotificationKind, hasReplyPost: boolean): string | null {
    if ((kind === 'comment' || kind === 'mention') && hasReplyPost) return 'moh.category.reply';
    if (kind === 'follow') return 'moh.category.follow';
    if (kind === 'community_group_invite_received') return 'moh.category.groupInvite';
    return null;
  }

  /**
   * Lock-screen subtitle for APNs / web push.
   *
   * iOS Communication notifications (NSE + INSendMessageIntent) replace the alert
   * title with the actor's display name. The verb/context therefore lives here —
   * and is also folded into the body via `apnsBodyWithVisibleAction`, because the
   * Communication UI often omits subtitle on the lock screen.
   *
   * System kinds must not echo `fallbackTitle` as subtitle — that title already is
   * the bold first line (e.g. "Good morning" / "Good morning").
   */
  private pushSubtitle(
    kind: NotificationKind,
    groupName?: string | null,
    fallbackTitle?: string | null,
    subjectArticleId?: string | null,
  ): string | null {
    const group = (groupName ?? '').trim();
    if (SYSTEM_PUSH_KINDS.has(kind)) {
      return group || null;
    }

    const action = sentenceCaseAction(fallbackTitle ?? '');

    if (group && action) return withActionColon(actionWithGroupName(action, group));
    if (group) return group;
    if (action) return withActionColon(action);

    if (kind === 'comment') {
      return withActionColon(subjectArticleId ? 'Replied to your article' : 'Replied to your post');
    }
    if (kind === 'mention') {
      return withActionColon(subjectArticleId ? 'Mentioned you in an article' : 'Mentioned you');
    }
    if (kind === 'follow') return withActionColon('Followed you');
    if (kind === 'boost') {
      return withActionColon(subjectArticleId ? 'Boosted your article' : 'Boosted your post');
    }
    if (kind === 'repost') return withActionColon('Reposted your post');
    if (kind === 'followed_post') return withActionColon('Posted');
    if (kind === 'checkin_post') return withActionColon('Checked in');
    if (kind === 'status_update') return withActionColon('Updated their status');
    if (kind === 'nudge') return withActionColon('Nudged you');
    if (kind === 'followed_article') return withActionColon('Published an article');
    if (kind === 'message') return withActionColon('Sent you a message');
    return null;
  }

  /**
   * iOS Communication notifications replace the title with the sender name and
   * often omit the subtitle. Fold the action into the body so lock-screen copy
   * still says what happened (e.g. "Replied to your post:\nWash sheets…").
   * DMs stay message-style (name + body only).
   */
  private apnsBodyWithVisibleAction(params: {
    kind: string;
    body: string;
    subtitle?: string | null;
    actorUsername?: string | null;
  }): string {
    const snippet = (params.body ?? '').trim();
    if (!params.actorUsername || params.kind === 'message') return snippet;
    const action = (params.subtitle ?? '').trim();
    if (!action) return snippet;
    if (!snippet) return action;
    const actionBare = action.replace(/[:.!?]+$/, '');
    if (actionBare && snippet.toLowerCase().includes(actionBare.toLowerCase())) return snippet;
    return `${action}\n${snippet}`;
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
  }): Promise<void> {
    const { recipientUserId, kind, actorUserId } = params;
    try {
      const prefs = await this.preferences.getPreferencesInternal(recipientUserId);
      if (!this.shouldSendPushForKind(prefs, kind)) return;
      const mediaPostId = params.actorPostId ?? params.subjectPostId ?? null;
      const threadPostId = params.subjectPostId ?? params.actorPostId ?? null;
      const [actor, mediaPost, threadPost, group] = await Promise.all([
        actorUserId ? this.getActorMini(actorUserId) : null,
        mediaPostId
          ? this.prisma.post.findUnique({
              where: { id: mediaPostId },
              select: {
                id: true,
                deletedAt: true,
                rootId: true,
                media: {
                  where: { deletedAt: null },
                  orderBy: { position: 'asc' },
                  take: 1,
                  select: {
                    kind: true,
                    source: true,
                    r2Key: true,
                    thumbnailR2Key: true,
                    url: true,
                  },
                },
              },
            })
          : null,
        threadPostId && threadPostId !== mediaPostId
          ? this.prisma.post.findUnique({
              where: { id: threadPostId },
              select: { id: true, deletedAt: true, rootId: true },
            })
          : null,
        params.subjectGroupId
          ? this.prisma.communityGroup.findUnique({
              where: { id: params.subjectGroupId },
              select: { slug: true, name: true, avatarImageUrl: true, deletedAt: true },
            })
          : null,
      ]);
      const pushCopy = this.buildPushCopy({
        kind,
        actor,
        fallbackTitle: params.fallbackTitle ?? null,
        body: params.body ?? null,
        subjectArticleId: params.subjectArticleId ?? null,
      });
      const publicBaseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;
      const icon = actor
        ? publicAssetUrl({
            publicBaseUrl,
            key: actor.avatarKey,
            updatedAt: actor.avatarUpdatedAt,
          })
        : null;
      const currentGroup = group?.deletedAt ? null : group;
      const firstMedia = mediaPost?.deletedAt ? null : mediaPost?.media[0];
      const mediaKey =
        firstMedia?.kind === 'video' ? firstMedia.thumbnailR2Key : firstMedia?.r2Key;
      const mediaUrl =
        publicAssetUrl({ publicBaseUrl, key: mediaKey ?? null }) ??
        (firstMedia?.source === 'giphy' ? firstMedia.url?.trim() || null : null);
      const resolvedThreadPost = threadPost ?? mediaPost;
      const threadId = params.subjectGroupId
        ? `group-${params.subjectGroupId}`
        : kind === 'follow'
          ? 'notif-follows'
          : resolvedThreadPost
            ? `post-${resolvedThreadPost.rootId ?? resolvedThreadPost.id}`
            : null;
      const postId =
        kind === 'comment' || kind === 'mention'
          ? params.subjectPostId ?? params.actorPostId ?? null
          : params.actorPostId ?? params.subjectPostId ?? null;
      const groupUrl =
        currentGroup && params.subjectGroupId
          ? `/g/${currentGroup.slug || params.subjectGroupId}${
              kind === 'group_join_request' ? '/pending' : ''
            }`
          : null;
      this.sendWebPushToRecipient(recipientUserId, {
        title: pushCopy.title,
        body: pushCopy.body,
        notificationId: params.notificationId ?? undefined,
        subjectPostId: params.subjectPostId ?? null,
        subjectUserId: params.subjectUserId ?? null,
        url: params.url ?? groupUrl,
        tag: this.buildPushTag({
          recipientUserId,
          kind,
          actorUserId,
          subjectPostId: params.subjectPostId ?? null,
          subjectUserId: params.subjectUserId ?? null,
        }),
        icon,
        avatarUrl: icon || currentGroup?.avatarImageUrl?.trim() || null,
        mediaUrl,
        subtitle: this.pushSubtitle(
          kind,
          currentGroup?.name,
          params.fallbackTitle ?? null,
          params.subjectArticleId ?? null,
        ),
        threadId,
        category: this.pushCategory(kind, Boolean(postId)),
        actorUsername: actor?.username ?? null,
        actorName: actor?.name ?? null,
        groupInviteId: params.subjectCommunityGroupInviteId ?? null,
        postId,
        badge: '/android-chrome-192x192.png',
        renotify: true,
        kind,
        suppressActiveWebChannel: true,
        actorUserId,
        ...(params.sourceLabel ? { sourceLabel: params.sourceLabel } : {}),
      }).catch((err) => {
        this.logger.warn(`[push] Failed to send web push (${kind}): ${err instanceof Error ? err.message : String(err)}`);
      });
    } catch (err) {
      this.logger.debug(`[push] Failed to evaluate push preferences (${kind}): ${err}`);
    }
  }
}
