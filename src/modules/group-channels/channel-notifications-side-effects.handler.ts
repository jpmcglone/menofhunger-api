import { Injectable, NotFoundException, type OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationPushService } from '../notifications/notification-push.service';
import { NotificationPreferencesService } from '../notifications/notification-preferences.service';
import { SideEffectsRegistry } from '../side-effects/side-effects.registry';
import { SideEffectsService } from '../side-effects/side-effects.service';
import type { SideEffectPayloads } from '../side-effects/side-effects.constants';
import { runInBatches, FANOUT_CONCURRENCY } from '../side-effects/batch';
import { CacheService } from '../redis/cache.service';
import { RedisKeys } from '../redis/redis-keys';
import { ChannelAccessService } from './channel-access.service';
import { ChannelViewingService } from './channel-viewing.service';

/** Post-commit channel push and badge fan-out. */
@Injectable()
export class ChannelNotificationsSideEffectsHandler implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ChannelAccessService,
    private readonly push: NotificationPushService,
    private readonly preferences: NotificationPreferencesService,
    private readonly registry: SideEffectsRegistry,
    private readonly effects: SideEffectsService,
    private readonly cache: CacheService,
    private readonly viewing: ChannelViewingService,
  ) {}

  onModuleInit() {
    this.registry.register('channel.message.changed', p => this.messageChanged(p));
    this.registry.register('channel.member.added', p => this.memberAdded(p));
  }

  private async eligible(userId: string, input: SideEffectPayloads['channel.message.changed']) {
    try {
      const { channel } = await this.access.channel(userId, input.groupId, input.channelId);
      const message = await this.prisma.message.findFirst({ where: { id: input.messageId, conversationId: channel.conversationId, deletedForAll: false } });
      if (!message || message.senderId === userId) return null;
      const [viewer, attention, blocked, muted, prefs, isViewing] = await Promise.all([
        this.prisma.groupChannelViewerState.findUnique({ where: { channelId_userId: { channelId: channel.id, userId } } }),
        this.prisma.groupChannelAttention.findUnique({ where: { messageId_userId: { messageId: message.id, userId } } }),
        this.prisma.userBlock.findFirst({ where: { OR: [{ blockerId: userId, blockedId: message.senderId }, { blockerId: message.senderId, blockedId: userId }] } }),
        this.prisma.userMute.findUnique({ where: { muterId_mutedId: { muterId: userId, mutedId: message.senderId } } }),
        this.preferences.getPreferencesInternal(userId),
        this.viewing.isViewing(userId, channel.id),
      ]);
      if (blocked || muted || isViewing || viewer?.preference === 'off') return null;
      const personal = attention && !attention.readAt && (attention.mentioned || attention.followedReply);
      if (personal ? !(attention.mentioned ? prefs.pushMention : prefs.pushMessage) : !prefs.pushMessage) return null;
      if (!personal && (input.edited || viewer?.preference !== 'all' || (viewer.mutedUntil != null && viewer.mutedUntil > new Date()) || (viewer.readThrough >= (message.channelSequence ?? 0)))) return null;
      return { channel, message, reason: personal ? 'personal' : 'message' };
    } catch (error) {
      if (error instanceof NotFoundException) return null;
      throw error;
    }
  }

  async messageChanged(input: SideEffectPayloads['channel.message.changed']) {
    const recipients = await this.access.recipients(input.groupId, input.channelId);
    await runInBatches(recipients, FANOUT_CONCURRENCY, async ({ userId }) => {
      this.effects.dispatch('notification.badge.sync', { recipientUserId: userId });
      this.effects.dispatch('account.cluster.badge', { userId });
      // Queue retries and simultaneous edit/send fan-outs share a per-recipient lease.
      const delivered = await this.cache.withLock(RedisKeys.channelDelivery(userId, input.messageId), { ttlMs: 120_000, waitMs: 1000 }, async () => {
        const eligible = await this.eligible(userId, input);
        if (!eligible) return;
        const { channel, message, reason } = eligible;
        const key = { messageId: message.id, userId, reason };
        if (await this.prisma.groupChannelDelivery.findUnique({ where: { messageId_userId_reason: key } })) return;
        const group = await this.prisma.communityGroup.findUnique({ where: { id: input.groupId }, select: { slug: true, name: true } });
        if (!group) return;
        // Never put private names, text, actor details or attachments on a lock screen.
        const privateChannel = channel.privacy === 'private';
        await this.push.sendWebPushToRecipient(userId, {
          title: privateChannel ? 'Men of Hunger' : `${group.name} · #${channel.displayName ?? channel.name}`,
          body: privateChannel ? 'New activity in a private channel.' : this.push.trimPushBody(message.body) ?? 'Shared an attachment.',
          url: `/groups/${encodeURIComponent(group.slug)}/channels/${channel.id}?message=${message.id}${message.threadRootId ? `&thread=${message.threadRootId}` : ''}`,
          tag: `channel-${message.id}-${reason}`, kind: reason === 'personal' ? 'channel_mention' : 'channel_message', threadId: `channel-${channel.id}`,
          actorUserId: message.senderId,
          canDeliver: async () => Boolean(await this.eligible(userId, input)),
        });
        await this.prisma.groupChannelDelivery.upsert({ where: { messageId_userId_reason: key }, create: key, update: {} });
      });
      if (delivered === null) throw new Error('Channel delivery is already in progress; retry this recipient.');
    });
  }

  async memberAdded(input: SideEffectPayloads['channel.member.added']) {
    if (input.userId === input.actorUserId) return;
    const canDeliver = async () => {
      try {
        await this.access.channel(input.userId, input.groupId, input.channelId);
        return (await this.preferences.getPreferencesInternal(input.userId)).pushGroupActivity;
      } catch (error) {
        if (error instanceof NotFoundException) return false;
        throw error;
      }
    };
    if (!await canDeliver()) return;
    const group = await this.prisma.communityGroup.findUnique({ where: { id: input.groupId }, select: { slug: true } });
    if (!group) return;
    await this.push.sendWebPushToRecipient(input.userId, {
      title: 'Men of Hunger', body: 'You were added to a private channel.',
      url: `/groups/${encodeURIComponent(group.slug)}/channels/${input.channelId}`,
      kind: 'channel_invite', tag: `channel-invite-${input.channelId}`, canDeliver,
    });
  }
}
