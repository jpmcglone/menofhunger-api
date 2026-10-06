import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { PosthogService } from '../../common/posthog/posthog.service';
import { PrismaService } from '../prisma/prisma.service';

/** Only coarse measures leave the channel domain: no group/channel/message IDs or content. */
@Injectable()
export class ChannelAnalyticsService {
  constructor(private readonly prisma: PrismaService, private readonly analytics: PosthogService) {}
  capture(userId: string, event: 'channel_preference_changed' | 'channel_left', preference?: string) {
    this.analytics.capture(userId, event, preference ? { preference } : {});
  }
  async sent(userId: string, messageId: string) {
    try {
      const message = await this.prisma.message.findUnique({ where: { id: messageId }, select: {
        createdAt: true, threadRootId: true, conversationId: true,
        threadRoot: { select: { createdAt: true } },
      } });
      if (!message) return;
      const previous = await this.prisma.message.findFirst({ where: {
        senderId: userId, conversation: { type: 'channel' }, id: { not: messageId },
        createdAt: { lt: message.createdAt },
      }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } });
      this.analytics.capture(userId, 'channel_message_sent', {
        $insert_id: createHash('sha256').update(`channel-send-${messageId}`).digest('hex'), // Deduplication only; never a navigable audience identifier.
        is_reply: !!message.threadRootId,
        first_contribution: !previous,
        returning_contributor: !!previous && previous.createdAt.toISOString().slice(0, 10) !== message.createdAt.toISOString().slice(0, 10),
        ...(message.threadRoot ? { response_seconds: Math.max(0, Math.round((message.createdAt.getTime() - message.threadRoot.createdAt.getTime()) / 1000)) } : {}),
      });
    } catch { /* Analytics cannot change delivery or expose request errors/content. */ }
  }
}
