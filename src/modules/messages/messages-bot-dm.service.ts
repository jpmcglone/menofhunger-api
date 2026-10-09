import { Injectable, NotFoundException } from '@nestjs/common';
import { MessagesSupportService } from "./messages-support.service";
import { PrismaService } from "../prisma/prisma.service";
import { isUniqueViolation } from '../../common/prisma/errors';


@Injectable()
export class MessagesBotDmService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly support: MessagesSupportService,
  ) {}

  async ensureBotDirectConversation(params: {
      botUserId: string;
      recipientUserId: string;
    },
  ): Promise<string | null> {
    const { botUserId, recipientUserId } = params;
    if (botUserId === recipientUserId) return null;

    const blocked = await this.support.isBlockedBetween(
      botUserId,
      recipientUserId,
    );
    if (blocked) {
      this.support.logger.debug(
        `[messages] ensureBotDirectConversation: skipping (blocked) ${botUserId}->${recipientUserId}.`,
      );
      return null;
    }

    const directKey = this.support.directKeyFor(botUserId, recipientUserId);
    const existing = await this.prisma.messageConversation.findFirst({
      where: { type: "direct", directKey },
      select: { id: true },
    });
    if (existing) return existing.id;

    const recipient = await this.prisma.user.findUnique({
      where: { id: recipientUserId },
      select: { id: true, bannedAt: true },
    });
    if (!recipient) throw new NotFoundException("Recipient not found.");
    if (recipient.bannedAt) {
      this.support.logger.debug(
        `[messages] ensureBotDirectConversation: skipping (recipient banned) ${botUserId}->${recipientUserId}.`,
      );
      return null;
    }

    const now = new Date();
    try {
      const conversation = await this.prisma.$transaction(async (tx) => {
        const created = await tx.messageConversation.create({
          data: {
            type: "direct",
            createdByUserId: botUserId,
            directKey,
            lastMessageAt: now,
          },
        });

        // Bot conversations are auto-accepted on both sides — recipient should not see a
        // "request" tab, since Marv only DMs in response to the user's own actions.
        await tx.messageParticipant.createMany({
          data: [
            {
              conversationId: created.id,
              userId: botUserId,
              role: "owner" as const,
              status: "accepted" as const,
              acceptedAt: now,
              lastReadAt: now,
            },
            {
              conversationId: created.id,
              userId: recipientUserId,
              role: "member" as const,
              status: "accepted" as const,
              acceptedAt: now,
            },
          ],
        });

        return created;
      });
      return conversation.id;
    } catch (err) {
      // Concurrent create on the same directKey — re-read the winner.
      if (
        isUniqueViolation(err)
      ) {
        const raced = await this.prisma.messageConversation.findFirst({
          where: { type: "direct", directKey },
          select: { id: true },
        });
        return raced?.id ?? null;
      }
      throw err;
    }
  }
}

