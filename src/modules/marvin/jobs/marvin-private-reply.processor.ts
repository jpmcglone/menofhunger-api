import { Injectable, Logger } from '@nestjs/common';
import { Prisma, type MarvinMode } from '@prisma/client';
import type { ResolvedMarvinMode } from '../services/marvin-routing.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AppConfigService } from '../../app/app-config.service';
import { MessagesService } from '../../messages/messages.service';
import { MarvinAIService, MarvinAINotConfiguredError } from '../services/marvin-ai.service';
import { MarvinBotIdentityService } from '../services/marvin-bot-identity.service';
import { MarvinCannedRepliesService } from '../services/marvin-canned-replies.service';
import { MarvinCreditService, InsufficientMarvCreditsError } from '../services/marvin-credit.service';
import { MarvinPromptBuilderService } from '../services/marvin-prompt-builder.service';
import { MarvinRoutingService } from '../services/marvin-routing.service';
import { MarvinToolHandlersService } from '../services/marvin-tool-handlers.service';
import { MarvinUsageService } from '../services/marvin-usage.service';
import { PresenceRealtimeService } from '../../presence/presence-realtime.service';
import { MARV_ERROR_CODES, buildMarvIdempotencyKey } from '../marvin.constants';
import { LinkMetadataService } from '../../link-metadata/link-metadata.service';
import { publicAssetUrl } from '../../../common/assets/public-asset-url';
import { parseMentionsFromBody } from '../../../common/mentions/mention-regex';

/**
 * How often to re-emit `messages:typing` while the AI call is in flight.
 * The web client expires the indicator after 3500ms of silence (see
 * `useChatTyping.TYPING_TTL_MS`), so we heartbeat below that to keep the
 * dots animating across long replies (tool loops can take 10–15s).
 */
const TYPING_HEARTBEAT_MS = 2000;

export type MarvinPrivateReplyJobPayload = {
  /** The conversation between Marv and the requester. */
  conversationId: string;
  /** The exact message id that triggered this reply (used for idempotency). */
  messageId: string;
  /** The user who sent the message. */
  requestingUserId: string;
  /** Optional mode override (from a future header on the message create call). */
  requestedMode?: MarvinMode | null;
};

/**
 * BullMQ "marvin.reply.private" worker — same shape as the public processor, but:
 *
 *  - source = `private_session`
 *  - reply is sent via `MessagesService.sendBotDirectMessage` (existing direct conversation)
 *  - chains `previous_response_id` from `MarvinPrivateSessionState.lastResponseId` for memory
 *  - rate limits use the private knobs in `marvLimits()`
 *  - non-premium → out-of-credits-style canned DM (same author flow, different copy)
 *
 * Idempotency: keyed by `(private_session, conversationId, requesterUserId, messageId)`.
 */
@Injectable()
export class MarvinPrivateReplyProcessor {
  private readonly logger = new Logger(MarvinPrivateReplyProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly appConfig: AppConfigService,
    private readonly identity: MarvinBotIdentityService,
    private readonly messages: MessagesService,
    private readonly credits: MarvinCreditService,
    private readonly routing: MarvinRoutingService,
    private readonly promptBuilder: MarvinPromptBuilderService,
    private readonly ai: MarvinAIService,
    private readonly tools: MarvinToolHandlersService,
    private readonly usage: MarvinUsageService,
    private readonly canned: MarvinCannedRepliesService,
    private readonly presenceRealtime: PresenceRealtimeService,
    private readonly linkMetadata: LinkMetadataService,
  ) {}

