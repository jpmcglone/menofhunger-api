import { Injectable, Logger } from '@nestjs/common';
import type { NotificationKind } from '@prisma/client';
import * as webpush from 'web-push';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfigService } from '../app/app-config.service';
import { publicAssetUrl } from '../../common/assets/public-asset-url';
import { createdAtIdCursorWhere } from '../../common/pagination/created-at-id-cursor';
import { PresenceGateway } from '../presence/presence.gateway';
import type { NotificationActorDto, NotificationDto, SubjectPostPreviewDto, SubjectTier } from './notification.dto';

export type CreateNotificationParams = {
  recipientUserId: string;
  kind: NotificationKind;
  actorUserId?: string | null;
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
    private readonly presenceGateway: PresenceGateway,
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
      subjectPostId,
      subjectUserId,
      title,
      body,
    } = params;

    const notification = await this.prisma.notification.create({
      data: {
        recipientUserId,
        kind,
        actorUserId: actorUserId ?? undefined,
        subjectPostId: subjectPostId ?? undefined,
        subjectUserId: subjectUserId ?? undefined,
        title: title ?? undefined,
        body: body ?? undefined,
      },
    });

    const undeliveredCount = await this.getUndeliveredCount(recipientUserId);
    this.presenceGateway.emitNotificationsUpdated(recipientUserId, {
      undeliveredCount,
    });

    this.sendWebPushToRecipient(recipientUserId, {
      title: title ?? 'New notification',
      body: (body ?? '').trim().slice(0, 150) || undefined,
      subjectPostId: subjectPostId ?? null,
    }).catch((err) => {
      this.logger.warn(`[push] Failed to send web push: ${err instanceof Error ? err.message : String(err)}`);
    });

    return notification;
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
    params: { title: string; body?: string; subjectPostId?: string | null; test?: boolean },
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

    const origins = this.appConfig.allowedOrigins();
    const baseUrl = origins[0]?.trim() || 'https://menofhunger.com';
    const url = params.subjectPostId
      ? `${baseUrl.replace(/\/$/, '')}/p/${params.subjectPostId}`
      : `${baseUrl.replace(/\/$/, '')}/notifications`;

    const payload = JSON.stringify({
      title: params.title,
      body: params.body ?? 'You have a new notification.',
      url,
      tag: params.test ? 'notification-test' : `notification-${recipientUserId}`,
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
      return;
    }
    await this.create({
      recipientUserId,
      kind: 'boost',
      actorUserId,
      subjectPostId,
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
    if (wasUndelivered) {
      const undeliveredCount = await this.getUndeliveredCount(recipientUserId);
      this.presenceGateway.emitNotificationsUpdated(recipientUserId, { undeliveredCount });
    }
  }

  async list(params: {
    recipientUserId: string;
    limit: number;
    cursor: string | null;
  }) {
    const { recipientUserId, limit, cursor } = params;

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
      take: limit + 1,
    });

    const slice = notifications.slice(0, limit);
    const nextCursor =
      notifications.length > limit ? slice[slice.length - 1]?.id ?? null : null;
    const undeliveredCount = await this.getUndeliveredCount(recipientUserId);

    const publicBaseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;
    const subjectPostIds = [...new Set(slice.map((n) => n.subjectPostId).filter(Boolean))] as string[];
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
    }

    const subjectUserIds = [...new Set(slice.map((n) => n.subjectUserId).filter(Boolean))] as string[];
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

    const data: NotificationDto[] = slice.map((n) => {
      const preview = n.subjectPostId ? subjectPreviewByPostId.get(n.subjectPostId) ?? null : null;
      let subjectTier: SubjectTier = null;
      if (n.subjectPostId) subjectTier = subjectTierByPostId.get(n.subjectPostId) ?? null;
      else if (n.subjectUserId) subjectTier = subjectTierByUserId.get(n.subjectUserId) ?? null;
      return this.toNotificationDto(n, publicBaseUrl, preview, subjectTier);
    });

    return {
      notifications: data,
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
    this.presenceGateway.emitNotificationsUpdated(recipientUserId, {
      undeliveredCount,
    });
  }

  async markReadBySubject(
    recipientUserId: string,
    params: { postId?: string | null; userId?: string | null },
  ): Promise<void> {
    const { postId, userId } = params;
    if (!postId && !userId) return;

    const where: { recipientUserId: string; readAt: null; subjectPostId?: string; subjectUserId?: string } = {
      recipientUserId,
      readAt: null,
    };
    if (postId) where.subjectPostId = postId;
    if (userId) where.subjectUserId = userId;

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
    this.presenceGateway.emitNotificationsUpdated(recipientUserId, {
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
      this.presenceGateway.emitNotificationsUpdated(recipientUserId, {
        undeliveredCount,
      });
    }
    return result.count > 0;
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
    this.presenceGateway.emitNotificationsUpdated(recipientUserId, {
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
      actor,
      subjectPostId: n.subjectPostId,
      subjectUserId: n.subjectUserId,
      title: n.title,
      body: n.body,
      subjectPostPreview: subjectPostPreview ?? null,
      subjectTier,
    };
  }
}
