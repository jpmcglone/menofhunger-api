import { Injectable, Logger } from '@nestjs/common';
import { Prisma, type MarvinCannedReplyReason } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Tracks one-shot canned thread replies Marv posts in lieu of an AI response —
 * the original "premium-only" message and (since the canned-reply-reason
 * migration) "AI not configured" too. The legacy class name is preserved for
 * backwards compatibility; per-reason scoping is handled by the new column on
 * `MarvinNonPremiumThreadReply` and a unique index on
 * `(userId, rootPostId, reason)`.
 */
@Injectable()
export class MarvinNonPremiumRepliesService {
  private readonly logger = new Logger(MarvinNonPremiumRepliesService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Returns true when this user has already received a canned thread reply for the
   * given reason in this thread (so we should NOT send another one).
   */
  async hasAlreadyReplied(args: {
    userId: string;
    rootPostId: string;
    reason: MarvinCannedReplyReason;
  }): Promise<boolean> {
    const existing = await this.prisma.marvinNonPremiumThreadReply.findUnique({
      where: {
        userId_rootPostId_reason: {
          userId: args.userId,
          rootPostId: args.rootPostId,
          reason: args.reason,
        },
      },
      select: { id: true },
    });
    return Boolean(existing);
  }

  /**
   * Atomically claim the (user, rootPostId, reason) slot — returns true on first claim,
   * false if another worker already claimed it (which lets the caller skip posting the
   * duplicate). The unique index on (userId, rootPostId, reason) is the source of truth.
   */
  async tryClaim(args: {
    userId: string;
    rootPostId: string;
    reason: MarvinCannedReplyReason;
  }): Promise<boolean> {
    try {
      await this.prisma.marvinNonPremiumThreadReply.create({
        data: {
          userId: args.userId,
          rootPostId: args.rootPostId,
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

  /**
   * After successfully posting the canned reply, record the marv post id so admin tooling
   * can correlate the rate-limit row to the post that was created.
   */
  async setMarvPostId(args: {
    userId: string;
    rootPostId: string;
    reason: MarvinCannedReplyReason;
    marvinPostId: string;
  }): Promise<void> {
    try {
      await this.prisma.marvinNonPremiumThreadReply.update({
        where: {
          userId_rootPostId_reason: {
            userId: args.userId,
            rootPostId: args.rootPostId,
            reason: args.reason,
          },
        },
        data: { marvinPostId: args.marvinPostId },
      });
    } catch (err) {
      this.logger.warn(
        `[marv] Could not set marvinPostId for canned thread reply: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
