import { ViewerBlockSetsService } from "../viewer/viewer-block-sets.service";
import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { AppConfigService } from "../app/app-config.service";
import { PresenceRealtimeService } from "../presence/presence-realtime.service";
import { DomainEventsService } from "../events/domain-events.service";
import { RedisService } from "../redis/redis.service";
import { MessagesSupportService } from "./messages-support.service";
import { USER_BRIEF_SELECT } from "../../common/prisma-selects/user.select";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { RedisKeys } from "../redis/redis-keys";
import { toUserListDto } from "../../common/dto";
import { MESSAGE_UNREAD_CACHE_TTL_MS } from "./messages-support.service";

@Injectable()
export class MessagesConversationStateService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly appConfig: AppConfigService,
    private readonly presenceRealtime: PresenceRealtimeService,
    private readonly events: DomainEventsService,
    private readonly redis: RedisService,
    private readonly support: MessagesSupportService,
    private readonly blockSets: ViewerBlockSetsService,
  ) {}

  async markRead(params: { userId: string; conversationId: string }) {
    const { userId, conversationId } = params;
    await this.support.getConversationOrThrow({ userId, conversationId });
    const now = new Date();
    const [, allParticipants] = await Promise.all([
      this.prisma.messageParticipant.update({
        where: { conversationId_userId: { conversationId, userId } },
        data: { lastReadAt: now },
      }),
      this.prisma.messageParticipant.findMany({
        where: { conversationId },
        select: { userId: true },
      }),
    ]);

    const payload = { conversationId, userId, lastReadAt: now.toISOString() };
    for (const p of allParticipants) {
      // Emit to self for cross-tab/device sync, and to others so they can update read indicators.
      this.presenceRealtime.emitMessagesRead(p.userId, payload);
    }
    this.support.emitUnreadCounts(userId);

    // Signal to the notifications module that this user has opened the conversation
    // so the in-app message notification can be cleared.
    this.events.emitConversationRead({ userId, conversationId });
  }

  async deleteConversation(params: { userId: string; conversationId: string }) {
    const { userId, conversationId } = params;
    // Hide for this viewer only. The conversation row (and unique directKey) stay so
    // either person can talk again — getConversationOrThrow / sendMessage re-add them.
    const participant = await this.prisma.messageParticipant.findUnique({
      where: {
        conversationId_userId: { conversationId, userId },
        conversation: { type: { not: "channel" } },
      },
      select: { conversationId: true },
    });
    if (!participant) return;
    await this.prisma.messageParticipant.delete({
      where: { conversationId_userId: { conversationId, userId } },
    });
    this.support.emitUnreadCounts(userId);
  }

  async acceptConversation(params: { userId: string; conversationId: string }) {
    const { userId, conversationId } = params;
    const conversation = await this.support.getConversationOrThrow({
      userId,
      conversationId,
    });
    const now = new Date();
    if (conversation.type === "direct") {
      await this.prisma.messageParticipant.updateMany({
        where: { conversationId, status: "pending" },
        data: { status: "accepted", acceptedAt: now },
      });
    } else {
      await this.prisma.messageParticipant.update({
        where: { conversationId_userId: { conversationId, userId } },
        data: { status: "accepted", acceptedAt: now },
      });
    }
    this.support.emitUnreadCounts(userId);
  }

  async blockUser(params: { userId: string; targetUserId: string }) {
    const { userId, targetUserId } = params;
    if (userId === targetUserId)
      throw new BadRequestException("You cannot block yourself.");
    // A block and its automatic unfollow are one policy change.
    await this.prisma.$transaction(async (tx) => {
      await tx.userBlock.upsert({
        where: {
          blockerId_blockedId: { blockerId: userId, blockedId: targetUserId },
        },
        create: { blockerId: userId, blockedId: targetUserId },
        update: {},
      });
      await tx.follow.deleteMany({
        where: { followerId: userId, followingId: targetUserId },
      });
    });
    this.support.emitUnreadCounts(userId);
    await this.blockSets.invalidate(userId, targetUserId);
    // Notify other tabs/devices of the blocker that their block/follow/filter state changed.
    this.presenceRealtime.emitUsersMeRefresh(userId, "block_changed");
  }

  async unblockUser(params: { userId: string; targetUserId: string }) {
    const { userId, targetUserId } = params;
    await this.prisma.userBlock.deleteMany({
      where: { blockerId: userId, blockedId: targetUserId },
    });
    this.support.emitUnreadCounts(userId);
    await this.blockSets.invalidate(userId, targetUserId);
    // Notify other tabs/devices of the unblocker that their block/follow/filter state changed.
    this.presenceRealtime.emitUsersMeRefresh(userId, "block_changed");
  }

  async listBlocks(params: { userId: string }) {
    const rows = await this.prisma.userBlock.findMany({
      where: { blockerId: params.userId },
      include: {
        blocked: {
          select: {
            ...USER_BRIEF_SELECT,
            premium: true,
            premiumPlus: true,
            isOrganization: true,
            verifiedStatus: true,
            avatarKey: true,
            avatarVideoKey: true,
            avatarVideoDurationMs: true,
            avatarUpdatedAt: true,
          },
        },
      },
      orderBy: [{ createdAt: "desc" }, { blockedId: "desc" }],
    });
    const publicBaseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;
    return rows.map((row) => ({
      blocked: toUserListDto(row.blocked, publicBaseUrl),
      createdAt: row.createdAt.toISOString(),
    }));
  }

  async getUnreadSummary(
    userId: string,
  ): Promise<{ primary: number; requests: number }> {
    const cacheKey = RedisKeys.messageUnreadSummary(userId);
    try {
      const cached = await this.redis.getJson<{
        primary: number;
        requests: number;
      }>(cacheKey);
      if (cached) return cached;
    } catch {
      // Redis unavailable — fall through to DB.
    }

    const counts = await this.support.getUnreadCounts(userId);

    void this.redis
      .setJson(cacheKey, counts, { ttlMs: MESSAGE_UNREAD_CACHE_TTL_MS })
      .catch(() => undefined);

    return counts;
  }

  async deleteMessageForMe(params: {
    userId: string;
    conversationId: string;
    messageId: string;
  }): Promise<void> {
    const { userId, conversationId, messageId } = params;

    await this.support.getConversationOrThrow({ userId, conversationId });

    const message = await this.prisma.message.findFirst({
      where: { id: messageId, conversationId },
      select: { id: true },
    });
    if (!message) throw new NotFoundException("Message not found.");

    await this.prisma.messageDeletion.upsert({
      where: { messageId_userId: { messageId, userId } },
      create: { messageId, userId },
      update: {},
    });
  }

  async restoreMessageForMe(params: {
    userId: string;
    conversationId: string;
    messageId: string;
  }): Promise<void> {
    const { userId, conversationId, messageId } = params;

    await this.support.getConversationOrThrow({ userId, conversationId });

    await this.prisma.messageDeletion.deleteMany({
      where: { messageId, userId },
    });
  }

  async muteConversation(params: {
    userId: string;
    conversationId: string;
  }): Promise<void> {
    const { userId, conversationId } = params;
    await this.support.getConversationOrThrow({ userId, conversationId });
    await this.prisma.messageParticipant.update({
      where: { conversationId_userId: { conversationId, userId } },
      data: { mutedAt: new Date() },
    });
  }

  async unmuteConversation(params: {
    userId: string;
    conversationId: string;
  }): Promise<void> {
    const { userId, conversationId } = params;
    await this.support.getConversationOrThrow({ userId, conversationId });
    await this.prisma.messageParticipant.update({
      where: { conversationId_userId: { conversationId, userId } },
      data: { mutedAt: null },
    });
  }
}
