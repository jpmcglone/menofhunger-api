import { assertMessageMediaPermissions } from "./message-media-permissions";
import { enqueueMessageMarvReply } from "./message-marv-reply";
import { UploadGrantsService } from "../uploads/upload-grants.service";
import { messageMediaDeletedAt } from "./message-media-state";
import {
  messageRequestHash,
  assertMessageRequestHash,
  isUniqueConflict,
} from "./message-request";
import { assertPublishableText } from "../../common/moderation/content-filter";
import { requireAiConsent } from "../marvin/services/ai-consent";
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type { MessageConversation } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { AppConfigService } from "../app/app-config.service";
import { PresenceRealtimeService } from "../presence/presence-realtime.service";
import { DomainEventsService } from "../events/domain-events.service";

import { toMessageDto, messagePushPreview } from "./message.dto";
import { PosthogService } from "../../common/posthog/posthog.service";
import { MarvinBotIdentityService } from "../marvin/services/marvin-bot-identity.service";
import { JobsService } from "../jobs/jobs.service";
import { JOBS } from "../jobs/jobs.constants";

import { SideEffectsService } from "../side-effects/side-effects.service";

import {
  MessagesSupportService,
  MESSAGE_BODY_MAX,
  MESSAGE_INCLUDE,
} from "./messages-support.service";
import {
  messageMediaCreateData,
  type MessageMediaInput,
} from "./messages.models";