  /**
   * Show "Marv is typing…" to the recipient for the duration of the AI call.
   * Returns a `stop()` function that clears the heartbeat and emits
   * `typing: false` exactly once. Always call `stop()` in a `finally` so the
   * indicator never gets stuck if the AI call throws.
   */
  private startTypingHeartbeat(args: {
    conversationId: string;
    fromUserId: string;
    toUserId: string;
  }): { stop: () => void; setPhase: (phase: 'thinking' | 'typing') => void } {
    const { conversationId, fromUserId, toUserId } = args;
    const noop = { stop: () => {}, setPhase: () => {} };
    if (!conversationId || !fromUserId || !toUserId || fromUserId === toUserId) {
      return noop;
    }

    let stopped = false;
    let currentStatus: 'thinking' | 'typing' = 'thinking';

    const emit = (typing: boolean): void => {
      try {
        this.presenceRealtime.emitMessagesTypingFromUser(toUserId, fromUserId, {
          conversationId,
          typing,
          status: typing ? currentStatus : undefined,
        });
      } catch {
        // best-effort: typing is non-essential UX
      }
    };

    emit(true);
    const interval = setInterval(() => {
      if (stopped) return;
      emit(true);
    }, TYPING_HEARTBEAT_MS);

    return {
      stop: () => {
        if (stopped) return;
        stopped = true;
        clearInterval(interval);
        emit(false);
      },
      setPhase: (phase: 'thinking' | 'typing') => {
        currentStatus = phase;
        if (!stopped) emit(true);
      },
    };
  }

