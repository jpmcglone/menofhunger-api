import { Injectable, Logger } from '@nestjs/common';
import type { NotificationKind } from '@prisma/client';
import * as webpush from 'web-push';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfigService } from '../app/app-config.service';
import { publicAssetUrl } from '../../common/assets/public-asset-url';
import { createdAtIdCursorWhere } from '../../common/pagination/created-at-id-cursor';
import { PresenceRealtimeService } from '../presence/presence-realtime.service';
import type { NotificationActorDto, NotificationDto, SubjectPostPreviewDto, SubjectPostVisibility, SubjectTier } from './notification.dto';
import type { NotificationFeedItemDto, NotificationGroupDto, NotificationGroupKind } from '../../common/dto/notification-feed.dto';
import type { NotificationPreferencesDto } from '../../common/dto';

export type CreateNotificationParams = {
  recipientUserId: string;
  kind: NotificationKind;
  actorUserId?: string | null;
  actorPostId?: string | null;
  subjectPostId?: string | null;
  subjectUserId?: string | null;
  title?: string | null;
  body?: string | null;
};

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);
  private vapidConfigured = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly appConfig: AppConfigService,
    private readonly presenceRealtime: PresenceRealtimeService,
  ) {}

  /** True if recipient already has a follow notification from actor within the last withinMs. Use to avoid spam when someone unfollows then follows again. */
  async hasRecentFollowNotification(
    recipientUserId: string,
    actorUserId: string,
    withinMs: number,
  ): Promise<boolean> {
    const since = new Date(Date.now() - withinMs);
    const existing = await this.prisma.notification.findFirst({
      where: {
        recipientUserId,
        actorUserId,
        kind: 'follow',
        createdAt: { gte: since },
      },
      select: { id: true },
    });
    return Boolean(existing);
  }

  async create(params: CreateNotificationParams) {
    const {
      recipientUserId,
      kind,
      actorUserId,
      actorPostId,
      subjectPostId,
      subjectUserId,
      title,
      body,
    } = params;
    const fallbackTitle =
      title ??
      ({
        follow: 'followed you',
        boost: 'boosted your post',
        followed_post: 'posted',
        mention: 'mentioned you',
        comment: 'replied to you',
      } as Partial<Record<NotificationKind, string>>)[kind] ??
      null;

    const notification = await this.prisma.notification.create({
      data: {
        recipientUserId,
        kind,
        actorUserId: actorUserId ?? undefined,
        actorPostId: actorPostId ?? undefined,
        subjectPostId: subjectPostId ?? undefined,
        subjectUserId: subjectUserId ?? undefined,
        title: fallbackTitle ?? undefined,
        body: body ?? undefined,
      },
    });

    const undeliveredCount = await this.getUndeliveredCount(recipientUserId);
    this.presenceRealtime.emitNotificationsUpdated(recipientUserId, {
      undeliveredCount,
    });

    // Also emit the full notification payload so clients can update in-place without refetch.
    try {
      const dto = await this.buildNotificationDtoForRecipient({
        recipientUserId,
        notificationId: notification.id,
      });
      if (dto) {
        this.presenceRealtime.emitNotificationNew(recipientUserId, { notification: dto });
      }
    } catch (err) {
      // Best-effort: never fail notification creation on realtime emission.
      this.logger.debug(`[notifications] Failed to emit notifications:new: ${err}`);
    }

    // Web push is optional (VAPID + user preference).
    try {
      const prefs = await this.getPreferencesInternal(recipientUserId);
      if (this.shouldSendPushForKind(prefs, kind)) {
        this.sendWebPushToRecipient(recipientUserId, {
          title: fallbackTitle ?? 'New notification',
          body: (body ?? '').trim().slice(0, 150) || undefined,
          subjectPostId: subjectPostId ?? null,
          subjectUserId: subjectUserId ?? null,
        }).catch((err) => {
          this.logger.warn(`[push] Failed to send web push: ${err instanceof Error ? err.message : String(err)}`);
        });
      }
    } catch (err) {
      // Best-effort: never fail notification creation on push preference issues.
      this.logger.debug(`[push] Failed to evaluate push preferences: ${err}`);
    }

    return notification;
  }

  private async getPreferencesInternal(userId: string) {
    return await this.prisma.notificationPreferences.upsert({
      where: { userId },
      create: { userId },
      update: {},
    });
  }

  private shouldSendPushForKind(
    prefs: Pick<NotificationPreferencesDto, 'pushComment' | 'pushBoost' | 'pushFollow' | 'pushMention'>,
    kind: NotificationKind,
  ): boolean {
    if (kind === 'comment') return Boolean(prefs.pushComment);
    if (kind === 'boost') return Boolean(prefs.pushBoost);
    if (kind === 'follow') return Boolean(prefs.pushFollow);
    if (kind === 'mention') return Boolean(prefs.pushMention);
    // Other kinds currently don't produce push notifications.
    return true;
  }

  async getPreferences(userId: string): Promise<NotificationPreferencesDto> {
    const prefs = await this.getPreferencesInternal(userId);
    return {
      pushComment: Boolean(prefs.pushComment),
      pushBoost: Boolean(prefs.pushBoost),
      pushFollow: Boolean(prefs.pushFollow),
      pushMention: Boolean(prefs.pushMention),
      pushMessage: Boolean(prefs.pushMessage),
      emailDigestWeekly: Boolean(prefs.emailDigestWeekly),
      emailNewNotifications: Boolean(prefs.emailNewNotifications),
    };
  }

  async updatePreferences(userId: string, patch: Partial<NotificationPreferencesDto>): Promise<NotificationPreferencesDto> {
    const updated = await this.prisma.notificationPreferences.upsert({
      where: { userId },
      create: { userId, ...patch },
      update: patch,
    });
    return {
      pushComment: Boolean(updated.pushComment),
      pushBoost: Boolean(updated.pushBoost),
      pushFollow: Boolean(updated.pushFollow),
      pushMention: Boolean(updated.pushMention),
      pushMessage: Boolean(updated.pushMessage),
      emailDigestWeekly: Boolean(updated.emailDigestWeekly),
      emailNewNotifications: Boolean(updated.emailNewNotifications),
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

  /** Send a single test Web Push to the user (for "Send test notification" in settings). */
  async sendTestPush(userId: string): Promise<{ sent: boolean; message?: string }> {
    if (!this.appConfig.vapidConfigured()) {
      return { sent: false, message: 'Push notifications are not configured (VAPID).' };
    }
    const subs = await this.prisma.pushSubscription.findMany({
      where: { userId },
      select: { id: true, endpoint: true, p256dh: true, auth: true },
    });
    if (subs.length === 0) {
      return { sent: false, message: 'No push subscription for this account. Enable browser notifications first.' };
    }
    await this.sendWebPushToRecipient(userId, {
      title: 'Test notification',
      body: 'If you see this, push is working.',
      subjectPostId: null,
      test: true,
    });
    return { sent: true };
  }

  /** Send Web Push to all of a user's subscriptions; prune expired (410/404). */
  private async sendWebPushToRecipient(
    recipientUserId: string,
    params: {
      title: string;
      body?: string;
      subjectPostId?: string | null;
      subjectUserId?: string | null;
      test?: boolean;
      url?: string | null;
      tag?: string | null;
    },
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

    const defaultTag = params.test ? `notification-test-${Date.now()}` : `notification-${recipientUserId}`;
    const payload = JSON.stringify({
      title: params.title,
      body: params.body ?? 'You have a new notification.',
      url,
      tag: params.tag?.trim() || defaultTag,
      test: params.test === true,
    });

    const subs = await this.prisma.pushSubscription.findMany({
      where: { userId: recipientUserId },
      select: { id: true, endpoint: true, p256dh: true, auth: true },
    });

    if (subs.length === 0) {
      this.logger.debug(`[push] No subscriptions for user ${recipientUserId}; skipping web push.`);
      return;
    }

    for (const sub of subs) {
      try {
        await webpush.sendNotification(
          {
            endpoint: sub.endpoint,
            keys: { p256dh: sub.p256dh, auth: sub.auth },
          },
          payload,
          { TTL: 60 * 60 * 24 },
        );
      } catch (err: unknown) {
        const statusCode = (err as { statusCode?: number })?.statusCode;
        if (statusCode === 410 || statusCode === 404) {
          await this.prisma.pushSubscription.delete({ where: { id: sub.id } }).catch(() => {});
        }
      }
    }
  }

  async sendMessagePush(params: {
    recipientUserId: string;
    senderName: string;
    body?: string | null;
    conversationId: string;
  }): Promise<void> {
    try {
      const prefs = await this.getPreferencesInternal(params.recipientUserId);
      if (!prefs.pushMessage) return;
    } catch {
      // Best-effort: if prefs read fails, still attempt push (default behavior).
    }
    const sender = (params.senderName ?? '').trim();
    const title = sender ? `New message from ${sender}` : 'New message';
    const body = (params.body ?? '').trim().slice(0, 150) || undefined;
    const url = `/messages?c=${encodeURIComponent(params.conversationId)}`;
    const tag = `message-${params.conversationId}`;
    try {
      await this.sendWebPushToRecipient(params.recipientUserId, {
        title,
        body,
        url,
        tag,
      });
    } catch (err) {
      this.logger.warn(`[push] Failed to send DM web push: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Find existing boost notification for (recipient, actor, subject post). */
  async findExistingBoostNotification(
    recipientUserId: string,
    actorUserId: string,
    subjectPostId: string,
  ) {
    return this.prisma.notification.findFirst({
      where: {
        recipientUserId,
        actorUserId,
        subjectPostId,
        kind: 'boost',
      },
      select: { id: true, deliveredAt: true, readAt: true },
    });
  }

  /**
   * Create or overwrite boost notification: if one exists, update createdAt and body only
   * (surfaces to top; does not change delivered/read). Otherwise create.
   */
  async upsertBoostNotification(params: {
    recipientUserId: string;
    actorUserId: string;
    subjectPostId: string;
    bodySnippet?: string | null;
  }) {
    const { recipientUserId, actorUserId, subjectPostId, bodySnippet } = params;
    const existing = await this.findExistingBoostNotification(recipientUserId, actorUserId, subjectPostId);
    if (existing) {
      await this.prisma.notification.update({
        where: { id: existing.id },
        data: { createdAt: new Date(), body: bodySnippet ?? undefined },
      });
      // Treat as a new notification row for UI ordering (without changing delivered/read).
      try {
        const dto = await this.buildNotificationDtoForRecipient({
          recipientUserId,
          notificationId: existing.id,
        });
        if (dto) {
          this.presenceRealtime.emitNotificationNew(recipientUserId, { notification: dto });
        }
      } catch {
        // Best-effort
      }
      return;
    }
    await this.create({
      recipientUserId,
      kind: 'boost',
      actorUserId,
      subjectPostId,
      title: 'boosted your post',
      body: bodySnippet ?? undefined,
    });
  }

  /** Remove boost notification when user unboosts; emit updated count if the removed one was undelivered. */
  async deleteBoostNotification(
    recipientUserId: string,
    actorUserId: string,
    subjectPostId: string,
  ): Promise<void> {
    const existing = await this.findExistingBoostNotification(recipientUserId, actorUserId, subjectPostId);
    if (!existing) return;
    const wasUndelivered = existing.deliveredAt == null;
    await this.prisma.notification.delete({ where: { id: existing.id } });
    this.presenceRealtime.emitNotificationsDeleted(recipientUserId, { notificationIds: [existing.id] });
    if (wasUndelivered) {
      const undeliveredCount = await this.getUndeliveredCount(recipientUserId);
      this.presenceRealtime.emitNotificationsUpdated(recipientUserId, { undeliveredCount });
    }
  }

  private async deleteNotificationRowsAndEmit(
    rows: Array<{ id: string; recipientUserId: string; deliveredAt: Date | null }>,
  ): Promise<number> {
    const ids = rows.map((r) => r.id).filter(Boolean);
    if (ids.length === 0) return 0;

    await this.prisma.notification.deleteMany({ where: { id: { in: ids } } });

    const idsByRecipient = new Map<string, string[]>();
    const undeliveredRecipients = new Set<string>();
    for (const r of rows) {
      const uid = (r.recipientUserId ?? '').trim();
      if (!uid) continue;
      const list = idsByRecipient.get(uid) ?? [];
      list.push(r.id);
      idsByRecipient.set(uid, list);
      if (r.deliveredAt == null) undeliveredRecipients.add(uid);
    }

    for (const [uid, notifIds] of idsByRecipient) {
      this.presenceRealtime.emitNotificationsDeleted(uid, { notificationIds: notifIds });
    }

    for (const uid of undeliveredRecipients) {
      const undeliveredCount = await this.getUndeliveredCount(uid);
      this.presenceRealtime.emitNotificationsUpdated(uid, { undeliveredCount });
    }

    return ids.length;
  }

  /** Delete all notifications that reference this post as the subject (post is gone). */
  async deleteBySubjectPostId(subjectPostId: string): Promise<number> {
    const id = (subjectPostId ?? '').trim();
    if (!id) return 0;
    const rows = await this.prisma.notification.findMany({
      where: { subjectPostId: id },
      select: { id: true, recipientUserId: true, deliveredAt: true },
    });
    return await this.deleteNotificationRowsAndEmit(rows);
  }

  /** Delete all notifications caused by this post (e.g. replies or mentions) using actorPostId. */
  async deleteByActorPostId(actorPostId: string): Promise<number> {
    const id = (actorPostId ?? '').trim();
    if (!id) return 0;
    const rows = await this.prisma.notification.findMany({
      where: { actorPostId: id },
      select: { id: true, recipientUserId: true, deliveredAt: true },
    });
    return await this.deleteNotificationRowsAndEmit(rows);
  }

  /** Delete follow notifications for a relationship (used on unfollow). */
  async deleteFollowNotification(recipientUserId: string, actorUserId: string): Promise<number> {
    const recipient = (recipientUserId ?? '').trim();
    const actor = (actorUserId ?? '').trim();
    if (!recipient || !actor) return 0;
    const rows = await this.prisma.notification.findMany({
      where: { recipientUserId: recipient, actorUserId: actor, kind: 'follow' },
      select: { id: true, recipientUserId: true, deliveredAt: true },
    });
    return await this.deleteNotificationRowsAndEmit(rows);
  }

  async list(params: {
    recipientUserId: string;
    limit: number;
    cursor: string | null;
  }) {
    const { recipientUserId, limit, cursor } = params;
    const desiredItemLimit = Math.max(1, Math.min(limit, 50));
    const maxGroupNotifications = 50;
    const rawFetchLimit = Math.min(desiredItemLimit * 6, 250);

    const cursorWhere = await createdAtIdCursorWhere({
      cursor,
      lookup: async (id) =>
        this.prisma.notification
          .findUnique({
            where: { id, recipientUserId },
            select: { id: true, createdAt: true },
          })
          .then((r) => (r ? { id: r.id, createdAt: r.createdAt } : null)),
    });

    const notifications = await this.prisma.notification.findMany({
      where: {
        recipientUserId,
        ...(cursorWhere ? { AND: [cursorWhere] } : {}),
      },
      include: {
        actor: {
          select: {
            id: true,
            username: true,
            name: true,
            avatarKey: true,
            avatarUpdatedAt: true,
            premium: true,
            verifiedStatus: true,
          },
        },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: rawFetchLimit + 1,
    });

    const raw = notifications.slice(0, rawFetchLimit);
    const hasMoreRaw = notifications.length > rawFetchLimit;
    const undeliveredCount = await this.getUndeliveredCount(recipientUserId);

    const publicBaseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;
    const subjectPostIds = [...new Set(raw.map((n) => n.subjectPostId).filter(Boolean))] as string[];
    const subjectPosts =
      subjectPostIds.length > 0
        ? await this.prisma.post.findMany({
            where: { id: { in: subjectPostIds } },
            select: {
              id: true,
              body: true,
              visibility: true,
              media: { where: { deletedAt: null }, orderBy: { position: 'asc' }, select: { kind: true, r2Key: true, thumbnailR2Key: true, url: true } },
            },
          })
        : [];
    const subjectPreviewByPostId = new Map<string, SubjectPostPreviewDto>();
    const subjectTierByPostId = new Map<string, SubjectTier>();
    const subjectVisibilityByPostId = new Map<string, SubjectPostVisibility>();
    for (const p of subjectPosts) {
      const bodySnippet = (p.body ?? '').trim().slice(0, 150) || null;
      const media = (p.media ?? [])
        .map((m) => {
          const url =
            (m as { url?: string }).url?.trim() ||
            (publicAssetUrl({ publicBaseUrl, key: (m as { r2Key?: string }).r2Key ?? null }) ?? '');
          const thumbnailUrl =
            (publicAssetUrl({
              publicBaseUrl,
              key: (m as { thumbnailR2Key?: string }).thumbnailR2Key ?? null,
            }) ?? null) || null;
          return { url: url || '', thumbnailUrl, kind: (m as { kind: string }).kind };
        })
        .filter((m) => m.url);
      subjectPreviewByPostId.set(p.id, { bodySnippet, media });
      const vis = (p as { visibility?: string }).visibility;
      subjectTierByPostId.set(p.id, vis === 'premiumOnly' ? 'premium' : vis === 'verifiedOnly' ? 'verified' : null);
      if (vis === 'public' || vis === 'verifiedOnly' || vis === 'premiumOnly' || vis === 'onlyMe') {
        subjectVisibilityByPostId.set(p.id, vis);
      }
    }

    const subjectUserIds = [...new Set(raw.map((n) => n.subjectUserId).filter(Boolean))] as string[];
    const subjectUsers =
      subjectUserIds.length > 0
        ? await this.prisma.user.findMany({
            where: { id: { in: subjectUserIds } },
            select: { id: true, premium: true, verifiedStatus: true },
          })
        : [];
    const subjectTierByUserId = new Map<string, SubjectTier>();
    for (const u of subjectUsers) {
      const tier: SubjectTier = u.premium ? 'premium' : u.verifiedStatus !== 'none' ? 'verified' : null;
      subjectTierByUserId.set(u.id, tier);
    }

    const dtos: NotificationDto[] = raw.map((n) => {
      const preview = n.subjectPostId ? subjectPreviewByPostId.get(n.subjectPostId) ?? null : null;
      const subjectPostVisibility = n.subjectPostId ? subjectVisibilityByPostId.get(n.subjectPostId) ?? null : null;
      let subjectTier: SubjectTier = null;
      if (n.subjectPostId) subjectTier = subjectTierByPostId.get(n.subjectPostId) ?? null;
      else if (n.subjectUserId) subjectTier = subjectTierByUserId.get(n.subjectUserId) ?? null;
      return this.toNotificationDto(n, publicBaseUrl, preview, subjectPostVisibility, subjectTier);
    });

    function groupKey(n: NotificationDto): string | null {
      if (n.kind === 'boost' && n.subjectPostId) return `boost:post:${n.subjectPostId}`;
      if (n.kind === 'comment' && n.subjectPostId) return `comment:post:${n.subjectPostId}`;
      if (n.kind === 'follow') return 'follow';
      if (n.kind === 'followed_post' && n.actor?.id) return `followed_post:actor:${n.actor.id}`;
      if (n.kind === 'nudge' && n.actor?.id) return `nudge:actor:${n.actor.id}`;
      return null;
    }

    function groupKindFromKey(key: string): NotificationGroupKind | null {
      if (key.startsWith('boost:')) return 'boost';
      if (key.startsWith('comment:')) return 'comment';
      if (key === 'follow') return 'follow';
      if (key.startsWith('followed_post:')) return 'followed_post';
      if (key.startsWith('nudge:')) return 'nudge';
      return null;
    }

    function buildGroup(members: NotificationDto[], key: string): NotificationGroupDto {
      const newest = members[0]!;
      const kind = groupKindFromKey(key) ?? (newest.kind as NotificationGroupKind);
      const anyUndelivered = members.some((m) => m.deliveredAt == null);
      const anyUnread = members.some((m) => m.readAt == null);

      const actors: NotificationActorDto[] = [];
      const actorIds = new Set<string>();
      for (const m of members) {
        const a = m.actor;
        if (!a?.id) continue;
        if (actorIds.has(a.id)) continue;
        actorIds.add(a.id);
        actors.push(a);
      }

      const latestBody =
        kind === 'comment' ? (members.find((m) => (m.body ?? '').trim())?.body ?? null) : null;

      const subjectPostId = (kind === 'boost' || kind === 'comment') ? (newest.subjectPostId ?? null) : null;
      const subjectUserId =
        kind === 'follow'
          ? (newest.actor?.id ?? newest.subjectUserId ?? null)
          : kind === 'nudge'
            ? (newest.actor?.id ?? newest.subjectUserId ?? null)
          : kind === 'followed_post'
            ? (newest.actor?.id ?? null)
            : null;

      return {
        id: newest.id,
        kind,
        createdAt: newest.createdAt,
        deliveredAt: anyUndelivered ? null : newest.deliveredAt,
        readAt: anyUnread ? null : newest.readAt,
        subjectPostId,
        subjectUserId,
        actors,
        actorCount: actors.length,
        count: members.length,
        latestBody,
        latestSubjectPostPreview: newest.subjectPostPreview ?? null,
        subjectPostVisibility: newest.subjectPostVisibility ?? null,
        subjectTier: newest.subjectTier ?? null,
      };
    }

    const items: NotificationFeedItemDto[] = [];
    let i = 0;
    while (i < dtos.length && items.length < desiredItemLimit) {
      const n = dtos[i]!;
      const key = groupKey(n);
      if (!key) {
        items.push({ type: 'single', notification: n });
        i += 1;
        continue;
      }

      const members: NotificationDto[] = [n];
      let j = i + 1;
      while (j < dtos.length && groupKey(dtos[j]!) === key && members.length < maxGroupNotifications) {
        members.push(dtos[j]!);
        j += 1;
      }

      if (members.length === 1) {
        items.push({ type: 'single', notification: n });
        i += 1;
        continue;
      }

      items.push({ type: 'group', group: buildGroup(members, key) });
      i = j;
    }

    const lastConsumedId = i > 0 ? dtos[i - 1]?.id ?? null : null;
    const hasMore = i < dtos.length || hasMoreRaw;
    const nextCursor = hasMore ? lastConsumedId : null;

    return {
      items,
      nextCursor,
      undeliveredCount,
    };
  }

  async getUndeliveredCount(recipientUserId: string): Promise<number> {
    return this.prisma.notification.count({
      where: { recipientUserId, deliveredAt: null },
    });
  }

  async markDelivered(recipientUserId: string): Promise<void> {
    await this.prisma.notification.updateMany({
      where: { recipientUserId, deliveredAt: null },
      data: { deliveredAt: new Date() },
    });
    const undeliveredCount = await this.getUndeliveredCount(recipientUserId);
    this.presenceRealtime.emitNotificationsUpdated(recipientUserId, {
      undeliveredCount,
    });
  }

  async markReadBySubject(
    recipientUserId: string,
    params: { postId?: string | null; userId?: string | null },
  ): Promise<void> {
    const { postId, userId } = params;
    if (!postId && !userId) return;

    // Back-compat: followed_post notifications were historically keyed only by actorUserId.
    // When visiting a user's profile we want to clear "new posts" notifications for that actor,
    // even if subjectUserId was not set at creation time.
    const or: Array<Record<string, unknown>> = [];
    if (postId) or.push({ subjectPostId: postId });
    if (userId) {
      // Important: do NOT implicitly mark nudges as read when visiting a user's profile.
      // Nudges should only be cleared via explicit actions (ignore / acknowledge / nudge back).
      or.push({ subjectUserId: userId, kind: { not: 'nudge' } });
      or.push({ kind: 'followed_post', actorUserId: userId });
    }
    const where = {
      recipientUserId,
      readAt: null,
      ...(or.length ? { OR: or } : {}),
    } as const;

    await this.prisma.notification.updateMany({
      where,
      data: { readAt: new Date() },
    });

    // Also mark as delivered (seen) when visiting the post/profile, then emit updated count.
    const deliveredWhere = { ...where, deliveredAt: null } as const;
    await this.prisma.notification.updateMany({
      where: deliveredWhere,
      data: { deliveredAt: new Date() },
    });
    const undeliveredCount = await this.getUndeliveredCount(recipientUserId);
    this.presenceRealtime.emitNotificationsUpdated(recipientUserId, {
      undeliveredCount,
    });
  }

  async markReadById(
    recipientUserId: string,
    notificationId: string,
  ): Promise<boolean> {
    const result = await this.prisma.notification.updateMany({
      where: { id: notificationId, recipientUserId, readAt: null },
      data: { readAt: new Date() },
    });
    if (result.count > 0) {
      await this.prisma.notification.updateMany({
        where: { id: notificationId, recipientUserId, deliveredAt: null },
        data: { deliveredAt: new Date() },
      });
      const undeliveredCount = await this.getUndeliveredCount(recipientUserId);
      this.presenceRealtime.emitNotificationsUpdated(recipientUserId, {
        undeliveredCount,
      });
    }
    return result.count > 0;
  }

  /**
   * Mark a notification as ignored (used for nudges).
   * Semantics:
   * - Clears unread highlight (readAt set)
   * - Clears badge if undelivered (deliveredAt set)
   * - Persists ignoredAt so the sender can remain rate-limited for a while
   */
  async ignoreById(
    recipientUserId: string,
    notificationId: string,
  ): Promise<boolean> {
    const now = new Date();
    const result = await this.prisma.notification.updateMany({
      where: { id: notificationId, recipientUserId, ignoredAt: null },
      data: { ignoredAt: now, readAt: now },
    });
    if (result.count > 0) {
      await this.prisma.notification.updateMany({
        where: { id: notificationId, recipientUserId, deliveredAt: null },
        data: { deliveredAt: now },
      });
      const undeliveredCount = await this.getUndeliveredCount(recipientUserId);
      this.presenceRealtime.emitNotificationsUpdated(recipientUserId, {
        undeliveredCount,
      });
    }
    return result.count > 0;
  }

  async markNudgesReadByActor(
    recipientUserId: string,
    actorUserId: string,
  ): Promise<number> {
    const recipient = (recipientUserId ?? '').trim();
    const actor = (actorUserId ?? '').trim();
    if (!recipient || !actor) return 0;
    const now = new Date();
    const result = await this.prisma.notification.updateMany({
      where: {
        recipientUserId: recipient,
        kind: 'nudge',
        actorUserId: actor,
        readAt: null,
      },
      data: { readAt: now },
    });
    if (result.count > 0) {
      await this.prisma.notification.updateMany({
        where: {
          recipientUserId: recipient,
          kind: 'nudge',
          actorUserId: actor,
          deliveredAt: null,
        },
        data: { deliveredAt: now },
      });
      const undeliveredCount = await this.getUndeliveredCount(recipient);
      this.presenceRealtime.emitNotificationsUpdated(recipient, { undeliveredCount });
    }
    return result.count;
  }

  async markNudgesNudgedBackByActor(
    recipientUserId: string,
    actorUserId: string,
  ): Promise<number> {
    const recipient = (recipientUserId ?? '').trim();
    const actor = (actorUserId ?? '').trim();
    if (!recipient || !actor) return 0;
    const now = new Date();
    const result = await this.prisma.notification.updateMany({
      where: {
        recipientUserId: recipient,
        kind: 'nudge',
        actorUserId: actor,
        nudgedBackAt: null,
      },
      data: { nudgedBackAt: now, readAt: now },
    });
    if (result.count > 0) {
      await this.prisma.notification.updateMany({
        where: {
          recipientUserId: recipient,
          kind: 'nudge',
          actorUserId: actor,
          deliveredAt: null,
        },
        data: { deliveredAt: now },
      });
      const undeliveredCount = await this.getUndeliveredCount(recipient);
      this.presenceRealtime.emitNotificationsUpdated(recipient, { undeliveredCount });
    }
    return result.count;
  }

  async markNudgeNudgedBackById(
    recipientUserId: string,
    notificationId: string,
  ): Promise<boolean> {
    const now = new Date();
    const result = await this.prisma.notification.updateMany({
      where: { id: notificationId, recipientUserId, kind: 'nudge', nudgedBackAt: null },
      data: { nudgedBackAt: now, readAt: now },
    });
    if (result.count > 0) {
      await this.prisma.notification.updateMany({
        where: { id: notificationId, recipientUserId, deliveredAt: null },
        data: { deliveredAt: now },
      });
      const undeliveredCount = await this.getUndeliveredCount(recipientUserId);
      this.presenceRealtime.emitNotificationsUpdated(recipientUserId, { undeliveredCount });
    }
    return result.count > 0;
  }

  async ignoreNudgesByActor(
    recipientUserId: string,
    actorUserId: string,
  ): Promise<number> {
    const recipient = (recipientUserId ?? '').trim();
    const actor = (actorUserId ?? '').trim();
    if (!recipient || !actor) return 0;
    const now = new Date();
    const result = await this.prisma.notification.updateMany({
      where: {
        recipientUserId: recipient,
        kind: 'nudge',
        actorUserId: actor,
        ignoredAt: null,
      },
      data: { ignoredAt: now, readAt: now },
    });
    if (result.count > 0) {
      await this.prisma.notification.updateMany({
        where: {
          recipientUserId: recipient,
          kind: 'nudge',
          actorUserId: actor,
          deliveredAt: null,
        },
        data: { deliveredAt: now },
      });
      const undeliveredCount = await this.getUndeliveredCount(recipient);
      this.presenceRealtime.emitNotificationsUpdated(recipient, { undeliveredCount });
    }
    return result.count;
  }

  /** Mark all of the user's notifications as read and as seen (clears highlight and badge). */
  async markAllRead(recipientUserId: string): Promise<void> {
    const now = new Date();
    await this.prisma.notification.updateMany({
      where: { recipientUserId, readAt: null },
      data: { readAt: now },
    });
    await this.prisma.notification.updateMany({
      where: { recipientUserId, deliveredAt: null },
      data: { deliveredAt: now },
    });
    const undeliveredCount = await this.getUndeliveredCount(recipientUserId);
    this.presenceRealtime.emitNotificationsUpdated(recipientUserId, {
      undeliveredCount,
    });
  }

  private toNotificationDto(
    n: {
      id: string;
      createdAt: Date;
      kind: NotificationKind;
      deliveredAt: Date | null;
      readAt: Date | null;
      ignoredAt: Date | null;
      nudgedBackAt: Date | null;
      actorPostId: string | null;
      subjectPostId: string | null;
      subjectUserId: string | null;
      title: string | null;
      body: string | null;
      actor: {
        id: string;
        username: string | null;
        name: string | null;
        avatarKey: string | null;
        avatarUpdatedAt: Date | null;
        premium: boolean;
        verifiedStatus: string;
      } | null;
    },
    publicBaseUrl: string | null,
    subjectPostPreview?: SubjectPostPreviewDto | null,
    subjectPostVisibility: SubjectPostVisibility | null = null,
    subjectTier: SubjectTier = null,
  ): NotificationDto {
    let actor: NotificationActorDto | null = null;
    if (n.actor) {
      actor = {
        id: n.actor.id,
        username: n.actor.username,
        name: n.actor.name,
        avatarUrl: publicAssetUrl({
          publicBaseUrl,
          key: n.actor.avatarKey,
          updatedAt: n.actor.avatarUpdatedAt,
        }),
        premium: n.actor.premium,
        verifiedStatus: n.actor.verifiedStatus,
      };
    }
    return {
      id: n.id,
      createdAt: n.createdAt.toISOString(),
      kind: n.kind,
      deliveredAt: n.deliveredAt ? n.deliveredAt.toISOString() : null,
      readAt: n.readAt ? n.readAt.toISOString() : null,
      ignoredAt: n.ignoredAt ? n.ignoredAt.toISOString() : null,
      nudgedBackAt: n.nudgedBackAt ? n.nudgedBackAt.toISOString() : null,
      actor,
      actorPostId: n.actorPostId,
      subjectPostId: n.subjectPostId,
      subjectUserId: n.subjectUserId,
      title: n.title,
      body: n.body,
      subjectPostPreview: subjectPostPreview ?? null,
      subjectPostVisibility,
      subjectTier,
    };
  }

  private async buildNotificationDtoForRecipient(params: {
    recipientUserId: string;
    notificationId: string;
  }): Promise<NotificationDto | null> {
    const { recipientUserId, notificationId } = params;
    const id = (notificationId ?? '').trim();
    if (!id) return null;

    const n = await this.prisma.notification.findFirst({
      where: { id, recipientUserId },
      include: {
        actor: {
          select: {
            id: true,
            username: true,
            name: true,
            avatarKey: true,
            avatarUpdatedAt: true,
            premium: true,
            verifiedStatus: true,
          },
        },
      },
    });
    if (!n) return null;

    const publicBaseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;

    let subjectPostPreview: SubjectPostPreviewDto | null = null;
    let subjectTier: SubjectTier = null;
    let subjectPostVisibility: SubjectPostVisibility | null = null;

    if (n.subjectPostId) {
      const p = await this.prisma.post.findUnique({
        where: { id: n.subjectPostId },
        select: {
          id: true,
          body: true,
          visibility: true,
          media: {
            where: { deletedAt: null },
            orderBy: { position: 'asc' },
            select: { kind: true, r2Key: true, thumbnailR2Key: true, url: true },
          },
        },
      });
      if (p) {
        const bodySnippet = (p.body ?? '').trim().slice(0, 150) || null;
        const media = (p.media ?? [])
          .map((m) => {
            const url =
              (m as { url?: string }).url?.trim() ||
              (publicAssetUrl({ publicBaseUrl, key: (m as { r2Key?: string }).r2Key ?? null }) ?? '');
            const thumbnailUrl =
              (publicAssetUrl({
                publicBaseUrl,
                key: (m as { thumbnailR2Key?: string }).thumbnailR2Key ?? null,
              }) ?? null) || null;
            return { url: url || '', thumbnailUrl, kind: (m as { kind: string }).kind };
          })
          .filter((m) => m.url);
        subjectPostPreview = { bodySnippet, media };
        const vis = (p as { visibility?: string }).visibility;
        subjectTier = vis === 'premiumOnly' ? 'premium' : vis === 'verifiedOnly' ? 'verified' : null;
        if (vis === 'public' || vis === 'verifiedOnly' || vis === 'premiumOnly' || vis === 'onlyMe') {
          subjectPostVisibility = vis;
        }
      }
    } else if (n.subjectUserId) {
      const u = await this.prisma.user.findUnique({
        where: { id: n.subjectUserId },
        select: { id: true, premium: true, verifiedStatus: true },
      });
      if (u) {
        subjectTier = u.premium ? 'premium' : u.verifiedStatus !== 'none' ? 'verified' : null;
      }
    }

    return this.toNotificationDto(n, publicBaseUrl, subjectPostPreview, subjectPostVisibility, subjectTier);
  }
}
