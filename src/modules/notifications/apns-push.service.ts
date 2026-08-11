import { Injectable, Logger } from '@nestjs/common';
import { ApnsClient, ApnsError, Host, Notification as ApnsNotification } from 'apns2';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfigService } from '../app/app-config.service';
import { CacheService } from '../redis/cache.service';
import { RedisKeys } from '../redis/redis-keys';
import { CacheTtl } from '../redis/cache-ttl';

export type ApnsEnvironment = 'production' | 'sandbox';

/** APNs error reasons that mean the device token is permanently dead and must be pruned. */
const PRUNE_REASONS = new Set(['BadDeviceToken', 'Unregistered', 'DeviceTokenNotForTopic']);
const NOTIFICATION_PUSH_SOUND = 'notification.caf';
const MESSAGE_PUSH_SOUND = 'new-message.caf';
/** Collapse id so rapid badge syncs replace each other instead of queuing. */
const BADGE_SYNC_COLLAPSE_ID = 'badge-sync';

/**
 * Native iOS push (APNs) delivery via HTTP/2 token-based auth (.p8 key).
 *
 * Device-token registry lives in `ApnsDeviceToken`; tokens are upserted by the
 * iOS client on launch/login and removed on logout. Sandbox tokens (dev builds)
 * are routed to the APNs sandbox host.
 *
 * Delivery is best-effort: failures are logged, dead tokens (410 / BadDeviceToken)
 * are pruned, and nothing here ever throws into the caller's flow.
 */
