import { assertPublishableText } from "../../common/moderation/content-filter";
import { requireAiConsent } from "../marvin/services/ai-consent";
import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type { MessageConversation } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { AppConfigService } from "../app/app-config.service";
import { PresenceRealtimeService } from "../presence/presence-realtime.service";
import { DomainEventsService } from "../events/domain-events.service";
import { RedisService } from "../redis/redis.service";
import { RedisKeys } from "../redis/redis-keys";
import { toUserListDto } from "../../common/dto";
import { findReactionById } from "../../common/constants/reactions";
import {
  toMessageDto,
  toMessageCallDto,
  messagePushPreview,
  type MessageDto,
} from "./message.dto";
import { PosthogService } from "../../common/posthog/posthog.service";
import { JobsService } from "../jobs/jobs.service";
import { JOBS } from "../jobs/jobs.constants";
import { MarvinBotIdentityService } from "../marvin/services/marvin-bot-identity.service";
import { SideEffectsService } from "../side-effects/side-effects.service";
import { CallSessionStore } from "../calls/call-session.store";
import { MessagesSupportService, MESSAGE_BODY_MAX, MESSAGE_INCLUDE, MESSAGE_EDIT_WINDOW_MS, MESSAGE_UNREAD_CACHE_TTL_MS } from "./messages-support.service";
import { messageMediaCreateData, type MessageMediaInput } from "./messages.models";