@Injectable()
export class MessagesWriteService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly appConfig: AppConfigService,
    private readonly presenceRealtime: PresenceRealtimeService,
    private readonly events: DomainEventsService,
    private readonly posthog: PosthogService,
    private readonly jobs: JobsService,
    private readonly marvIdentity: MarvinBotIdentityService,
    private readonly sideEffects: SideEffectsService,
    private readonly support: MessagesSupportService,
    private readonly grants: UploadGrantsService,
  ) {}

  private async validatePhotos(
    userId: string,
    media: MessageMediaInput[],
    tx: import("@prisma/client").Prisma.TransactionClient,
  ) {
    return Promise.all(
      media.map((item) =>
        item.source === "upload" &&
        (item.kind === "image" || item.kind === "gif")
          ? this.grants.photo(userId, item, tx)
          : item,
      ),
    );
  }

  async createConversation(params: {
    userId: string;
    recipientUserIds: string[];
    title?: string | null;
    body: string;
    media?: MessageMediaInput[];
    clientRequestId?: string;
  }) {
    assertPublishableText(params.body, params.title);
    const { userId, recipientUserIds, title, body } = params;
    const trimmed = (body ?? "").trim();
    const media = params.media ?? [];
    if (!trimmed && media.length === 0)
      throw new BadRequestException("Message must have a body or media.");
    if (trimmed.length > MESSAGE_BODY_MAX)
      throw new BadRequestException("Message body is too long.");

    const uniqueRecipients = [
      ...new Set(recipientUserIds.filter(Boolean)),
    ].filter((id) => id !== userId);
    if (uniqueRecipients.length === 0)
      throw new BadRequestException("At least one recipient is required.");

    const marvRecipient = await this.marvIdentity.getMarvUserId();
    if (
      marvRecipient &&
      uniqueRecipients.length === 1 &&
      uniqueRecipients.includes(marvRecipient)
    )
      await requireAiConsent(this.prisma, userId);

    // Tier rule:
    // - Site admins can start new chats with any user (verified or not) and bypass the mutual-follow gate.
    // - Verified members can start new chats only with mutuals (both follow each other).
    // - Premium members can start new chats with any verified member.
    // If a direct thread already exists (any tier), the message is routed to sendMessage directly.
    const sender = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        premium: true,
        premiumPlus: true,
        verifiedStatus: true,
        bannedAt: true,
        siteAdmin: true,
      },
    });
    if (!sender) throw new NotFoundException("User not found.");
    if (sender.bannedAt) {
      // Defense-in-depth: AuthGuard already revokes the session and throws on banned users.
      // This guards the ~30s session-cache window and any internal/job callers.
      throw new ForbiddenException({
        message:
          "This account was banned. Contact an admin if you think it’s a mistake.",
        error: "account_banned",
      });
    }
    const senderIsAdmin = Boolean(sender.siteAdmin);
    const senderIsVerified = Boolean(
      sender.verifiedStatus && sender.verifiedStatus !== "none",
    );
    const senderIsPremium = Boolean(sender.premium || sender.premiumPlus);
    if (!senderIsAdmin && !senderIsVerified && !senderIsPremium) {
      // Load-bearing gate: MessagesController no longer uses VerifiedGuard (unverified users
      // must be able to reply in admin-initiated threads). This is the primary sender check.
      throw new ForbiddenException("Verify to use chat.");
    }
    if (
      media.some(
        (m) => m.kind === "image" || m.kind === "gif" || m.kind === "audio",
      ) &&
      !senderIsVerified
    )
      throw new ForbiddenException(
        "Verify your account to send photos and voice notes in chat.",
      );
    if (media.some((m) => m.kind === "video") && !senderIsPremium)
      throw new ForbiddenException(
        "Video messages are for premium members only.",
      );
    await this.support.assertNotBlocked(userId, uniqueRecipients);

    const isDirect = uniqueRecipients.length === 1;
    const type: MessageConversation["type"] = isDirect ? "direct" : "group";
    const directKey = isDirect
      ? this.support.directKeyFor(userId, uniqueRecipients[0])
      : null;

    // Marv cannot be in a group conversation — only 1:1 DMs are allowed.
    if (!isDirect) {
      const marvUserId = await this.support.resolveMarvUserId();
      if (marvUserId && uniqueRecipients.includes(marvUserId)) {
        throw new BadRequestException("Marv cannot be added to a group chat.");
      }
    }

    if (directKey) {
      const existing = await this.prisma.messageConversation.findFirst({
        where: { type: "direct", directKey },
        select: { id: true },
      });
      if (existing) {
        const sent = await this.sendMessage({
          userId,
          conversationId: existing.id,
          body: trimmed,
          media,
          clientRequestId: params.clientRequestId,
        });
        return { conversationId: existing.id, message: sent.message };
      }
    }

    // From this point on, we are creating a new conversation (no existing direct thread matched).
    // Rules:
    //   - Site admins can message any non-banned user regardless of verification status.
    //   - Verified senders can start a new chat only with mutuals (both follow each other).
    //   - Premium senders can start a new chat with any verified member.
    //   - Non-admin senders cannot message unverified users.

    const users = await this.prisma.user.findMany({
      where: { id: { in: uniqueRecipients } },
      select: { id: true, verifiedStatus: true, bannedAt: true },
    });
    if (users.length !== uniqueRecipients.length)
      throw new NotFoundException("User not found.");
    for (const u of users) {
      if (u.bannedAt) {
        throw new BadRequestException("Cannot message a banned user.");
      }
      if (
        !senderIsAdmin &&
        (!u.verifiedStatus || u.verifiedStatus === "none")
      ) {
        throw new ForbiddenException(
          "You can only start chats with verified members.",
        );
      }
    }

    // For verified-only (non-premium, non-admin) senders, all recipients must be mutuals.
    if (!senderIsPremium && !senderIsAdmin) {
      const [senderFollowing, senderFollowers] = await Promise.all([
        this.prisma.follow.findMany({
          where: { followerId: userId, followingId: { in: uniqueRecipients } },
          select: { followingId: true },
        }),
        this.prisma.follow.findMany({
          where: { followingId: userId, followerId: { in: uniqueRecipients } },
          select: { followerId: true },
        }),
      ]);
      const senderFollowingSet = new Set(
        senderFollowing.map((f) => f.followingId),
      );
      const senderFollowerSet = new Set(
        senderFollowers.map((f) => f.followerId),
      );
      const nonMutualRecipients = uniqueRecipients.filter(
        (id) => !senderFollowingSet.has(id) || !senderFollowerSet.has(id),
      );
      if (nonMutualRecipients.length > 0) {
        throw new ForbiddenException(
          "You can only message people who follow you back. Upgrade to Premium to message any member.",
        );
      }
    }

    // followerSet is used to determine conversation status (accepted vs pending) for premium senders.
    const followers = await this.prisma.follow.findMany({
      where: {
        followingId: userId,
        followerId: { in: uniqueRecipients },
      },
      select: { followerId: true },
    });
    const followerSet = new Set(followers.map((f) => f.followerId));
    const now = new Date();

    const result = await this.prisma
      .$transaction(
        async (tx) => {
          const conversation = await tx.messageConversation.create({
            data: {
              type,
              title: title?.trim() || null,
              createdByUserId: userId,
              directKey: directKey ?? undefined,
              lastMessageAt: now,
            },
          });

          const participantRows = [
            {
              conversationId: conversation.id,
              userId,
              role: "owner" as const,
              status: "accepted" as const,
              acceptedAt: now,
              lastReadAt: now,
            },
            ...uniqueRecipients.map((recipientId) => ({
              conversationId: conversation.id,
              userId: recipientId,
              role: "member" as const,
              // Admin-initiated threads are always accepted so the message lands in the
              // primary inbox (not the Requests tab) and push shows the real body.
              status:
                senderIsAdmin || followerSet.has(recipientId)
                  ? ("accepted" as const)
                  : ("pending" as const),
              acceptedAt:
                senderIsAdmin || followerSet.has(recipientId) ? now : null,
            })),
          ];

          await tx.messageParticipant.createMany({ data: participantRows });

          const validatedMedia = await this.validatePhotos(userId, media, tx);
          const message = await tx.message.create({
            data: {
              conversationId: conversation.id,
              senderId: userId,
              body: trimmed,
              clientRequestId: params.clientRequestId,
              requestHash: params.clientRequestId
                ? messageRequestHash(trimmed, null, media)
                : null,
              ...(media.length > 0
                ? { media: { create: messageMediaCreateData(validatedMedia) } }
                : {}),
            },
            include: MESSAGE_INCLUDE,
          });

          await tx.messageConversation.update({
            where: { id: conversation.id },
            data: { lastMessageId: message.id, lastMessageAt: now },
          });

          return { conversationId: conversation.id, message };
        },
        { timeout: 30_000 },
      )
      .catch(async (error: unknown) => {
        if (!directKey || !isUniqueConflict(error)) throw error;
        const existing = await this.prisma.messageConversation.findFirst({
          where: { type: "direct", directKey },
          select: { id: true },
        });
        if (!existing) throw error;
        // The winner owns all first-message side effects. Route this caller through the
        // same request identity so a concurrent creation/retry cannot send it twice.
        const sent = await this.sendMessage({
          userId,
          conversationId: existing.id,
          body: trimmed,
          media,
          clientRequestId: params.clientRequestId,
        });
        return {
          conversationId: existing.id,
          message: null,
          replay: sent.message,
        };
      });
    if ("replay" in result)
      return { conversationId: result.conversationId, message: result.replay };

    const publicBaseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;
    const mediaDeletedAt = await messageMediaDeletedAt(this.prisma, [
      result.message,
    ]);
    const dto = toMessageDto({
      mediaDeletedAt,
      message: result.message,
      publicBaseUrl,
      viewerUserId: userId,
    });
    if (media.some((m) => m.kind === "audio")) {
      this.sideEffects.dispatch(
        "media.transcribe.request",
        { messageId: result.message.id },
        { jobId: `transcribe-${result.message.id}` },
      );
    }
    const senderName =
      result.message.sender?.name?.trim() ||
      result.message.sender?.username?.trim() ||
      "Someone";

    this.support.emitUnreadCounts(userId);
    this.presenceRealtime.emitMessageCreated(userId, {
      conversationId: result.conversationId,
      message: dto,
    });
    for (const recipientId of uniqueRecipients) {
      this.support.emitUnreadCounts(recipientId);
      this.presenceRealtime.emitMessageCreated(recipientId, {
        conversationId: result.conversationId,
        message: toMessageDto({
          message: result.message,
          publicBaseUrl,
          viewerUserId: recipientId,
          mediaDeletedAt,
        }),
      });
    }
    for (const recipientId of uniqueRecipients) {
      const isPending = !followerSet.has(recipientId);
      const pushBody = isPending
        ? "Sent you a message request"
        : messagePushPreview({ body: trimmed, media });
      this.events.emitMessagePushRequested({
        recipientUserId: recipientId,
        senderUserId: userId,
        senderName,
        body: pushBody,
        conversationId: result.conversationId,
      });
    }

    // ─── Marv: queue an AI reply for the first message, same as sendMessage() ──
    try {
      const marvCfg = this.appConfig.marvBot();
      const marvUserId = marvCfg.enabled
        ? await this.support.resolveMarvUserId()
        : null;
      const recipientIsMarv =
        !!marvUserId &&
        uniqueRecipients.length === 1 &&
        uniqueRecipients[0] === marvUserId;
      if (recipientIsMarv && trimmed.length > 0) {
        this.support.logger.log(
          `[marv] dm-enqueue HIT (new-conversation) msg=${result.message.id} convo=${result.conversationId} sender=${userId}`,
        );
        await this.jobs
          .enqueue(
            JOBS.marvinReplyPrivate,
            {
              conversationId: result.conversationId,
              messageId: result.message.id,
              requestingUserId: userId,
              requestedMode: null,
            },
            {
              jobId: `marv-private-${result.message.id}`,
              removeOnComplete: true,
              removeOnFail: false,
              attempts: 3,
              backoff: { type: "exponential" as const, delay: 5000 },
            },
          )
          .then(() => {
            this.support.logger.log(
              `[marv] dm-enqueue ok (new-conversation) msg=${result.message.id} job=marv-private-${result.message.id}`,
            );
          })
          .catch((err) => {
            this.support.logger.warn(
              `[marv] Failed to enqueue private reply for new conversation message=${result.message.id}: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          });
      }
    } catch (err) {
      this.support.logger.warn(
        `[marv] private-reply enqueue (new-conversation) failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    return {
      conversationId: result.conversationId,
      message: dto,
    };
  }

  async sendMessage(params: {
    userId: string;
    conversationId: string;
    body: string;
    replyToId?: string | null;
    media?: MessageMediaInput[];
    clientRequestId?: string;
  }) {
    assertPublishableText(params.body);
    const { userId, conversationId } = params;
    const trimmed = (params.body ?? "").trim();
    const media = params.media ?? [];
    if (!trimmed && media.length === 0)
      throw new BadRequestException("Message must have a body or media.");
    if (trimmed.length > MESSAGE_BODY_MAX)
      throw new BadRequestException("Message body is too long.");

    let conversation = await this.support.getConversationOrThrow({
      userId,
      conversationId,
    });
    const directPair =
      conversation.type === "direct"
        ? this.support.parseDirectPair(conversation.directKey)
        : null;
    if (directPair) {
      const present = new Set(conversation.participants.map((p) => p.userId));
      const missingPeer = directPair.filter((id) => !present.has(id));
      if (missingPeer.length > 0) {
        await this.support.restoreMissingDirectParticipants({
          conversationId,
          createdByUserId: conversation.createdByUserId,
          userIds: missingPeer,
        });
        conversation = await this.support.getConversationOrThrow({
          userId,
          conversationId,
        });
      }
    }
    const participant = conversation.participants.find(
      (p) => p.userId === userId,
    );
    if (!participant) throw new NotFoundException("Conversation not found.");

    // Defense-in-depth ban check: AuthGuard normally rejects banned users at the session
    // boundary, but this protects against stale session caches and any internal callers.
    const sender = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        bannedAt: true,
        verifiedStatus: true,
        premium: true,
        premiumPlus: true,
      },
    });
    if (sender?.bannedAt) {
      throw new ForbiddenException({
        message:
          "This account was banned. Contact an admin if you think it’s a mistake.",
        error: "account_banned",
      });
    }

    assertMessageMediaPermissions(sender, media);

    const blockedIds = await this.support._getBlockedUserIds(userId);
    const otherIds = conversation.participants
      .filter((p) => p.userId !== userId)
      .map((p) => p.userId);
    for (const otherId of otherIds) {
      if (blockedIds.has(otherId))
        throw new ForbiddenException("You cannot message this user.");
    }

    // Validate replyToId belongs to the same conversation.
    const replyToId = params.replyToId ?? null;
    if (replyToId) {
      const replyTarget = await this.prisma.message.findFirst({
        where: { id: replyToId, conversationId },
        select: { id: true },
      });
      if (!replyTarget)
        throw new BadRequestException(
          "Reply target not found in this conversation.",
        );
    }

    const marvId = await this.marvIdentity.getMarvUserId();
    // Consent belongs to the human requesting AI, never to the bot delivering its answer.
    if (
      userId !== marvId &&
      conversation.participants.some((p) => p.userId === marvId)
    )
      await requireAiConsent(this.prisma, userId);

    const requestHash = params.clientRequestId
      ? messageRequestHash(trimmed, replyToId, media)
      : null;
    let createdNow = false;
    const now = new Date();
    const result = await this.prisma
      .$transaction(
        async (tx) => {
          if (params.clientRequestId) {
            const existing = await tx.message.findUnique({
              where: {
                conversationId_senderId_clientRequestId: {
                  conversationId,
                  senderId: userId,
                  clientRequestId: params.clientRequestId,
                },
              },
              include: MESSAGE_INCLUDE,
            });
            if (existing) {
              assertMessageRequestHash(existing, requestHash!);
              return existing;
            }
          }
          const validatedMedia = await this.validatePhotos(userId, media, tx);
          const message = await tx.message.create({
            data: {
              conversationId,
              senderId: userId,
              body: trimmed,
              clientRequestId: params.clientRequestId,
              requestHash,
              ...(replyToId ? { replyToId } : {}),
              ...(media.length > 0
                ? { media: { create: messageMediaCreateData(validatedMedia) } }
                : {}),
            },
            include: MESSAGE_INCLUDE,
          });

          await tx.messageConversation.update({
            where: { id: conversationId },
            data: { lastMessageId: message.id, lastMessageAt: now },
          });

          await tx.messageParticipant.update({
            where: { conversationId_userId: { conversationId, userId } },
            data: {
              lastReadAt: now,
              status: "accepted",
              acceptedAt: participant.acceptedAt ?? now,
            },
          });

          if (
            conversation.type === "direct" &&
            participant.status === "pending"
          ) {
            await tx.messageParticipant.updateMany({
              where: { conversationId, status: "pending" },
              data: { status: "accepted", acceptedAt: now },
            });
          }

          createdNow = true;
          return message;
        },
        { timeout: 30_000 },
      )
      .catch(async (error: unknown) => {
        if (!params.clientRequestId || !isUniqueConflict(error)) throw error;
        const existing = await this.prisma.message.findUnique({
          where: {
            conversationId_senderId_clientRequestId: {
              conversationId,
              senderId: userId,
              clientRequestId: params.clientRequestId,
            },
          },
          include: MESSAGE_INCLUDE,
        });
        if (!existing) throw error;
        assertMessageRequestHash(existing, requestHash!);
        return existing;
      });
    if (!createdNow)
      await this.support.getConversationOrThrow({ userId, conversationId });

    const publicBaseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;
    const mediaDeletedAt = await messageMediaDeletedAt(this.prisma, [result]);
    const dto = toMessageDto({
      mediaDeletedAt,
      message: result,
      publicBaseUrl,
      viewerUserId: userId,
    });
    if (!createdNow) return { message: dto };
    if (media.some((m) => m.kind === "audio")) {
      this.sideEffects.dispatch(
        "media.transcribe.request",
        { messageId: result.id },
        { jobId: `transcribe-${result.id}` },
      );
    }
    const senderName =
      result.sender?.name?.trim() ||
      result.sender?.username?.trim() ||
      "Someone";
    for (const id of [userId, ...otherIds]) {
      this.presenceRealtime.emitMessageCreated(id, {
        conversationId,
        message: toMessageDto({
          message: result,
          publicBaseUrl,
          viewerUserId: id,
          mediaDeletedAt,
        }),
      });
      this.support.emitUnreadCounts(id);
    }
    const pushBody = messagePushPreview({ body: trimmed, media });
    const pushRecipients = conversation.participants.filter(
      (p) => p.userId !== userId && p.status !== "pending",
    );
    for (const recipient of pushRecipients) {
      this.events.emitMessagePushRequested({
        recipientUserId: recipient.userId,
        senderUserId: userId,
        senderName,
        body: pushBody,
        conversationId,
      });
    }

    this.posthog.capture(userId, "message_sent", {
      conversation_id: conversationId,
      conversation_type: this.support.chatConversationType(conversation.type),
    });

    await enqueueMessageMarvReply(this.appConfig, this.support, this.jobs, {
      userId,
      conversationId,
      messageId: result.id,
      conversationType: conversation.type,
      otherIds,
      body: trimmed,
    });

    return { message: dto };
  }
}