@Injectable()
export class ApnsPushService {
  private readonly logger = new Logger(ApnsPushService.name);
  private clients: Partial<Record<ApnsEnvironment, ApnsClient>> = {};
  /** Last badge-only value sent per user — skip no-op syncs in this process. */
  private readonly lastBadgeByUserId = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly appConfig: AppConfigService,
    private readonly cache: CacheService,
  ) {}

  configured(): boolean {
    try {
      return this.appConfig.apnsConfigured();
    } catch {
      return false;
    }
  }

  /** Upsert an APNs device token for a user (idempotent; steals from a prior account on the same device). */
  async registerToken(
    userId: string,
    params: { token: string; environment?: string | null },
  ): Promise<void> {
    const token = (params.token ?? '').trim();
    if (!token) return;
    const environment: ApnsEnvironment = params.environment === 'sandbox' ? 'sandbox' : 'production';

    // Rebind first so we know the old userId before overwriting.
    const existing = await this.prisma.apnsDeviceToken.findUnique({
      where: { token },
      select: { userId: true },
    });
    const prevUserId = existing?.userId;

    await this.prisma.apnsDeviceToken.upsert({
      where: { token },
      create: { userId, token, environment, lastSeenAt: new Date() },
      // Token is unique per device — if another user registered it before
      // (account switch on the same phone), rebind it to the current user.
      update: { userId, environment, lastSeenAt: new Date() },
    });

    // Invalidate token cache for the new owner (and prior owner if it changed).
    void this.cache.del(RedisKeys.pushApnsTokens(userId)).catch(() => undefined);
    if (prevUserId && prevUserId !== userId) {
      void this.cache.del(RedisKeys.pushApnsTokens(prevUserId)).catch(() => undefined);
    }
  }

  /** Remove an APNs device token (logout). Only deletes the caller's own binding. */
  async unregisterToken(userId: string, token: string): Promise<void> {
    const trimmed = (token ?? '').trim();
    if (!trimmed) return;
    await this.prisma.apnsDeviceToken.deleteMany({ where: { userId, token: trimmed } });
    void this.cache.del(RedisKeys.pushApnsTokens(userId)).catch(() => undefined);
  }

  /** True if the user has at least one registered device token. */
  async hasTokens(userId: string): Promise<boolean> {
    const count = await this.prisma.apnsDeviceToken.count({ where: { userId } });
    return count > 0;
  }

  /**
   * App icon badge = bell undelivered + groups undelivered — matches iOS
   * `notificationCount + groupsUnreadTotal`.
   */
  async computeAppIconBadge(userId: string): Promise<number> {
    const uid = (userId ?? '').trim();
    if (!uid) return 0;
    const [user, groupsUnread] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: uid },
        select: { undeliveredNotificationCount: true },
      }),
      this.prisma.notification.count({
        where: {
          recipientUserId: uid,
          kind: 'community_group_post',
          deliveredAt: null,
        },
      }),
    ]);
    const bell = Math.max(0, Math.floor(Number(user?.undeliveredNotificationCount) || 0));
    const groups = Math.max(0, Math.floor(groupsUnread || 0));
    return bell + groups;
  }

  /**
   * Badge-only APNs (no alert/sound) so the home-screen icon updates while the
   * app is backgrounded after mark-delivered / mark-read / group-seen.
   */
  async sendBadgeOnly(recipientUserId: string, badge?: number | null): Promise<void> {
    const uid = (recipientUserId ?? '').trim();
    if (!uid || !this.configured()) return;

    const next =
      typeof badge === 'number' && Number.isFinite(badge)
        ? Math.max(0, Math.floor(badge))
        : await this.computeAppIconBadge(uid);
    if (this.lastBadgeByUserId.get(uid) === next) return;
    this.lastBadgeByUserId.set(uid, next);

    await this.deliverToTokens(uid, (token) => {
      return new ApnsNotification(token, {
        badge: next,
        collapseId: BADGE_SYNC_COLLAPSE_ID,
      });
    });
  }

  /** Fire-and-forget badge sync used from read-state paths. Never throws. */
  syncAppIconBadge(recipientUserId: string, badge?: number | null): void {
    void this.sendBadgeOnly(recipientUserId, badge).catch((err) => {
      this.logger.warn(
        `[apns] badge sync failed for ${recipientUserId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }

  /**
   * Send an alert push to all of a user's devices. Badge defaults to bell + groups
   * undelivered so the app icon mirrors the in-app badge.
   */
  async sendToUser(
    recipientUserId: string,
    params: {
      title: string;
      body?: string | null;
      /** Click-through URL (absolute or path); the iOS client deep-links from it. */
      url?: string | null;
      notificationId?: string | null;
      kind?: string;
      /** Collapse identifier (mirrors the web push tag). Max 64 bytes per APNs. */
      collapseId?: string | null;
      badge?: number | null;
      mutableContent?: boolean;
      threadId?: string | null;
      category?: string | null;
      subtitle?: string | null;
      avatarUrl?: string | null;
      mediaUrl?: string | null;
      actorUsername?: string | null;
      actorName?: string | null;
      groupInviteId?: string | null;
      postId?: string | null;
    },
  ): Promise<void> {
    const cfg = this.appConfig.apns();
    if (!cfg) return;

    const badge =
      params.badge ??
      (await this.computeAppIconBadge(recipientUserId).catch(() => 0));
    this.lastBadgeByUserId.set(recipientUserId, Math.max(0, Math.floor(badge || 0)));

    const collapseId = (params.collapseId ?? '').slice(0, 64) || undefined;
    const data: Record<string, unknown> = {};
    if (params.url) data.url = params.url;
    if (params.notificationId) data.notificationId = params.notificationId;
    if (params.kind) data.kind = params.kind;
    if (params.avatarUrl) data.avatarUrl = params.avatarUrl;
    if (params.mediaUrl) data.mediaUrl = params.mediaUrl;
    if (params.actorUsername) data.actorUsername = params.actorUsername;
    if (params.actorName) data.actorName = params.actorName;
    if (params.groupInviteId) data.groupInviteId = params.groupInviteId;
    if (params.postId) data.postId = params.postId;

    await this.deliverToTokens(recipientUserId, (token) => {
      const subtitle = (params.subtitle ?? '').trim();
      return new ApnsNotification(token, {
        alert: {
          title: params.title,
          ...(subtitle ? { subtitle } : {}),
          body: (params.body ?? '').trim() || ' ',
        },
        sound: this.soundForKind(params.kind),
        badge: Math.max(0, Math.floor(badge || 0)),
        ...(collapseId ? { collapseId } : {}),
        ...(params.mutableContent ? { mutableContent: true } : {}),
        ...(params.threadId ? { threadId: params.threadId } : {}),
        ...(params.category ? { category: params.category } : {}),
        data,
      });
    });
  }

  /**
   * Diagnostic-only: sends a test push to every device token the user has and
   * returns per-token results including the raw APNs error reason. Only call this
   * from admin/test endpoints — production pushes use sendToUser() instead.
   */
  async sendDiagnosticToUser(
    recipientUserId: string,
    params: {
      title: string;
      body: string;
      url: string;
      subtitle?: string | null;
      avatarUrl?: string | null;
      mediaUrl?: string | null;
      actorUsername?: string | null;
      actorName?: string | null;
    },
  ): Promise<Array<{ token: string; environment: string; success: boolean; error?: string }>> {
    const cfg = this.appConfig.apns();
    if (!cfg) return [];

    const tokens = await this.prisma.apnsDeviceToken.findMany({
      where: { userId: recipientUserId },
      select: { id: true, token: true, environment: true },
    });
    const results: Array<{ token: string; environment: string; success: boolean; error?: string }> = [];
    for (const row of tokens) {
      const environment: ApnsEnvironment = row.environment === 'sandbox' ? 'sandbox' : 'production';
      const client = this.freshClientFor(environment, cfg);
      const notification = new ApnsNotification(row.token, {
        alert: {
          title: params.title,
          ...((params.subtitle ?? '').trim() ? { subtitle: (params.subtitle ?? '').trim() } : {}),
          body: params.body,
        },
        sound: NOTIFICATION_PUSH_SOUND,
        badge: 0,
        mutableContent: true,
        threadId: 'test-ios-push',
        data: {
          url: params.url,
          kind: 'generic',
          avatarUrl: params.avatarUrl ?? undefined,
          mediaUrl: params.mediaUrl ?? undefined,
          actorUsername: params.actorUsername ?? undefined,
          actorName: params.actorName ?? undefined,
        },
      });
      try {
        await client.send(notification);
        results.push({ token: row.token.slice(-8), environment, success: true });
      } catch (err) {
        const reason = err instanceof ApnsError ? err.reason : String(err);
        const statusCode = err instanceof ApnsError ? String(err.statusCode) : undefined;
        results.push({
          token: row.token.slice(-8),
          environment,
          success: false,
          error: statusCode ? `${statusCode} ${reason}` : reason,
        });
        if (err instanceof ApnsError && (err.statusCode === 410 || PRUNE_REASONS.has(err.reason))) {
          await this.prisma.apnsDeviceToken.deleteMany({ where: { id: row.id } }).catch(() => {});
        }
      }
    }
    return results;
  }

  private async deliverToTokens(
    recipientUserId: string,
    build: (token: string) => InstanceType<typeof ApnsNotification>,
  ): Promise<void> {
    const cfg = this.appConfig.apns();
    if (!cfg) return;

    type TokenRow = { id: string; token: string; environment: string };
    const tokens = await this.cache.getOrSetJson<TokenRow[]>({
      enabled: Boolean(recipientUserId),
      key: RedisKeys.pushApnsTokens(recipientUserId),
      ttlSeconds: CacheTtl.pushApnsTokensSeconds,
      compute: () =>
        this.prisma.apnsDeviceToken.findMany({
          where: { userId: recipientUserId },
          select: { id: true, token: true, environment: true },
        }),
    });
    if (tokens.length === 0) return;

    const deadTokenIds: string[] = [];
    for (const row of tokens) {
      const environment: ApnsEnvironment = row.environment === 'sandbox' ? 'sandbox' : 'production';
      const client = this.clientFor(environment, cfg);
      try {
        await client.send(build(row.token));
      } catch (err) {
        if (err instanceof ApnsError && (err.statusCode === 410 || PRUNE_REASONS.has(err.reason))) {
          deadTokenIds.push(row.id);
        } else {
          this.logger.warn(
            `[apns] Failed to send push to user ${recipientUserId}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }

    if (deadTokenIds.length > 0) {
      await this.prisma.apnsDeviceToken
        .deleteMany({ where: { id: { in: deadTokenIds } } })
        .catch(() => {});
      void this.cache.del(RedisKeys.pushApnsTokens(recipientUserId)).catch(() => undefined);
    }
  }

  private clientFor(
    environment: ApnsEnvironment,
    cfg: NonNullable<ReturnType<AppConfigService['apns']>>,
  ): ApnsClient {
    const existing = this.clients[environment];
    if (existing) return existing;
    const client = this.freshClientFor(environment, cfg);
    this.clients[environment] = client;
    return client;
  }

  /** Always constructs a new ApnsClient (not cached). Used by diagnostics. */
  private freshClientFor(
    environment: ApnsEnvironment,
    cfg: NonNullable<ReturnType<AppConfigService['apns']>>,
  ): ApnsClient {
    return new ApnsClient({
      team: cfg.teamId,
      keyId: cfg.keyId,
      signingKey: cfg.privateKey,
      defaultTopic: cfg.bundleId,
      host: environment === 'sandbox' ? Host.development : Host.production,
      requestTimeout: 10_000,
    });
  }

  private soundForKind(kind?: string): string {
    return kind === 'message' ? MESSAGE_PUSH_SOUND : NOTIFICATION_PUSH_SOUND;
  }
}
