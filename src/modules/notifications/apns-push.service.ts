import { Injectable, Logger } from '@nestjs/common';
import { ApnsClient, ApnsError, Host, Notification as ApnsNotification } from 'apns2';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfigService } from '../app/app-config.service';

export type ApnsEnvironment = 'production' | 'sandbox';

/** APNs error reasons that mean the device token is permanently dead and must be pruned. */
const PRUNE_REASONS = new Set(['BadDeviceToken', 'Unregistered', 'DeviceTokenNotForTopic']);
const NOTIFICATION_PUSH_SOUND = 'notification.caf';
const MESSAGE_PUSH_SOUND = 'new-message.caf';

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

  constructor(
    private readonly prisma: PrismaService,
    private readonly appConfig: AppConfigService,
  ) {}

  configured(): boolean {
    return this.appConfig.apnsConfigured();
  }

  /** Upsert an APNs device token for a user (idempotent; steals from a prior account on the same device). */
  async registerToken(
    userId: string,
    params: { token: string; environment?: string | null },
  ): Promise<void> {
    const token = (params.token ?? '').trim();
    if (!token) return;
    const environment: ApnsEnvironment = params.environment === 'sandbox' ? 'sandbox' : 'production';

    await this.prisma.apnsDeviceToken.upsert({
      where: { token },
      create: { userId, token, environment, lastSeenAt: new Date() },
      // Token is unique per device — if another user registered it before
      // (account switch on the same phone), rebind it to the current user.
      update: { userId, environment, lastSeenAt: new Date() },
    });
  }

  /** Remove an APNs device token (logout). Only deletes the caller's own binding. */
  async unregisterToken(userId: string, token: string): Promise<void> {
    const trimmed = (token ?? '').trim();
    if (!trimmed) return;
    await this.prisma.apnsDeviceToken.deleteMany({ where: { userId, token: trimmed } });
  }

  /** True if the user has at least one registered device token. */
  async hasTokens(userId: string): Promise<boolean> {
    const count = await this.prisma.apnsDeviceToken.count({ where: { userId } });
    return count > 0;
  }

  /**
   * Send an alert push to all of a user's devices. Badge defaults to the user's
   * undelivered notification count so the app icon mirrors the in-app bell.
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
    },
  ): Promise<void> {
    const cfg = this.appConfig.apns();
    if (!cfg) return;

    const tokens = await this.prisma.apnsDeviceToken.findMany({
      where: { userId: recipientUserId },
      select: { id: true, token: true, environment: true },
    });
    if (tokens.length === 0) return;

    const badge =
      params.badge ??
      (await this.prisma.notification
        .count({ where: { recipientUserId, deliveredAt: null } })
        .catch(() => 0));

    const collapseId = (params.collapseId ?? '').slice(0, 64) || undefined;
    const data: Record<string, unknown> = {};
    if (params.url) data.url = params.url;
    if (params.notificationId) data.notificationId = params.notificationId;
    if (params.kind) data.kind = params.kind;

    const deadTokenIds: string[] = [];
    for (const row of tokens) {
      const environment: ApnsEnvironment = row.environment === 'sandbox' ? 'sandbox' : 'production';
      const client = this.clientFor(environment, cfg);
      const notification = new ApnsNotification(row.token, {
        alert: { title: params.title, body: (params.body ?? '').trim() || ' ' },
        sound: this.soundForKind(params.kind),
        badge: Math.max(0, Math.floor(badge || 0)),
        ...(collapseId ? { collapseId } : {}),
        data,
      });
      try {
        await client.send(notification);
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
    }
  }

  private clientFor(
    environment: ApnsEnvironment,
    cfg: NonNullable<ReturnType<AppConfigService['apns']>>,
  ): ApnsClient {
    const existing = this.clients[environment];
    if (existing) return existing;
    const client = new ApnsClient({
      team: cfg.teamId,
      keyId: cfg.keyId,
      signingKey: cfg.privateKey,
      defaultTopic: cfg.bundleId,
      host: environment === 'sandbox' ? Host.development : Host.production,
      requestTimeout: 10_000,
    });
    this.clients[environment] = client;
    return client;
  }

  private soundForKind(kind?: string): string {
    return kind === 'message' ? MESSAGE_PUSH_SOUND : NOTIFICATION_PUSH_SOUND;
  }
}
