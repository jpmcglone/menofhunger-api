import { Injectable, Logger } from '@nestjs/common';
import { Prisma, type MarvinCannedReplyReason } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * DM sibling of `MarvinNonPremiumRepliesService` — owns the
 * `MarvinPrivateCannedReply` table that gates one-shot Marv DMs (e.g. the
 * "I'm not configured yet, ask an admin" message). Keyed on
 * (userId, conversationId, reason); first writer wins via the unique index.
 *
 * DMs aren't threaded, so we de-dupe by conversation. In practice the user
 * has exactly one Marv DM thread, but using `conversationId` here keeps the
 * service generic and survives future per-feature DM rooms if we add them.
 */
@Injectable()
export class MarvinPrivateCannedRepliesService {
  private readonly logger = new Logger(MarvinPrivateCannedRepliesService.name);

  constructor(private readonly prisma: PrismaService) {}

  async hasAlreadyReplied(args: {
    userId: string;
    conversationId: string;
    reason: MarvinCannedReplyReason;
  }): Promise<boolean> {
    const existing = await this.prisma.marvinPrivateCannedReply.findUnique({
      where: {
        userId_conversationId_reason: {
          userId: args.userId,
          conversationId: args.conversationId,
          reason: args.reason,
        },
      },
      select: { id: true },
    });
    return Boolean(existing);
  }

  /**
   * Atomically claim the (userId, conversationId, reason) slot. Returns true
   * on first claim, false if another worker already claimed it.
   */
  async tryClaim(args: {
    userId: string;
    conversationId: string;
    reason: MarvinCannedReplyReason;
  }): Promise<boolean> {
    try {
      await this.prisma.marvinPrivateCannedReply.create({
        data: {
          userId: args.userId,
          conversationId: args.conversationId,
          reason: args.reason,
        },
        select: { id: true },
      });
      return true;
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        return false;
      }
      throw err;
    }
  }

  async setMarvinMessageId(args: {
    userId: string;
    conversationId: string;
    reason: MarvinCannedReplyReason;
    marvinMessageId: string;
  }): Promise<void> {
    try {
      await this.prisma.marvinPrivateCannedReply.update({
        where: {
          userId_conversationId_reason: {
            userId: args.userId,
            conversationId: args.conversationId,
            reason: args.reason,
          },
        },
        data: { marvinMessageId: args.marvinMessageId },
      });
    } catch (err) {
      this.logger.warn(
        `[marv] Could not set marvinMessageId for canned DM: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