  async process(payload: MarvinPrivateReplyJobPayload): Promise<void> {
    const startedAt = Date.now();
    const { conversationId, messageId, requestingUserId } = payload;
    this.logger.log(
      `[marv] private-reply START convo=${conversationId} msg=${messageId} user=${requestingUserId} requestedMode=${payload.requestedMode ?? 'null'}`,
    );
    if (!conversationId || !messageId || !requestingUserId) {
      this.logger.warn('[marv] private-reply payload missing required ids; skipping.');
      return;
    }

    // 1. Idempotency claim.
    const idempotencyKey = buildMarvIdempotencyKey({
      source: 'private_session',
      sourceId: conversationId,
      userId: requestingUserId,
      messageId,
    });
    const claimed = await this.tryClaimIdempotency(idempotencyKey);
    if (!claimed) {
      this.logger.log(`[marv] private-reply EXIT reason=duplicate_idempotency key=${idempotencyKey}`);
      return;
    }

    // 2. Marv globally enabled? Disabled for user?
    const cfg = this.appConfig.marvBot();
    if (!cfg.enabled) {
      this.logger.log('[marv] private-reply EXIT reason=marv_disabled');
      return;
    }

    const settings = await this.prisma.marvinUserSettings.findUnique({
      where: { userId: requestingUserId },
      select: { preferredMode: true, disabledByAdmin: true },
    });
    if (settings?.disabledByAdmin) {
      this.logger.log(`[marv] private-reply EXIT reason=disabled_by_admin user=${requestingUserId}`);
      await this.usage.recordEvent({
        userId: requestingUserId,
        source: 'private_session',
        sourceId: conversationId,
        rootPostId: null,
        requestedMode: payload.requestedMode ?? settings.preferredMode ?? 'auto',
        effectiveMode: payload.requestedMode ?? settings.preferredMode ?? 'auto',
        creditsSpent: 0,
        errorCode: MARV_ERROR_CODES.disabledByAdmin,
        latencyMs: Date.now() - startedAt,
      });
      return;
    }

    const mediaSelect = {
      where: { kind: { not: 'video' as const } },
      select: { id: true, kind: true, source: true, r2Key: true, url: true },
    };

    // 3. Load the message + sender + media + optional replyTo media.
    const msg = await this.prisma.message.findFirst({
      where: { id: messageId, conversationId, deletedForAll: false },
      select: {
        id: true,
        body: true,
        senderId: true,
        sender: {
          select: { id: true, username: true, name: true, premium: true, premiumPlus: true, bannedAt: true },
        },
        media: mediaSelect,
        replyTo: {
          select: {
            body: true,
            media: mediaSelect,
          },
        },
      },
    });
    if (!msg || msg.senderId !== requestingUserId) {
      this.logger.log(
        `[marv] private-reply EXIT reason=message_missing_or_mismatch msg=${messageId} found=${!!msg}`,
      );
      return;
    }
    if (msg.sender.bannedAt) {
      this.logger.log(`[marv] private-reply EXIT reason=user_banned user=${requestingUserId}`);
      await this.usage.recordEvent({
        userId: requestingUserId,
        source: 'private_session',
        sourceId: conversationId,
        rootPostId: null,
        requestedMode: payload.requestedMode ?? settings?.preferredMode ?? 'auto',
        effectiveMode: payload.requestedMode ?? settings?.preferredMode ?? 'auto',
        creditsSpent: 0,
        errorCode: MARV_ERROR_CODES.userBanned,
        latencyMs: Date.now() - startedAt,
      });
      return;
    }

    const requesterIsPremium = Boolean(msg.sender.premium || msg.sender.premiumPlus);
    // 'auto' (or null) means let the routing service decide from fast upward.
    const requestedMode = payload.requestedMode ?? settings?.preferredMode ?? 'auto';
    this.logger.log(
      `[marv] private-reply gate-pass step=load_message bodyLen=${(msg.body ?? '').length} sender=@${msg.sender.username ?? '?'} premium=${requesterIsPremium}`,
    );

    // 4. Premium gate — non-premium users in private chat get the same out-of-credits-style DM.
    if (!requesterIsPremium) {
      this.logger.log(`[marv] private-reply EXIT reason=not_premium user=${requestingUserId}`);
      try {
        const marvId = await this.identity.getMarvUserId();
        if (marvId) {
          await this.messages.sendBotDirectMessage({
            botUserId: marvId,
            recipientUserId: requestingUserId,
            body:
              `I only reply for premium members right now. ` +
              `Upgrade here: ${this.appConfig.frontendBaseUrl()?.replace(/\/+$/, '') ?? ''}/tiers.`,
            media: [],
          });
        }
      } catch (err) {
        this.logger.warn(
          `[marv] failed to send non-premium DM: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      await this.usage.recordEvent({
        userId: requestingUserId,
        source: 'private_session',
        sourceId: conversationId,
        rootPostId: null,
        requestedMode,
        effectiveMode: requestedMode,
        creditsSpent: 0,
        errorCode: MARV_ERROR_CODES.notPremium,
        latencyMs: Date.now() - startedAt,
      });
      return;
    }

    // 5. Routing decision.
    const text = msg.body ?? '';
    const routed = this.routing.resolve({
      requested: requestedMode,
      source: 'private_session',
      estimatedInputTokens: this.routing.estimateTokens(text),
      text,
      webSearchEnabled: this.appConfig.marvOpenAI().webSearchEnabled,
    });
    const effectiveMode: ResolvedMarvinMode = routed.mode;
    this.logger.log(
      `[marv] private-reply gate-pass step=routing requested=${requestedMode} effective=${effectiveMode} reason=${routed.reason} crisis=${routed.crisisDetected} webSearchDemanded=${routed.webSearchDemanded}`,
    );

    // 6. Credit gate — must afford mode cost + vision + worst-case one web search.
    const cost = this.credits.costForMode(effectiveMode);
    const creditCfg = this.appConfig.marvCredits();
    const openAICfg = this.appConfig.marvOpenAI();
    const visionActive = openAICfg.visionEnabled && openAICfg.visionModes.includes(effectiveMode as string);
    const msgImageCount = visionActive ? Math.min((msg.media ?? []).length, openAICfg.visionMaxImagesPerTurn) : 0;
    const visionCost = msgImageCount * creditCfg.visionCreditCostPerImage;
    const webSearchBuffer = openAICfg.webSearchEnabled && openAICfg.webSearchModes.includes(effectiveMode as string)
      ? creditCfg.webSearchCreditCost
      : 0;
    const reservedCost = cost + visionCost + webSearchBuffer;
    const summary = await this.credits.refill(requestingUserId);
    this.logger.log(
      `[marv] private-reply gate-pass step=credits balance=${summary.credits} cost=${cost} vision=${visionCost} webSearchBuffer=${webSearchBuffer} reserved=${reservedCost} ok=${summary.credits >= reservedCost}`,
    );
    if (summary.credits < reservedCost) {
      this.logger.log(
        `[marv] private-reply EXIT reason=no_credits balance=${summary.credits} reserved=${reservedCost}`,
      );
      await this.canned.sendOutOfCreditsDm({
        userId: requestingUserId,
        currentCredits: summary.credits,
        requiredCredits: reservedCost,
        triggeringPostId: null,
      });
      await this.usage.recordEvent({
        userId: requestingUserId,
        source: 'private_session',
        sourceId: conversationId,
        rootPostId: null,
        requestedMode,
        effectiveMode,
        creditsSpent: 0,
        modelUsed: this.ai.modelForMode(effectiveMode),
        routingReason: routed.reason,
        errorCode: MARV_ERROR_CODES.noCredits,
        latencyMs: Date.now() - startedAt,
      });
      return;
    }

    // 7. Rate-limit gate (private).
    const limits = this.appConfig.marvLimits();
    const [past10MinCount, pastDayCount] = await Promise.all([
      this.usage.countRecent({ userId: requestingUserId, source: 'private_session', windowMinutes: 10 }),
      this.usage.countRecent({
        userId: requestingUserId,
        source: 'private_session',
        windowMinutes: 24 * 60,
      }),
    ]);
    if (past10MinCount >= limits.privateMaxPer10Minutes || pastDayCount >= limits.privateMaxPerUserPerDay) {
      const isDaily = pastDayCount >= limits.privateMaxPerUserPerDay;
      const errorCode = isDaily ? MARV_ERROR_CODES.rateLimitDaily : MARV_ERROR_CODES.rateLimitHourly;
      this.logger.log(
        `[marv] private-reply EXIT reason=${errorCode} user=${requestingUserId} 10min=${past10MinCount}/${limits.privateMaxPer10Minutes} day=${pastDayCount}/${limits.privateMaxPerUserPerDay}`,
      );
      await this.canned.sendRateLimitedDm({
        userId: requestingUserId,
        kind: isDaily ? 'daily' : 'per10min',
      });
      await this.usage.recordEvent({
        userId: requestingUserId,
        source: 'private_session',
        sourceId: conversationId,
        rootPostId: null,
        requestedMode,
        effectiveMode,
        creditsSpent: 0,
        modelUsed: this.ai.modelForMode(effectiveMode),
        routingReason: routed.reason,
        errorCode,
        latencyMs: Date.now() - startedAt,
      });
      return;
    }

    this.logger.log(`[marv] private-reply gate-pass step=rate_limit 10min=${past10MinCount} day=${pastDayCount}`);

    // 8. AI call.
    if (!this.ai.isConfigured()) {
      // Premium user, but the agent literally can't reply. DM them once per
      // conversation so they know to contact an admin (instead of staring at
      // a silent Marv).
      this.logger.warn(
        '[marv] private-reply EXIT reason=ai_not_configured (missing OPENAI_API_KEY or OPENAI_MARV_PROMPT_ID); sending canned DM.',
      );
      try {
        await this.canned.sendNotConfiguredDm({
          userId: requestingUserId,
          conversationId,
        });
      } catch (err) {
        this.logger.error(
          `[marv] Failed to send not-configured DM: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      await this.usage.recordEvent({
        userId: requestingUserId,
        source: 'private_session',
        sourceId: conversationId,
        rootPostId: null,
        requestedMode,
        effectiveMode,
        creditsSpent: 0,
        modelUsed: this.ai.modelForMode(effectiveMode),
        routingReason: routed.reason,
        errorCode: MARV_ERROR_CODES.aiNotConfigured,
        latencyMs: Date.now() - startedAt,
      });
      return;
    }

    // Pull previous response id for chain memory.
    const sessionState = await this.prisma.marvinPrivateSessionState.findUnique({
      where: { conversationId },
      select: { lastResponseId: true },
    });

    // Collect image URLs: current message first, then replyTo fills remaining slots.
    const publicBase = this.appConfig.r2()?.publicBaseUrl ?? null;

    const msgMedia = (msg.media ?? []).filter((m) => m.kind !== 'video');
    const replyToMedia = (msg.replyTo?.media ?? []).filter((m) => m.kind !== 'video');
    const totalMediaCount = msgMedia.length + replyToMedia.length;
    if (!visionActive && totalMediaCount > 0) {
      this.logger.warn(
        `[marv] private-reply vision DISABLED for mode=${effectiveMode} but ${totalMediaCount} image(s) present — Marv will not see them. To fix: add '${effectiveMode}' to MARV_VISION_MODES.`,
      );
    }
    const maxImages = visionActive ? openAICfg.visionMaxImagesPerTurn : 0;

    const imageEntries: { resolvedUrl: string; kind: string }[] = [];
    for (const m of [...msgMedia, ...replyToMedia]) {
      if (imageEntries.length >= maxImages) break;
      const resolved = m.source === 'upload' && m.r2Key
        ? publicAssetUrl({ publicBaseUrl: publicBase, key: m.r2Key })
        : (m.url ?? null);
      if (resolved) imageEntries.push({ resolvedUrl: resolved, kind: m.kind });
    }
    const imageUrls = imageEntries.map((e) => e.resolvedUrl);
    const hasGifAttached = imageEntries.some((e) => e.kind === 'gif');

    // Collect link previews from user's message + replyTo body (read-only, no external fetch).
    const previewBodies = [text, msg.replyTo?.body ?? ''].filter(Boolean).join('\n');
    const linkPreviews = await this.linkMetadata.previewLinks(previewBodies);

    // Extract @username mentions from the message (and replyTo) so Marv knows which
    // users are referenced and can call get_user_context_card / get_user_basic_info.
    const marvLower = this.identity.marvUsernameLower();
    const mentionBodies = [text, msg.replyTo?.body ?? ''].filter(Boolean).join('\n');
    const referencedUsernames = parseMentionsFromBody(mentionBodies)
      .filter((u) => u.toLowerCase() !== marvLower);

    const built = this.promptBuilder.build({
      source: 'private_session',
      requester: {
        userId: msg.sender.id,
        username: msg.sender.username,
        displayName: msg.sender.name,
      },
      currentQuestion: text,
      conversationId,
      referencedUsernames: referencedUsernames.length > 0 ? referencedUsernames : undefined,
      crisisDetected: routed.crisisDetected,
      webSearchDemanded: routed.webSearchDemanded,
      linkPreviews: linkPreviews.length > 0 ? linkPreviews : undefined,
      hasGifAttached: hasGifAttached || undefined,
    });
    // Show "Marv is typing…" to the user while the AI call is in flight. The
    // call can take 5–15s with tool loops, so we heartbeat below the client's
    // 3.5s typing TTL. Always stop in `finally` so the dots never stick.
    const marvUserIdForTyping = this.identity.cachedMarvUserId() ?? (await this.identity.getMarvUserId());
    const { stop: stopTyping, setPhase: setTypingPhase } = marvUserIdForTyping
      ? this.startTypingHeartbeat({
          conversationId,
          fromUserId: marvUserIdForTyping,
          toUserId: requestingUserId,
        })
      : { stop: () => {}, setPhase: () => {} };

    const aiStartedAt = Date.now();
    this.logger.log(
      `[marv] private-reply AI call START mode=${effectiveMode} model=${this.ai.modelForMode(effectiveMode)} prevResp=${sessionState?.lastResponseId ?? 'null'} userMsgLen=${built.userMessage.length}`,
    );

    let aiResult: Awaited<ReturnType<typeof this.ai.respond>> | null = null;
    try {
      aiResult = await this.ai.respond({
        source: 'private_session',
        mode: effectiveMode,
        developerNote: built.developerNote,
        userMessage: built.userMessage,
        imageUrls: imageUrls.length > 0 ? imageUrls : undefined,
        dispatchTool: (name, args, ctx) => this.tools.dispatch(name, args, ctx),
        toolContext: {
          conversationId,
          requesterUserId: msg.sender.id,
        },
        previousResponseId: sessionState?.lastResponseId ?? null,
        cacheKey: `marv:private:${conversationId}`,
      });
      this.logger.log(
        `[marv] private-reply AI call DONE in ${Date.now() - aiStartedAt}ms textLen=${(aiResult.text ?? '').length} model=${aiResult.modelUsed} resp=${aiResult.responseId} tools=${aiResult.toolCallCount} tokens=in${aiResult.inputTokens ?? 0}/out${aiResult.outputTokens ?? 0}/cached${aiResult.cachedInputTokens ?? 0} errorCode=${aiResult.errorCode ?? '-'}`,
      );
    } catch (err) {
      this.logger.error(
        `[marv] private-reply AI call THREW after ${Date.now() - aiStartedAt}ms: ${err instanceof Error ? err.message : String(err)}`,
        err instanceof Error ? err.stack : undefined,
      );
      stopTyping();
      const isNotConfigured = err instanceof MarvinAINotConfiguredError;
      const code = isNotConfigured ? MARV_ERROR_CODES.aiNotConfigured : MARV_ERROR_CODES.aiError;
      if (isNotConfigured) {
        try {
          await this.canned.sendNotConfiguredDm({
            userId: requestingUserId,
            conversationId,
          });
        } catch (postErr) {
          this.logger.error(
            `[marv] Failed to send not-configured DM (post-AI-error): ${postErr instanceof Error ? postErr.message : String(postErr)}`,
          );
        }
      } else {
        // Transient / upstream error — tell the user to try again rather than leaving
        // them with just a typing indicator that vanished.
        try {
          await this.canned.sendTransientErrorDm({ userId: requestingUserId });
        } catch (postErr) {
          this.logger.error(
            `[marv] Failed to send transient-error DM (post-AI-throw): ${postErr instanceof Error ? postErr.message : String(postErr)}`,
          );
        }
      }
      await this.usage.recordEvent({
        userId: requestingUserId,
        source: 'private_session',
        sourceId: conversationId,
        rootPostId: null,
        requestedMode,
        effectiveMode,
        creditsSpent: 0,
        modelUsed: this.ai.modelForMode(effectiveMode),
        routingReason: routed.reason,
        errorCode: code,
        latencyMs: Date.now() - startedAt,
      });
      return;
    }

    // AI finished thinking — briefly switch to "typing" so the client shows
    // the phase change, then stop just before the message lands.
    setTypingPhase('typing');
    await new Promise<void>((resolve) => setTimeout(resolve, 350));
    stopTyping();

    const replyText = (aiResult.text ?? '').trim();
    if (!replyText) {
      this.logger.warn(
        `[marv] private-reply EXIT reason=ai_no_text errorCode=${aiResult.errorCode ?? 'no_text'} resp=${aiResult.responseId} model=${aiResult.modelUsed} — sending transient-error DM`,
      );
      // Don't leave the user in silence. Let them know to try again.
      try {
        await this.canned.sendTransientErrorDm({ userId: requestingUserId });
      } catch (err) {
        this.logger.error(
          `[marv] Failed to send transient-error DM: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      await this.usage.recordEvent({
        userId: requestingUserId,
        source: 'private_session',
        sourceId: conversationId,
        rootPostId: null,
        requestedMode,
        effectiveMode,
        creditsSpent: 0,
        modelUsed: aiResult.modelUsed,
        routingReason: routed.reason,
        responseId: aiResult.responseId,
        inputTokens: aiResult.inputTokens,
        outputTokens: aiResult.outputTokens,
        cachedInputTokens: aiResult.cachedInputTokens,
        estimatedCostUsd: aiResult.estimatedCostUsd,
        errorCode: MARV_ERROR_CODES.aiNoText,
        latencyMs: Date.now() - startedAt,
      });
      return;
    }

    const marvId = await this.identity.getMarvUserId();
    if (!marvId) {
      this.logger.error('[marv] private-reply EXIT reason=bot_user_missing — cannot send DM.');
      try {
        await this.canned.sendTransientErrorDm({ userId: requestingUserId });
      } catch { /* best-effort */ }
      await this.usage.recordEvent({
        userId: requestingUserId,
        source: 'private_session',
        sourceId: conversationId,
        rootPostId: null,
        requestedMode,
        effectiveMode,
        creditsSpent: 0,
        modelUsed: aiResult.modelUsed,
        routingReason: routed.reason,
        responseId: aiResult.responseId,
        errorCode: MARV_ERROR_CODES.botUserMissing,
        latencyMs: Date.now() - startedAt,
      });
      return;
    }

    this.logger.log(
      `[marv] private-reply sending DM length=${replyText.length} to user=${requestingUserId}`,
    );
    try {
      const sendResult = await this.messages.sendBotDirectMessage({
        botUserId: marvId,
        recipientUserId: requestingUserId,
        body: replyText,
        media: [],
      });
      this.logger.log(
        `[marv] private-reply DM sent ok msg=${sendResult?.message?.id ?? '?'} convo=${sendResult?.conversationId ?? '?'}`,
      );
    } catch (err) {
      this.logger.error(
        `[marv] private-reply DM SEND FAILED: ${err instanceof Error ? err.message : String(err)}`,
        err instanceof Error ? err.stack : undefined,
      );
      try {
        await this.canned.sendTransientErrorDm({ userId: requestingUserId });
      } catch { /* best-effort */ }
      await this.usage.recordEvent({
        userId: requestingUserId,
        source: 'private_session',
        sourceId: conversationId,
        rootPostId: null,
        requestedMode,
        effectiveMode,
        creditsSpent: 0,
        modelUsed: aiResult.modelUsed,
        routingReason: routed.reason,
        responseId: aiResult.responseId,
        errorCode: MARV_ERROR_CODES.messageFailed,
        latencyMs: Date.now() - startedAt,
      });
      return;
    }

    // 9. Persist session memory + spend credits + record success.
    if (aiResult.responseId) {
      await this.prisma.marvinPrivateSessionState.upsert({
        where: { conversationId },
        update: { lastResponseId: aiResult.responseId, lastMessageId: messageId },
        create: { conversationId, lastResponseId: aiResult.responseId, lastMessageId: messageId },
      });
    }

    // Pass the pre-check refill summary so spend can skip its inner refill SELECT —
    // saves one Postgres round-trip on the hot path.
    const actualVisionCost = (aiResult.imagesAttached ?? 0) * creditCfg.visionCreditCostPerImage;
    const webSearchSurcharge = (aiResult.webSearchCount ?? 0) * creditCfg.webSearchCreditCost;
    const totalCost = cost + actualVisionCost + webSearchSurcharge;
    if (actualVisionCost > 0) {
      this.logger.log(
        `[marv] private-reply vision surcharge: ${aiResult.imagesAttached} image(s) × ${creditCfg.visionCreditCostPerImage} = ${actualVisionCost} extra credits`,
      );
    }
    if (webSearchSurcharge > 0) {
      this.logger.log(
        `[marv] private-reply web-search surcharge: ${aiResult.webSearchCount} search(es) × ${creditCfg.webSearchCreditCost} = ${webSearchSurcharge} extra credits (total=${totalCost})`,
      );
    }
    let postSpend: Awaited<ReturnType<typeof this.credits.spend>> | null = null;
    try {
      postSpend = await this.credits.spend(requestingUserId, totalCost, {
        recentSummary: { credits: summary.credits, lastRefilledAt: summary.lastRefilledAt },
      });
    } catch (err) {
      this.logger.warn(
        `[marv] credit spend failed after success (private): ${err instanceof Error ? err.message : String(err)}`,
      );
      if (!(err instanceof InsufficientMarvCreditsError)) throw err;
    }

    await this.usage.recordEvent({
      userId: requestingUserId,
      source: 'private_session',
      sourceId: conversationId,
      rootPostId: null,
      requestedMode,
      effectiveMode,
      creditsSpent: totalCost,
      modelUsed: aiResult.modelUsed,
      routingReason: routed.reason,
      responseId: aiResult.responseId,
      inputTokens: aiResult.inputTokens,
      outputTokens: aiResult.outputTokens,
      cachedInputTokens: aiResult.cachedInputTokens,
      estimatedCostUsd: aiResult.estimatedCostUsd,
      latencyMs: Date.now() - startedAt,
      postSpendSummary: postSpend,
    });

    this.logger.log(
      `[marv] private-reply ok user=${requestingUserId} convo=${conversationId} cost=${totalCost} (mode=${cost} + vision=${actualVisionCost} + webSearch=${webSearchSurcharge})`,
    );
  }

  private async tryClaimIdempotency(key: string): Promise<boolean> {
    try {
      await this.prisma.marvinIdempotencyKey.create({ data: { key } });
      return true;
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return false;
      throw err;
    }
  }
}
