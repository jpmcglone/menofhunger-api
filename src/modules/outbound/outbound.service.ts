import { PosthogService } from '../../common/posthog/posthog.service';
import { ConnectionIdempotencyService } from './connection-idempotency.service';
import { Global, Optional, Injectable, Logger, Module, type OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfigService } from '../app/app-config.service';
import { SideEffectsService } from '../side-effects/side-effects.service';
import { SideEffectsRegistry } from '../side-effects/side-effects.registry';
import type { OutboundDelivery } from '@prisma/client';

export class OutboundAttentionError extends Error {}

export function outboundIdentity(connection: { generation: string; xUserId?: string; pickaxUserId?: string | null; authKind?: string }): string | null {
  return connection.xUserId ?? connection.pickaxUserId
    ?? (connection.authKind === 'credentials' ? `pickax-credentials:${connection.generation}` : null);
}

type Adapter = { send: (row: OutboundDelivery) => Promise<void>; remove: (row: OutboundDelivery) => Promise<void> };
@Injectable()
export class OutboundService implements OnModuleInit {
  private readonly adapters = new Map<string, Adapter>();
  private readonly logger = new Logger(OutboundService.name);
  constructor(private readonly prisma: PrismaService, private readonly cfg: AppConfigService, private readonly effects: SideEffectsService, private readonly registry: SideEffectsRegistry, @Optional() private readonly analytics?: PosthogService) {}
  onModuleInit() { this.registry.register('outbound.deliver', ({ deliveryId }) => this.deliver(deliveryId)); }
  register(platform: string, adapter: Adapter) { this.adapters.set(platform, adapter); }
  async ensure(userId: string, platform: string, resourceKind: 'post' | 'article', resourceId: string, mode: string, update = false) {
    const connection = platform === 'x' ? await this.prisma.xConnection.findUnique({ where: { userId } }) : await this.prisma.pickaxConnection.findUnique({ where: { userId } });
    if (!connection) return;
    const externalAccountId = outboundIdentity(connection);
    if (!externalAccountId || connection.status !== 'active') return;
    const key = { platform, resourceKind, resourceId };
    const existing = await this.prisma.outboundDelivery.findUnique({ where: { platform_resourceKind_resourceId: key } });
    if (existing) {
      if (existing.connectionGeneration !== connection.generation || existing.action === 'remove' || existing.status === 'removed' || existing.status === 'needs_attention') return;
      if (update && existing.status === 'sent') await this.prisma.outboundDelivery.update({ where: { id: existing.id }, data: { action: 'update', status: 'pending', version: { increment: 1 }, nextAttemptAt: new Date() } });
      this.effects.dispatch('outbound.deliver', { deliveryId: existing.id }, { jobId: `outbound-${existing.id}-${existing.version + 1}` });
      return;
    }
    const row = await this.prisma.outboundDelivery.upsert({ where: { platform_resourceKind_resourceId: key }, create: { ...key, userId, mode, externalAccountId, connectionGeneration: connection.generation }, update: {} });
    this.effects.dispatch('outbound.deliver', { deliveryId: row.id }, { jobId: `outbound-${row.id}-${row.version}` });
  }
  @Cron('*/30 * * * * *')
  async recover() {
    if (!this.cfg.runSchedulers() || this.cfg.partner().outboundPaused) return;
    // A worker that died after sending may have created a copy. Never recreate blindly.
    await this.prisma.outboundDelivery.updateMany({ where: { status: 'sending', leaseUntil: { lt: new Date() } }, data: { status: 'needs_attention', lastError: 'Delivery interrupted. Check the destination before retrying.' } });
    const rows = await this.prisma.outboundDelivery.findMany({ where: { status: 'pending', nextAttemptAt: { lte: new Date() } }, select: { id: true, version: true }, take: 100 });
    for (const row of rows) this.effects.dispatch('outbound.deliver', { deliveryId: row.id }, { jobId: `outbound-${row.id}-${row.version}` });
  }
  async deliver(id: string) {
    if (this.cfg.partner().outboundPaused) return;
    const row = await this.prisma.outboundDelivery.findUnique({ where: { id } });
    if (!row || row.status !== 'pending' || row.nextAttemptAt > new Date()) return;
    // A removal may supersede a create, but must wait for its response.
    if (row.leaseUntil && row.leaseUntil > new Date()) return;
    if (row.leaseUntil && !row.remoteId && row.attempts > 0) {
      await this.prisma.outboundDelivery.updateMany({ where: { id, version: row.version, status: 'pending' }, data: { status: 'needs_attention', lastError: 'A previous send was interrupted. Check the destination before removing or retrying.' } });
      return;
    }
    if (row.action === 'remove' && !row.remoteId) {
      // No send was attempted, so there is no remote copy to remove. Once a send
      // was attempted, absence of a saved ID is not proof that creation failed.
      if (row.attempts === 0) {
        await this.prisma.outboundDelivery.updateMany({ where: { id, version: row.version, status: 'pending' }, data: { status: 'cancelled', lastError: null } });
        return;
      }
      const mapping = row.platform === 'x'
        ? await this.prisma.xCrosspost.findUnique({ where: { kind_localId: { kind: row.resourceKind as 'post' | 'article', localId: row.resourceId } } })
        : await this.prisma.pickaxCrosspost.findUnique({ where: { kind_localId: { kind: row.resourceKind as 'post' | 'article', localId: row.resourceId } } });
      if (!mapping?.remoteId) {
        await this.prisma.outboundDelivery.updateMany({ where: { id, version: row.version, status: 'pending' }, data: { status: 'needs_attention', lastError: 'The earlier send was not confirmed. Check the destination and remove any copy manually.' } });
        return;
      }
      row.remoteId = mapping.remoteId;
      await this.prisma.outboundDelivery.updateMany({ where: { id, version: row.version }, data: { remoteId: row.remoteId } });
    }
    const connection = row.platform === 'x' ? await this.prisma.xConnection.findUnique({ where: { userId: row.userId } }) : await this.prisma.pickaxConnection.findUnique({ where: { userId: row.userId } });
    if (!connection || connection.generation !== row.connectionGeneration || outboundIdentity(connection) !== row.externalAccountId) {
      await this.prisma.outboundDelivery.updateMany({ where: { id, version: row.version }, data: { status: 'cancelled', lastError: 'The original connection was disconnected.' } });
      return;
    }
    const user = await this.prisma.user.findUnique({ where: { id: row.userId }, select: { verifiedStatus: true, bannedAt: true, accountKind: true } });
    if (row.action !== 'remove' && (!user || user.bannedAt || user.verifiedStatus === 'none')) {
      await this.prisma.outboundDelivery.updateMany({ where: { id, version: row.version }, data: { status: 'cancelled', lastError: 'Verification is required to share.' } });
      return;
    }
    if (user?.accountKind === 'page') {
      const operator = connection.authorizedByUserId;
      const authority = operator && await this.prisma.userPageOperator.findUnique({ where: { operatorUserId_pageUserId: { operatorUserId: operator, pageUserId: row.userId } } });
      const operatorAccount = operator && await this.prisma.user.findUnique({ where: { id: operator }, select: { bannedAt: true, accountKind: true } });
      if (!authority || !operatorAccount || operatorAccount.bannedAt || operatorAccount.accountKind !== 'person') {
        await this.prisma.outboundDelivery.updateMany({ where: { id, version: row.version }, data: { status: 'needs_attention', lastError: 'A current page operator must reauthorize this connection.' } });
        return;
      }
    }
    const adapter = this.adapters.get(row.platform);
    if (!adapter) throw new Error('Outbound adapter is not registered.');
    const leaseUntil = new Date(Date.now() + 120_000);
    const claimed = await this.prisma.outboundDelivery.updateMany({ where: { id, version: row.version, status: 'pending', OR: [{ leaseUntil: null }, { leaseUntil: { lte: new Date() } }] }, data: { status: 'sending', leaseUntil, attempts: { increment: 1 } } });
    if (!claimed.count) return;
    try {
      if (row.action === 'remove') await adapter.remove(row); else await adapter.send(row);
      const mapping = row.platform === 'x'
        ? await this.prisma.xCrosspost.findUnique({ where: { kind_localId: { kind: row.resourceKind as 'post' | 'article', localId: row.resourceId } } })
        : await this.prisma.pickaxCrosspost.findUnique({ where: { kind_localId: { kind: row.resourceKind as 'post' | 'article', localId: row.resourceId } } });
      const remoteId = mapping?.remoteId ?? row.remoteId;
      this.analytics?.capture(row.userId, 'outbound_delivery_result', { destination: row.platform, deliveryId: id, action: row.action, confirmed: row.action === 'remove' || Boolean(remoteId && !mapping?.lastError) });
      // Retain remote identity even if removal won a race while the network call was in flight.
      if (remoteId) await this.prisma.outboundDelivery.update({ where: { id }, data: { remoteId } });
      await this.prisma.outboundDelivery.updateMany({ where: { id, version: row.version, status: 'sending' }, data: {
        status: row.action === 'remove' ? 'removed' : mapping?.lastError || !remoteId ? 'needs_attention' : 'sent',
        leaseUntil: null, lastError: mapping?.lastError ?? (!remoteId && row.action !== 'remove' ? 'Destination did not confirm a remote ID.' : null),
      } });
    } catch (e: any) {
      const retry = e?.status === 429 || (row.action === 'remove' && e?.status >= 500);
      await this.prisma.outboundDelivery.updateMany({ where: { id, version: row.version }, data: { status: retry ? 'pending' : 'needs_attention', leaseUntil: null, nextAttemptAt: new Date(Date.now() + Math.max(30, e?.retryAfterSeconds ?? 0) * 1000), lastError: e instanceof OutboundAttentionError ? e.message : 'Destination delivery failed. Check the connection and remote copy.' } });
      this.analytics?.capture(row.userId, 'outbound_delivery_failed', { destination: row.platform, deliveryId: id, action: row.action, retry });
      this.logger.warn(`Outbound delivery ${id} ${retry ? 'deferred' : 'needs attention'}`);
    } finally {
      // A newer lifecycle event owns the next action; release only this worker's lease.
      const newer = await this.prisma.outboundDelivery.findUnique({ where: { id } });
      if (newer && newer.version !== row.version && newer.leaseUntil?.getTime() === leaseUntil.getTime()) {
        await this.prisma.outboundDelivery.updateMany({ where: { id, version: newer.version, leaseUntil }, data: {
          leaseUntil: null, status: newer.remoteId ? 'pending' : 'needs_attention',
          lastError: newer.remoteId ? null : 'The previous send did not confirm a remote copy. Check the destination.',
        } });
      }
    }
  }
}
@Global()
@Module({ providers: [OutboundService, ConnectionIdempotencyService], exports: [OutboundService, ConnectionIdempotencyService] })
export class OutboundModule {}
