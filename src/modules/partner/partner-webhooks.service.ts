import { PosthogService } from '../../common/posthog/posthog.service';
import { Injectable, Optional, Logger, type OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfigService } from '../app/app-config.service';
import { SideEffectsRegistry } from '../side-effects/side-effects.registry';
import { SideEffectsService } from '../side-effects/side-effects.service';
import { PartnerAccessService } from './partner-access.service';
import { PartnerReadService } from './partner-read.service';
import { openSecret } from '../../common/crypto/secret-box';
import { sendPartnerWebhook } from './partner-webhook.transport';

export function eventScope(type: string) {
  if (type === 'connection.revoked') return 'webhooks:read';
  if (type.startsWith('verification.')) return 'verification:read';
  if (type.startsWith('profile.')) return 'account:read';
  if (type.startsWith('follow.')) return 'social:read';
  return 'content:read';
}
@Injectable()
export class PartnerWebhooksService implements OnModuleInit {
  private readonly logger = new Logger(PartnerWebhooksService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly cfg: AppConfigService,
    private readonly registry: SideEffectsRegistry,
    private readonly effects: SideEffectsService,
    private readonly access: PartnerAccessService,
    private readonly reads: PartnerReadService,
    @Optional() private readonly analytics?: PosthogService,
  ) {}
  onModuleInit() {
    this.registry.register('partner.webhook.deliver', ({ deliveryId }) => this.deliver(deliveryId));
  }
  @Cron('*/30 * * * * *')
  async sweep() {
    if (!this.cfg.runSchedulers() || !this.cfg.partner().webhooks) return;
    const events = await this.prisma.partnerEvent.findMany({
      where: { dispatchedAt: null },
      orderBy: { createdAt: 'asc' },
      take: 100,
    });
    for (const event of events) {
      const grants = await this.prisma.partnerGrant.findMany({
        where: {
          userId: event.userId,
          ...(event.type === 'connection.revoked'
            ? { id: event.resourceId }
            : { revokedAt: null, expiresAt: { gt: new Date() }, createdAt: { lte: event.createdAt } }),
          scopes: { hasEvery: ['webhooks:read', eventScope(event.type)] },
        },
      });
      await this.prisma.$transaction([
        ...grants.map((grant) =>
          this.prisma.partnerWebhookDelivery.upsert({
            where: { eventId_grantId: { eventId: event.id, grantId: grant.id } },
            create: { eventId: event.id, grantId: grant.id, clientId: grant.clientId },
            update: {},
          }),
        ),
        this.prisma.partnerEvent.update({ where: { id: event.id }, data: { dispatchedAt: new Date() } }),
      ]);
    }
    await this.prisma.partnerWebhookDelivery.updateMany({
      where: { status: 'sending', leaseUntil: { lt: new Date() } },
      data: { status: 'pending' },
    });
    const due = await this.prisma.partnerWebhookDelivery.findMany({
      where: { status: 'pending', nextAttemptAt: { lte: new Date() } },
      select: { id: true, attempts: true },
      take: 100,
    });
    for (const row of due) this.effects.dispatch('partner.webhook.deliver', { deliveryId: row.id }, { jobId: `partner-webhook-${row.id}-${row.attempts}` });
    const cutoff = new Date(Date.now() - 30 * 86400_000);
    await this.prisma.partnerWebhookDelivery.deleteMany({
      where: { createdAt: { lt: cutoff }, status: { not: 'sending' } },
    });
    await this.prisma.partnerEvent.deleteMany({ where: { createdAt: { lt: cutoff }, dispatchedAt: { not: null } } });
    await this.prisma.partnerOidcRecord.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  }
  async deliver(id: string) {
    if (!this.cfg.partner().webhooks) return;
    const delivery = await this.prisma.partnerWebhookDelivery.findUnique({ where: { id } });
    if (!delivery || delivery.status !== 'pending') return;
    const claimed = await this.prisma.partnerWebhookDelivery.updateMany({
      where: { id, status: 'pending' },
      data: { status: 'sending', leaseUntil: new Date(Date.now() + 30_000), attempts: { increment: 1 } },
    });
    if (!claimed.count) return;
    let status: number | null = null;
    try {
      const event = await this.prisma.partnerEvent.findUnique({ where: { id: delivery.eventId } });
      if (!event) throw new Error('Event unavailable');
      const terminal = event.type === 'connection.revoked' && event.resourceId === delivery.grantId;
      const pair = terminal
        ? {
            grant: await this.prisma.partnerGrant.findUnique({ where: { id: delivery.grantId } }),
            client: await this.prisma.partnerClient.findUnique({ where: { id: delivery.clientId } }),
          }
        : await this.access.grant(delivery.grantId, delivery.clientId);
      const { grant, client } = pair;
      if (!grant || !client?.active || grant.clientId !== client.id || grant.userId !== event.userId) {
        await this.finish(id, 'cancelled', null);
        return;
      }
      if (
        !client.webhookUrl ||
        !client.webhookSecretEnc ||
        !client.webhookEvents.includes(event.type) ||
        !grant.scopes.includes('webhooks:read') ||
        !grant.scopes.includes(eventScope(event.type)) ||
        !client.scopes.includes('webhooks:read') ||
        !client.scopes.includes(eventScope(event.type))
      ) {
        await this.finish(id, 'cancelled', null);
        return;
      }
      // Every delivery re-reads current public data. Never queue stale content snapshots.
      let data: unknown;
      if (terminal) data = { id: grant.id, revoked: true };
      else if (event.type.endsWith('.removed')) data = { id: event.resourceId };
      else if (event.type === 'verification.updated') data = await this.reads.verification(grant.userId);
      else if (event.resourceKind === 'post') data = await this.reads.post(grant.userId, event.resourceId);
      else if (event.resourceKind === 'article_comment') data = await this.reads.articleComment(grant.userId, event.resourceId);
      else if (event.resourceKind === 'article') data = await this.reads.article(grant.userId, event.resourceId);
      else data = await this.reads.profile(grant.userId, event.resourceId, true);
      // Coalesce superseded events after rebuilding the payload, so an old version
      // cannot carry a newer snapshot and overwrite a later removal at the receiver.
      const superseded = await this.prisma.partnerEvent.findFirst({
        where: {
          userId: event.userId,
          resourceKind: event.resourceKind,
          resourceId: event.resourceId,
          version: { gt: event.version },
        },
        select: { id: true },
      });
      if (superseded && !terminal) {
        await this.finish(id, 'cancelled', null);
        return;
      }
      const body = JSON.stringify({
        id: event.id,
        type: event.type,
        origin: 'menofhunger',
        createdAt: event.createdAt.toISOString(),
        version: event.version.toString(),
        accountId: grant.userId,
        resource: { kind: event.resourceKind, id: event.resourceId },
        data,
      });
      const key = this.cfg.partner().encryptionKey;
      const secrets = [client.webhookSecretEnc, client.previousWebhookSecretEnc].filter((s): s is string => Boolean(s)).map((s) => openSecret(s, key));
      status = await sendPartnerWebhook(client.webhookUrl, body, secrets, event.id);
      if (status >= 200 && status < 300) {
        await this.finish(id, 'delivered', status);
        return;
      }
    } catch (e: any) {
      if (e?.getStatus?.() === 401 || e?.getStatus?.() === 403 || e?.getStatus?.() === 404) {
        await this.finish(id, 'cancelled', null);
        return;
      }
      this.analytics?.capture(delivery.clientId, 'partner_webhook_failed', {
        deliveryId: id,
        attempt: delivery.attempts + 1,
      });
      this.logger.warn(`Partner webhook ${id} failed`);
    }
    const expired = Date.now() - delivery.createdAt.getTime() >= 72 * 3600_000;
    await this.prisma.partnerWebhookDelivery.update({
      where: { id },
      data: {
        status: expired ? 'failed' : 'pending',
        leaseUntil: null,
        lastStatus: status,
        lastError: 'Webhook delivery was not acknowledged.',
        nextAttemptAt: new Date(Date.now() + Math.min(3600, 30 * 2 ** Math.min(delivery.attempts, 8)) * 1000),
      },
    });
  }
  private finish(id: string, status: string, lastStatus: number | null) {
    return this.prisma.partnerWebhookDelivery.update({
      where: { id },
      data: { status, lastStatus, leaseUntil: null, lastError: null },
    });
  }
}
