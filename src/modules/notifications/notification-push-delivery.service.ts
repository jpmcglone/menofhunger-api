import { USER_BRIEF_SELECT } from '../../common/prisma-selects/user.select';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { NotificationKind } from '@prisma/client';
import * as webpush from 'web-push';
import { randomUUID } from 'node:crypto';
import { FcmPushService } from './fcm-push.service';
import { AppConfigService } from '../app/app-config.service';
import { PrismaService } from '../prisma/prisma.service';
import { CacheService } from '../redis/cache.service';
import { CacheTtl } from '../redis/cache-ttl';
import { RedisKeys } from '../redis/redis-keys';
import { ApnsPushService } from './apns-push.service';
import type { AvatarVideoDto } from '../../common/dto/avatar-video.dto';
import { apnsBodyWithVisibleAction } from './notification-push-copy';
import { PERSON_ONLY_PUSH_KINDS, PUSH_COALESCE_MS, DEFAULT_COALESCE_MS, type PushActorContext } from './notification-push.constants';

/** Channel delivery for pushes: Web Push (VAPID) and APNs fan-out, coalescing, and the cached actor context. */
@Injectable()
export class NotificationPushDeliveryService {
  private readonly logger = new Logger(NotificationPushDeliveryService.name);
  private vapidConfigured = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly appConfig: AppConfigService,
    private readonly apnsPush: ApnsPushService,
    private readonly cache: CacheService,
    @Inject(FcmPushService)
    private readonly fcmPush: Pick<FcmPushService, 'configured' | 'hasTokens' | 'sendToUser'>,
  ) {}

  /**
   * Fetch the minimal user fields needed for APNs rich content. Result is cached
   * in Redis for 5 minutes so fan-out jobs for the same actor (e.g. 10k followers
   * of a new post) avoid N identical DB reads for the same row.
   */
  async getActorMini(userId: string): Promise<PushActorContext | null> {
    return this.cache.getOrSetNullableJson<PushActorContext>({
      enabled: Boolean(userId),
      key: RedisKeys.pushActorMini(userId),
      ttlSeconds: CacheTtl.pushActorMiniSeconds,
      nullTtlSeconds: CacheTtl.pushActorMiniNullSeconds,
      compute: () =>
        this.prisma.user.findUnique({
          where: { id: userId },
          select: { ...USER_BRIEF_SELECT, avatarKey: true, avatarVideoKey: true, avatarVideoDurationMs: true, avatarUpdatedAt: true },
        }),
    });
  }

  /** True if at least one push channel (Web Push VAPID or native APNs) can send. */
  pushChannelConfigured(): boolean {
    return this.appConfig.vapidConfigured() || this.apnsPush.configured() || this.fcmPush.configured();
  }

  async hasFcmTokens(userId: string): Promise<boolean> {
    return this.fcmPush.hasTokens(userId);
  }

  /**
   * Returns true if a push with this coalesceKey was already sent within the window for this kind.
   * coalesceKey is the resolved push tag (subject-scoped), so distinct subjects each get their own window.
   */
  async isPushCoalesced(recipientUserId: string, coalesceKey: string, kind: string): Promise<boolean> {
    const windowMs = PUSH_COALESCE_MS[kind] ?? DEFAULT_COALESCE_MS;
    const since = new Date(Date.now() - windowMs);
    const row = await this.prisma.pushCoalesce.findUnique({
      where: { userId_coalesceKey: { userId: recipientUserId, coalesceKey } },
      select: { sentAt: true },
    });
    return row ? row.sentAt >= since : false;
  }

  async recordPushSent(recipientUserId: string, coalesceKey: string): Promise<void> {
    await this.prisma.pushCoalesce.upsert({
      where: { userId_coalesceKey: { userId: recipientUserId, coalesceKey } },
      create: { userId: recipientUserId, coalesceKey, sentAt: new Date() },
      update: { sentAt: new Date() },
    });
  }

  /** Pages never own devices — deliver to each operator. Persons keep their own tokens. */
  async tokenOwnersForRecipient(
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
  async sendWebPushOnly(
    recipientUserId: string,
    params: { payload: string; canDeliver?: () => Promise<boolean> },
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
      if (params.canDeliver && !await params.canDeliver()) return;
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
        } else if (params.canDeliver) throw err;
      }
    }
    if (expiredIds.length > 0) {
      await this.prisma.pushSubscription.deleteMany({ where: { id: { in: expiredIds } } }).catch(() => {});
    }
  }

  async sendWebPushToRecipient(recipientUserId: string,
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
      soundScope?: "group" | "board";
      subtitle?: string | null;
      threadId?: string | null;
      category?: string | null;
      avatarUrl?: string | null; avatarVideo?: AvatarVideoDto | null;
      mediaUrl?: string | null;
      actorUsername?: string | null;
      actorName?: string | null;
      groupInviteId?: string | null;
      postId?: string | null;
      /** When the recipient is a page, skip this actor if they operate it. */
      actorUserId?: string | null;
      /** Protected destinations re-authorize immediately before each network delivery. */
      canDeliver?: () => Promise<boolean>;
    },
  ): Promise<void> {
    if (!this.pushChannelConfigured()) return;
    if (params.canDeliver && !await params.canDeliver()) return;
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
    if (recipient?.accountKind === 'page' && PERSON_ONLY_PUSH_KINDS.has(kind as NotificationKind)) {
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
      const apnsBody = apnsBodyWithVisibleAction({
        kind,
        body: body ?? '',
        subtitle: params.subtitle ?? null,
        actorUsername: params.actorUsername ?? null,
      });
      for (const tokenOwnerId of tokenOwners) {
        const delivery = this.apnsPush
          .sendToUser(tokenOwnerId, {
            title: titleForOwner(tokenOwnerId),
            body: apnsBody,
            url,
            notificationId: params.notificationId ?? null,
            kind,
            soundScope: params.soundScope,
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
            canDeliver: params.canDeliver,
          })
          .catch((err) => {
            if (params.canDeliver) throw err;
            this.logger.warn(`[apns] Failed to send push (${kind}): ${err instanceof Error ? err.message : String(err)}`);
          });
        if (params.canDeliver) await delivery;
      }
    }

    // One event id across installation fanout. Persisted notifications retain their id on retries.
    if (this.fcmPush?.configured()) {
      let destination = "/notifications";
      try {
        const resolved = new URL(url, `${safeBase}/`);
        if (resolved.origin === new URL(safeBase).origin)
          destination = `${resolved.pathname}${resolved.search}${resolved.hash}`;
      } catch {
        /* Invalid destinations fall back to the authenticated inbox. */
      }
      const eventId = params.notificationId ?? randomUUID();
      for (const tokenOwnerId of tokenOwners) {
        await this.fcmPush.sendToUser(tokenOwnerId, {
          recipientUserId,
          eventId,
          kind,
          destination,
          tag,
          canDeliver: params.canDeliver,
        });
      }
    }

    for (const tokenOwnerId of tokenOwners) {
      await this.sendWebPushOnly(tokenOwnerId, {
        canDeliver: params.canDeliver,
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

    if (!params.test) {
      await this.recordPushSent(recipientUserId, tag).catch(() => {});
    }
  }
}