@Injectable()
export class MessagesWriteService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly appConfig: AppConfigService,
    private readonly presenceRealtime: PresenceRealtimeService,
    private readonly events: DomainEventsService,
    private readonly redis: RedisService,
    private readonly posthog: PosthogService,
    private readonly jobs: JobsService,
    private readonly marvIdentity: MarvinBotIdentityService,
    private readonly sideEffects: SideEffectsService,
    private readonly callSessions: CallSessionStore,
    private readonly support: MessagesSupportService,
  ) {}
  /**
   * Find or create a bot↔user DM conversation without sending a message.
   * Returns null when blocked, banned, or self-DM.
   *
   * Used when a canned bot DM needs an idempotency claim keyed on conversationId
   * before the first message is written.
   */
  async ensureBotDirectConversation(params: {
    botUserId: string;
    recipientUserId: string;
  }): Promise<string | null> {
    const { botUserId, recipientUserId } = params;
    if (botUserId === recipientUserId) return null;

    const blocked = await this.support.isBlockedBetween(botUserId, recipientUserId);
    if (blocked) {
      this.support.logger.debug(
        `[messages] ensureBotDirectConversation: skipping (blocked) ${botUserId}->${recipientUserId}.`,
      );
      return null;
    }

    const directKey = this.support.directKeyFor(botUserId, recipientUserId);
    const existing = await this.prisma.messageConversation.findFirst({
      where: { type: 'direct', directKey },
      select: { id: true },
    });
    if (existing) return existing.id;

    const recipient = await this.prisma.user.findUnique({
      where: { id: recipientUserId },
      select: { id: true, bannedAt: true },
    });
    if (!recipient) throw new NotFoundException('Recipient not found.');
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
            type: 'direct',
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
              role: 'owner' as const,
              status: 'accepted' as const,
              acceptedAt: now,
              lastReadAt: now,
            },
            {
              conversationId: created.id,
              userId: recipientUserId,
              role: 'member' as const,
              status: 'accepted' as const,
              acceptedAt: now,
            },
          ],
        });

        return created;
      });
      return conversation.id;
    } catch (err) {
      // Concurrent create on the same directKey — re-read the winner.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const raced = await this.prisma.messageConversation.findFirst({
          where: { type: 'direct', directKey },
          select: { id: true },
        });
        return raced?.id ?? null;
      }
      throw err;
    }
  }

  /**
   * Send a direct message FROM a bot account TO a user, creating the direct conversation
   * if one doesn't already exist.
   *
   * Skips the standard chat-tier gates (verified-only recipients, "premium starts new chat")
   * because bots only ever speak in response to user-initiated activity. Block checks DO
   * still apply — if the user has blocked the bot, we silently no-op.
   *
   * Used by Marv to deliver canned out-of-credits notices and AI replies in private sessions.
   */
  async sendBotDirectMessage(params: {
    botUserId: string;
    recipientUserId: string;
    body: string;
    media?: MessageMediaInput[];
  }): Promise<{ conversationId: string; message: MessageDto } | null> {
    const { botUserId, recipientUserId } = params;
    const trimmed = (params.body ?? '').trim();
    const media = params.media ?? [];
    if (!trimmed && media.length === 0) throw new BadRequestException('Message must have a body or media.');
    if (trimmed.length > MESSAGE_BODY_MAX) throw new BadRequestException('Message body is too long.');

    if (botUserId === recipientUserId) {
      throw new BadRequestException('A bot cannot DM itself.');
    }

    const conversationId = await this.ensureBotDirectConversation({ botUserId, recipientUserId });
    if (!conversationId) return null;

    const sent = await this.sendMessage({
      userId: botUserId,
      conversationId,
      body: trimmed,
      media,
    });
    return { conversationId, message: sent.message };
  }

  async createConversation(params: {
    userId: string;
    recipientUserIds: string[];
    title?: string | null;
    body: string;
    media?: MessageMediaInput[];
  }) {
    assertPublishableText(params.body, params.title);
    const { userId, recipientUserIds, title, body } = params;
    const trimmed = (body ?? '').trim();
    const media = params.media ?? [];
    if (!trimmed && media.length === 0) throw new BadRequestException('Message must have a body or media.');
    if (trimmed.length > MESSAGE_BODY_MAX) throw new BadRequestException('Message body is too long.');

    const uniqueRecipients = [...new Set(recipientUserIds.filter(Boolean))].filter((id) => id !== userId);
    if (uniqueRecipients.length === 0) throw new BadRequestException('At least one recipient is required.');

    const marvRecipient = await this.marvIdentity.getMarvUserId();
    if (marvRecipient && uniqueRecipients.length === 1 && uniqueRecipients.includes(marvRecipient)) await requireAiConsent(this.prisma, userId);

    // Tier rule:
    // - Site admins can start new chats with any user (verified or not) and bypass the mutual-follow gate.
    // - Verified members can start new chats only with mutuals (both follow each other).
    // - Premium members can start new chats with any verified member.
    // If a direct thread already exists (any tier), the message is routed to sendMessage directly.
    const sender = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { premium: true, premiumPlus: true, verifiedStatus: true, bannedAt: true, siteAdmin: true },
    });
    if (!sender) throw new NotFoundException('User not found.');
    if (sender.bannedAt) {
      // Defense-in-depth: AuthGuard already revokes the session and throws on banned users.
      // This guards the ~30s session-cache window and any internal/job callers.
      throw new ForbiddenException({
        message: 'This account was banned. Contact an admin if you think it’s a mistake.',
        error: 'account_banned',
      });
    }
    const senderIsAdmin = Boolean(sender.siteAdmin);
    const senderIsVerified = Boolean(sender.verifiedStatus && sender.verifiedStatus !== 'none');
    const senderIsPremium = Boolean(sender.premium || sender.premiumPlus);
    if (!senderIsAdmin && !senderIsVerified && !senderIsPremium) {
      // Load-bearing gate: MessagesController no longer uses VerifiedGuard (unverified users
      // must be able to reply in admin-initiated threads). This is the primary sender check.
      throw new ForbiddenException('Verify to use chat.');
    }
    await this.support.assertNotBlocked(userId, uniqueRecipients);

    const isDirect = uniqueRecipients.length === 1;
    const type: MessageConversation['type'] = isDirect ? 'direct' : 'group';
    const directKey = isDirect ? this.support.directKeyFor(userId, uniqueRecipients[0]) : null;

    // Marv cannot be in a group conversation — only 1:1 DMs are allowed.
    if (!isDirect) {
      const marvUserId = await this.support.resolveMarvUserId();
      if (marvUserId && uniqueRecipients.includes(marvUserId)) {
        throw new BadRequestException('Marv cannot be added to a group chat.');
      }
    }

    if (directKey) {
      const existing = await this.prisma.messageConversation.findFirst({
        where: { type: 'direct', directKey },
        select: { id: true },
      });
      if (existing) {
        const sent = await this.sendMessage({ userId, conversationId: existing.id, body: trimmed, media });
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
    if (users.length !== uniqueRecipients.length) throw new NotFoundException('User not found.');
    for (const u of users) {
      if (u.bannedAt) {
        throw new BadRequestException('Cannot message a banned user.');
      }
      if (!senderIsAdmin && (!u.verifiedStatus || u.verifiedStatus === 'none')) {
        throw new ForbiddenException('You can only start chats with verified members.');
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
      const senderFollowingSet = new Set(senderFollowing.map((f) => f.followingId));
      const senderFollowerSet = new Set(senderFollowers.map((f) => f.followerId));
      const nonMutualRecipients = uniqueRecipients.filter(
        (id) => !senderFollowingSet.has(id) || !senderFollowerSet.has(id),
      );
      if (nonMutualRecipients.length > 0) {
        throw new ForbiddenException(
          'You can only message people who follow you back. Upgrade to Premium to message any member.',
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

    const result = await this.prisma.$transaction(async (tx) => {
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
          role: 'owner' as const,
          status: 'accepted' as const,
          acceptedAt: now,
          lastReadAt: now,
        },
        ...uniqueRecipients.map((recipientId) => ({
          conversationId: conversation.id,
          userId: recipientId,
          role: 'member' as const,
          // Admin-initiated threads are always accepted so the message lands in the
          // primary inbox (not the Requests tab) and push shows the real body.
          status: senderIsAdmin || followerSet.has(recipientId) ? ('accepted' as const) : ('pending' as const),
          acceptedAt: senderIsAdmin || followerSet.has(recipientId) ? now : null,
        })),
      ];

      await tx.messageParticipant.createMany({ data: participantRows });

      const message = await tx.message.create({
        data: {
          conversationId: conversation.id,
          senderId: userId,
          body: trimmed,
          ...(media.length > 0 ? { media: { create: messageMediaCreateData(media) } } : {}),
        },
        include: MESSAGE_INCLUDE,
      });

      await tx.messageConversation.update({
        where: { id: conversation.id },
        data: { lastMessageId: message.id, lastMessageAt: now },
      });

      return { conversationId: conversation.id, message };
    });

    const publicBaseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;
    const dto = toMessageDto({ message: result.message, publicBaseUrl, viewerUserId: userId });
    if (media.some((m) => m.kind === 'audio')) {
      this.sideEffects.dispatch('media.transcribe.request', { messageId: result.message.id }, { jobId: `transcribe-${result.message.id}` });
    }
    const senderName =
      result.message.sender?.name?.trim() ||
      result.message.sender?.username?.trim() ||
      'Someone';

    this.support.emitUnreadCounts(userId);
    this.presenceRealtime.emitMessageCreated(userId, { conversationId: result.conversationId, message: dto });
    for (const recipientId of uniqueRecipients) {
      this.support.emitUnreadCounts(recipientId);
      this.presenceRealtime.emitMessageCreated(recipientId, { conversationId: result.conversationId, message: dto });
    }
    for (const recipientId of uniqueRecipients) {
      const isPending = !followerSet.has(recipientId);
      const pushBody = isPending ? 'Sent you a message request' : messagePushPreview({ body: trimmed, media });
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
      const marvUserId = marvCfg.enabled ? await this.support.resolveMarvUserId() : null;
      const recipientIsMarv =
        !!marvUserId && uniqueRecipients.length === 1 && uniqueRecipients[0] === marvUserId;
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
              backoff: { type: 'exponential' as const, delay: 5000 },
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
  }) {
    assertPublishableText(params.body);
    const { userId, conversationId } = params;
    const trimmed = (params.body ?? '').trim();
    const media = params.media ?? [];
    if (!trimmed && media.length === 0) throw new BadRequestException('Message must have a body or media.');
    if (trimmed.length > MESSAGE_BODY_MAX) throw new BadRequestException('Message body is too long.');

    let conversation = await this.support.getConversationOrThrow({ userId, conversationId });
    const directPair = conversation.type === 'direct' ? this.support.parseDirectPair(conversation.directKey) : null;
    if (directPair) {
      const present = new Set(conversation.participants.map((p) => p.userId));
      const missingPeer = directPair.filter((id) => !present.has(id));
      if (missingPeer.length > 0) {
        await this.support.restoreMissingDirectParticipants({
          conversationId,
          createdByUserId: conversation.createdByUserId,
          userIds: missingPeer,
        });
        conversation = await this.support.getConversationOrThrow({ userId, conversationId });
      }
    }
    const participant = conversation.participants.find((p) => p.userId === userId);
    if (!participant) throw new NotFoundException('Conversation not found.');

    // Defense-in-depth ban check: AuthGuard normally rejects banned users at the session
    // boundary, but this protects against stale session caches and any internal callers.
    const sender = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { bannedAt: true, verifiedStatus: true, premium: true, premiumPlus: true },
    });
    if (sender?.bannedAt) {
      throw new ForbiddenException({
        message: 'This account was banned. Contact an admin if you think it’s a mistake.',
        error: 'account_banned',
      });
    }

    if (media.length > 0) {
      const viewerIsVerified = Boolean(sender?.verifiedStatus && sender.verifiedStatus !== 'none');
      const viewerIsPremium = Boolean(sender?.premium || sender?.premiumPlus);
      const hasVideo = media.some((m) => m.kind === 'video');
      const hasAudio = media.some((m) => m.kind === 'audio');
      const hasImageOrGif = media.some((m) => m.kind !== 'video' && m.kind !== 'audio');
      if ((hasImageOrGif || hasAudio) && !viewerIsVerified) {
        throw new ForbiddenException('Verify your account to send photos and voice notes in chat.');
      }
      if (hasVideo && !viewerIsPremium) {
        throw new ForbiddenException('Video messages are for premium members only.');
      }
    }

    const blockedIds = await this.support._getBlockedUserIds(userId);
    const otherIds = conversation.participants.filter((p) => p.userId !== userId).map((p) => p.userId);
    for (const otherId of otherIds) {
      if (blockedIds.has(otherId)) throw new ForbiddenException('You cannot message this user.');
    }

    // Validate replyToId belongs to the same conversation.
    const replyToId = params.replyToId ?? null;
    if (replyToId) {
      const replyTarget = await this.prisma.message.findFirst({
        where: { id: replyToId, conversationId },
        select: { id: true },
      });
      if (!replyTarget) throw new BadRequestException('Reply target not found in this conversation.');
    }

    const marvId = await this.marvIdentity.getMarvUserId();
    // Consent belongs to the human requesting AI, never to the bot delivering its answer.
    if (userId !== marvId && conversation.participants.some(p => p.userId === marvId)) await requireAiConsent(this.prisma, userId);

    const now = new Date();
    const result = await this.prisma.$transaction(async (tx) => {
      const message = await tx.message.create({
        data: {
          conversationId,
          senderId: userId,
          body: trimmed,
          ...(replyToId ? { replyToId } : {}),
          ...(media.length > 0 ? { media: { create: messageMediaCreateData(media) } } : {}),
        },
        include: MESSAGE_INCLUDE,
      });

      await tx.messageConversation.update({
        where: { id: conversationId },
        data: { lastMessageId: message.id, lastMessageAt: now },
      });

      await tx.messageParticipant.update({
        where: { conversationId_userId: { conversationId, userId } },
        data: { lastReadAt: now, status: 'accepted', acceptedAt: participant.acceptedAt ?? now },
      });

      if (conversation.type === 'direct' && participant.status === 'pending') {
        await tx.messageParticipant.updateMany({
          where: { conversationId, status: 'pending' },
          data: { status: 'accepted', acceptedAt: now },
        });
      }

      return message;
    });

    const publicBaseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;
    const dto = toMessageDto({ message: result, publicBaseUrl, viewerUserId: userId });
    if (media.some((m) => m.kind === 'audio')) {
      this.sideEffects.dispatch('media.transcribe.request', { messageId: result.id }, { jobId: `transcribe-${result.id}` });
    }
    const senderName =
      result.sender?.name?.trim() ||
      result.sender?.username?.trim() ||
      'Someone';
    for (const id of [userId, ...otherIds]) {
      this.presenceRealtime.emitMessageCreated(id, { conversationId, message: dto });
      this.support.emitUnreadCounts(id);
    }
    const pushBody = messagePushPreview({ body: trimmed, media });
    const pushRecipients = conversation.participants.filter(
      (p) => p.userId !== userId && p.status !== 'pending',
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

    this.posthog.capture(userId, 'message_sent', {
      conversation_id: conversationId,
      conversation_type: this.support.chatConversationType(conversation.type),
    });

    // ─── Marv: queue an AI reply when this DM is for the configured Marv bot ──
    // Decoupled from MarvinModule — we only enqueue. The processor handles all gating.
    // Resolve Marv's user id via the identity service (env var optional) so the gate
    // doesn't silently skip when `MARV_USER_ID` isn't pinned in `.env`.
    try {
      const marvCfg = this.appConfig.marvBot();
      const marvUserId = marvCfg.enabled ? await this.support.resolveMarvUserId() : null;
      const isDirect = conversation.type === 'direct';
      const recipientIsMarv = !!marvUserId && otherIds.length === 1 && otherIds[0] === marvUserId;
      const senderIsMarv = !!marvUserId && userId === marvUserId;
      const hasBody = trimmed.length > 0;

      if (!marvCfg.enabled) {
        this.support.logger.log(`[marv] dm-enqueue skip reason=marv_disabled msg=${result.id}`);
      } else if (!marvUserId) {
        this.support.logger.warn(`[marv] dm-enqueue skip reason=marv_user_unresolved msg=${result.id}`);
      } else if (!isDirect) {
        // Group chat or wall — never enqueue for Marv. No log needed; spammy.
      } else if (!recipientIsMarv) {
        // DM to someone else — silent skip.
      } else if (senderIsMarv) {
        this.support.logger.log(`[marv] dm-enqueue skip reason=sender_is_marv msg=${result.id}`);
      } else if (!hasBody) {
        this.support.logger.log(`[marv] dm-enqueue skip reason=empty_body msg=${result.id}`);
      } else {
        this.support.logger.log(
          `[marv] dm-enqueue HIT msg=${result.id} convo=${conversationId} sender=${userId}`,
        );
        await this.jobs
          .enqueue(
            JOBS.marvinReplyPrivate,
            {
              conversationId,
              messageId: result.id,
              requestingUserId: userId,
              requestedMode: null,
            },
            {
              jobId: `marv-private-${result.id}`,
              removeOnComplete: true,
              removeOnFail: false,
              attempts: 3,
              backoff: { type: 'exponential' as const, delay: 5000 },
            },
          )
          .then(() => {
            this.support.logger.log(`[marv] dm-enqueue ok msg=${result.id} job=marv-private-${result.id}`);
          })
          .catch((err) => {
            this.support.logger.warn(
              `[marv] Failed to enqueue private reply for message=${result.id}: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          });
      }
    } catch (err) {
      this.support.logger.warn(
        `[marv] private-reply enqueue failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    return { message: dto };
  }

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
      where: { conversationId_userId: { conversationId, userId }, conversation: { type: { not: 'channel' } } },
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
    const conversation = await this.support.getConversationOrThrow({ userId, conversationId });
    const now = new Date();
    if (conversation.type === 'direct') {
      await this.prisma.messageParticipant.updateMany({
        where: { conversationId, status: 'pending' },
        data: { status: 'accepted', acceptedAt: now },
      });
    } else {
      await this.prisma.messageParticipant.update({
        where: { conversationId_userId: { conversationId, userId } },
        data: { status: 'accepted', acceptedAt: now },
      });
    }
    this.support.emitUnreadCounts(userId);
  }

  async blockUser(params: { userId: string; targetUserId: string }) {
    const { userId, targetUserId } = params;
    if (userId === targetUserId) throw new BadRequestException('You cannot block yourself.');
    await this.prisma.userBlock.upsert({
      where: { blockerId_blockedId: { blockerId: userId, blockedId: targetUserId } },
      create: { blockerId: userId, blockedId: targetUserId },
      update: {},
    });
    // Auto-unfollow: blocker should not be following the blocked user.
    await this.prisma.follow.deleteMany({
      where: { followerId: userId, followingId: targetUserId },
    });
    this.support.emitUnreadCounts(userId);
    // Bust cached block sets so feed filtering reflects the new block immediately.
    void this.redis.del(RedisKeys.viewerBlockSets(userId), RedisKeys.viewerBlockSets(targetUserId)).catch(() => undefined);
    // Notify other tabs/devices of the blocker that their block/follow/filter state changed.
    this.presenceRealtime.emitUsersMeRefresh(userId, 'block_changed');
  }

  async unblockUser(params: { userId: string; targetUserId: string }) {
    const { userId, targetUserId } = params;
    await this.prisma.userBlock.deleteMany({
      where: { blockerId: userId, blockedId: targetUserId },
    });
    this.support.emitUnreadCounts(userId);
    void this.redis.del(RedisKeys.viewerBlockSets(userId), RedisKeys.viewerBlockSets(targetUserId)).catch(() => undefined);
    // Notify other tabs/devices of the unblocker that their block/follow/filter state changed.
    this.presenceRealtime.emitUsersMeRefresh(userId, 'block_changed');
  }

  async listBlocks(params: { userId: string }) {
    const rows = await this.prisma.userBlock.findMany({
      where: { blockerId: params.userId },
      include: {
        blocked: {
          select: {
            id: true,
            username: true,
            name: true,
            premium: true,
            premiumPlus: true,
            isOrganization: true,
            verifiedStatus: true,
            avatarKey: true, avatarVideoKey: true, avatarVideoDurationMs: true,
            avatarUpdatedAt: true,
          },
        },
      },
      orderBy: [{ createdAt: 'desc' }, { blockedId: 'desc' }],
    });
    const publicBaseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;
    return rows.map((row) => ({
      blocked: toUserListDto(row.blocked, publicBaseUrl),
      createdAt: row.createdAt.toISOString(),
    }));
  }

  async getUnreadSummary(userId: string): Promise<{ primary: number; requests: number }> {
    const cacheKey = RedisKeys.messageUnreadSummary(userId);
    try {
      const cached = await this.redis.getJson<{ primary: number; requests: number }>(cacheKey);
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

  async addReaction(params: {
    userId: string;
    conversationId: string;
    messageId: string;
    reactionId: string;
  }): Promise<MessageDto> {
    const { userId, conversationId, messageId, reactionId } = params;

    const reaction = findReactionById(reactionId);
    if (!reaction) throw new BadRequestException('Invalid reaction.');

    await this.support.getConversationOrThrow({ userId, conversationId });

    const message = await this.prisma.message.findFirst({
      where: { id: messageId, conversationId },
      select: { id: true },
    });
    if (!message) throw new NotFoundException('Message not found.');

    await this.prisma.messageReaction.upsert({
      where: { messageId_userId_reactionId: { messageId, userId, reactionId } },
      create: { messageId, userId, reactionId, emoji: reaction.emoji },
      update: {},
    });

    const updated = await this.prisma.message.findUniqueOrThrow({
      where: { id: messageId },
      include: MESSAGE_INCLUDE,
    });
    const publicBaseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;
    const dto = toMessageDto({ message: updated, publicBaseUrl, viewerUserId: userId });

    const participants = await this.prisma.messageParticipant.findMany({
      where: { conversationId },
      select: { userId: true },
    });
    for (const p of participants) {
      const participantDto = toMessageDto({ message: updated, publicBaseUrl, viewerUserId: p.userId });
      this.presenceRealtime.emitMessageReactionUpdated(p.userId, { conversationId, message: participantDto });
    }

    return dto;
  }

  async removeReaction(params: {
    userId: string;
    conversationId: string;
    messageId: string;
    reactionId: string;
  }): Promise<void> {
    const { userId, conversationId, messageId, reactionId } = params;

    await this.support.getConversationOrThrow({ userId, conversationId });

    await this.prisma.messageReaction.deleteMany({
      where: { messageId, userId, reactionId },
    });

    const updated = await this.prisma.message.findFirst({
      where: { id: messageId, conversationId },
      include: MESSAGE_INCLUDE,
    });
    if (!updated) return;

    const publicBaseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;
    const participants = await this.prisma.messageParticipant.findMany({
      where: { conversationId },
      select: { userId: true },
    });
    for (const p of participants) {
      const participantDto = toMessageDto({ message: updated, publicBaseUrl, viewerUserId: p.userId });
      this.presenceRealtime.emitMessageReactionUpdated(p.userId, { conversationId, message: participantDto });
    }
  }

  async deleteMessageForMe(params: { userId: string; conversationId: string; messageId: string }): Promise<void> {
    const { userId, conversationId, messageId } = params;

    await this.support.getConversationOrThrow({ userId, conversationId });

    const message = await this.prisma.message.findFirst({
      where: { id: messageId, conversationId },
      select: { id: true },
    });
    if (!message) throw new NotFoundException('Message not found.');

    await this.prisma.messageDeletion.upsert({
      where: { messageId_userId: { messageId, userId } },
      create: { messageId, userId },
      update: {},
    });
  }

  async restoreMessageForMe(params: { userId: string; conversationId: string; messageId: string }): Promise<void> {
    const { userId, conversationId, messageId } = params;

    await this.support.getConversationOrThrow({ userId, conversationId });

    await this.prisma.messageDeletion.deleteMany({
      where: { messageId, userId },
    });
  }

  async muteConversation(params: { userId: string; conversationId: string }): Promise<void> {
    const { userId, conversationId } = params;
    await this.support.getConversationOrThrow({ userId, conversationId });
    await this.prisma.messageParticipant.update({
      where: { conversationId_userId: { conversationId, userId } },
      data: { mutedAt: new Date() },
    });
  }

  async unmuteConversation(params: { userId: string; conversationId: string }): Promise<void> {
    const { userId, conversationId } = params;
    await this.support.getConversationOrThrow({ userId, conversationId });
    await this.prisma.messageParticipant.update({
      where: { conversationId_userId: { conversationId, userId } },
      data: { mutedAt: null },
    });
  }

  /**
   * Caller attaches one video to a missed-call row. Emits `messages:edited` so both
   * sides patch the existing chip instead of growing a second message.
   */
  async attachCallVoicemail(params: {
    userId: string;
    conversationId: string;
    messageId: string;
    media: MessageMediaInput;
  }) {
    const { userId, conversationId, messageId, media } = params;
    if (media.source !== 'upload' || media.kind !== 'video') {
      throw new BadRequestException('Voicemail must be a video upload.');
    }

    const conversation = await this.support.getConversationOrThrow({ userId, conversationId });
    if (conversation.type !== 'direct') {
      throw new BadRequestException('Voicemail is only for direct calls.');
    }

    const existing = await this.prisma.message.findFirst({
      where: { id: messageId, conversationId },
      include: { media: true },
    });
    if (!existing || existing.kind !== 'call') throw new NotFoundException('Call message not found.');
    if (existing.senderId !== userId) {
      throw new ForbiddenException('Only the caller can leave a video message.');
    }
    const call = toMessageCallDto(existing.callMeta);
    if (!call || call.outcome !== 'missed') {
      throw new BadRequestException('A video message can only be left on a missed call.');
    }
    if ((existing.media?.length ?? 0) > 0) {
      throw new BadRequestException('This call already has a video message.');
    }

    const [create] = messageMediaCreateData([media]);
    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.messageMedia.create({
        data: { messageId, ...create },
      });
      return tx.message.update({
        where: { id: messageId },
        data: { body: 'Missed video call · Left a message' },
        include: MESSAGE_INCLUDE,
      });
    });

    const publicBaseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;
    const dto = toMessageDto({ message: updated, publicBaseUrl, viewerUserId: userId });
    for (const p of conversation.participants) {
      const viewerDto = toMessageDto({ message: updated, publicBaseUrl, viewerUserId: p.userId });
      this.presenceRealtime.emitMessageEdited(p.userId, { conversationId, message: viewerDto });
    }
    const senderName =
      updated.sender?.name?.trim() || updated.sender?.username?.trim() || 'Someone';
    for (const recipient of conversation.participants.filter(
      (p) => p.userId !== userId && p.status !== 'pending',
    )) {
      this.events.emitMessagePushRequested({
        recipientUserId: recipient.userId,
        senderUserId: userId,
        senderName,
        body: '📹 Left you a video message',
        conversationId,
      });
    }
    return dto;
  }

  async editMessage(params: { userId: string; conversationId: string; messageId: string; body: string }): Promise<void> {
    assertPublishableText(params.body);
    const { userId, conversationId, messageId, body } = params;

    const conversation = await this.support.getConversationOrThrow({ userId, conversationId });

    const message = await this.prisma.message.findFirst({
      where: { id: messageId, conversationId },
      include: MESSAGE_INCLUDE,
    });
    if (!message) throw new NotFoundException('Message not found.');
    if (message.senderId !== userId) throw new ForbiddenException('You can only edit your own messages.');
    if (message.deletedForAll) throw new BadRequestException('Cannot edit a deleted message.');

    const ageMs = Date.now() - message.createdAt.getTime();
    if (ageMs > MESSAGE_EDIT_WINDOW_MS) {
      throw new BadRequestException('Messages can only be edited within 15 minutes of sending.');
    }

    const publicBaseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;
    const now = new Date();
    const updated = await this.prisma.message.update({
      where: { id: messageId },
      data: { body, editedAt: now },
      include: MESSAGE_INCLUDE,
    });

    for (const p of conversation.participants) {
      const dto = toMessageDto({ message: updated, publicBaseUrl, viewerUserId: p.userId });
      this.presenceRealtime.emitMessageEdited(p.userId, { conversationId, message: dto });
    }
  }

  async deleteMessageForAll(params: { userId: string; conversationId: string; messageId: string }): Promise<void> {
    const { userId, conversationId, messageId } = params;

    const conversation = await this.support.getConversationOrThrow({ userId, conversationId });

    const message = await this.prisma.message.findFirst({
      where: { id: messageId, conversationId },
      select: { id: true, senderId: true, deletedForAll: true },
    });
    if (!message) throw new NotFoundException('Message not found.');
    if (message.senderId !== userId) throw new ForbiddenException('You can only delete your own messages.');
    if (message.deletedForAll) return; // idempotent

    const now = new Date();
    await this.prisma.message.update({
      where: { id: messageId },
      data: { deletedForAll: true, deletedForAllAt: now },
    });

    if (conversation.lastMessageId === messageId) {
      const prev = await this.prisma.message.findFirst({
        where: { conversationId, deletedForAll: false },
        orderBy: { createdAt: 'desc' },
        select: { id: true, body: true, createdAt: true, senderId: true },
      });
      await this.prisma.messageConversation.update({
        where: { id: conversationId },
        data: {
          lastMessageId: prev?.id ?? null,
          lastMessageAt: prev?.createdAt ?? null,
        },
      });
    }

    for (const p of conversation.participants) {
      this.presenceRealtime.emitMessageDeletedForAll(p.userId, { conversationId, messageId });
    }
  }
}
