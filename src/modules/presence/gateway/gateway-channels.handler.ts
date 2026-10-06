import { Injectable } from '@nestjs/common';
import type { Socket } from 'socket.io';
import { WsEventNames, type GroupChannelTypingPayloadDto } from '../../../common/dto';
import { ChannelAccessService } from '../../group-channels/channel-access.service';
import { PrismaService } from '../../prisma/prisma.service';
import { PresenceRedisStateService } from '../presence-redis-state.service';
import { PresenceService } from '../presence.service';
import { GatewayThrottleService } from './gateway-throttle.service';
import { MAX_CHANNEL_SUBSCRIPTIONS_PER_SOCKET, channelRoom } from './gateway-rooms';

type ChannelSubs = Map<string, Map<string, string>>;

/**
 * Channel typing. A socket joins the room of every channel it may read in a group
 * (checked once, at subscribe), so each typing event is a room emit with no
 * database work. Clients re-subscribe when access changes.
 */
@Injectable()
export class ChannelsGatewayHandler {
  constructor(
    private readonly presence: PresenceService,
    private readonly presenceRedis: PresenceRedisStateService,
    private readonly access: ChannelAccessService,
    private readonly prisma: PrismaService,
    private readonly throttle: GatewayThrottleService,
  ) {}

  private subs(client: Socket): ChannelSubs {
    const data = client.data as { channelSubs?: ChannelSubs };
    return (data.channelSubs ??= new Map());
  }

  async handleSubscribe(client: Socket, payload: { groupId?: string }): Promise<void> {
    const userId = this.presence.getUserIdForSocket(client.id);
    const groupId = String(payload?.groupId ?? '').trim();
    if (!userId || !groupId) return;
    const subs = this.subs(client);
    try {
      await this.access.member(userId, groupId);
    } catch {
      this.handleUnsubscribe(client, { groupId });
      return;
    }
    const channels = await this.prisma.groupChannel.findMany({
      where: { ...this.access.readableWhere(userId, groupId), archivedAt: null },
      select: { id: true },
      take: MAX_CHANNEL_SUBSCRIPTIONS_PER_SOCKET,
    });
    const next = new Map(channels.map((channel) => [channel.id, groupId]));
    const previous = subs.get(groupId) ?? new Map<string, string>();
    for (const id of previous.keys()) if (!next.has(id)) client.leave(channelRoom(id));
    const others = [...subs.entries()].filter(([id]) => id !== groupId).reduce((sum, [, ids]) => sum + ids.size, 0);
    if (others + next.size > MAX_CHANNEL_SUBSCRIPTIONS_PER_SOCKET) return;
    for (const id of next.keys()) if (!previous.has(id)) client.join(channelRoom(id));
    subs.set(groupId, next);
  }

  handleUnsubscribe(client: Socket, payload: { groupId?: string }): void {
    const groupId = String(payload?.groupId ?? '').trim();
    const subs = this.subs(client);
    for (const id of subs.get(groupId)?.keys() ?? []) client.leave(channelRoom(id));
    subs.delete(groupId);
  }

  handleTyping(client: Socket, payload: { channelId?: string; threadRootId?: string | null; typing?: boolean }): void {
    const userId = this.presence.getUserIdForSocket(client.id);
    const channelId = String(payload?.channelId ?? '').trim();
    if (!userId || !channelId) return;
    let groupId: string | null = null;
    for (const [id, channels] of this.subs(client)) if (channels.has(channelId)) groupId = id;
    if (!groupId) return;
    const typing = payload?.typing !== false;
    const rawThread = typeof payload?.threadRootId === 'string' ? payload.threadRootId.trim() : '';
    const threadRootId = /^[A-Za-z0-9_-]{1,64}$/.test(rawThread) ? rawThread : null;
    if (!this.throttle.shouldEmitTyping(`channel:${userId}:${channelId}:${threadRootId ?? ''}:${typing ? '1' : '0'}`, 700)) return;
    const sender = ((client.data as any)?.spaceChatUser ?? null) as { id: string; username: string | null; verifiedStatus: string; premium: boolean; premiumPlus: boolean; isOrganization: boolean } | null;
    if (!sender?.id) return;
    const room = channelRoom(channelId);
    const out: GroupChannelTypingPayloadDto = {
      groupId, channelId, threadRootId, typing,
      user: { id: sender.id, username: sender.username, verifiedStatus: sender.verifiedStatus ?? null, premium: Boolean(sender.premium), premiumPlus: Boolean(sender.premiumPlus), isOrganization: Boolean(sender.isOrganization) },
    };
    client.to(room).emit(WsEventNames.groupChannelsTyping, out);
    void this.presenceRedis.publishEmitToRoom({ room, event: WsEventNames.groupChannelsTyping, payload: out }).catch(() => undefined);
  }
}
