import { Injectable, Logger } from '@nestjs/common';
import { Prisma, type MarvinMode } from '@prisma/client';
import type { ResolvedMarvinMode } from '../services/marvin-routing.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AppConfigService } from '../../app/app-config.service';
import { PostsService } from '../../posts/posts.service';
import { MarvinAIService, MarvinAINotConfiguredError } from '../services/marvin-ai.service';
import { MarvinBotIdentityService } from '../services/marvin-bot-identity.service';
import { MarvinCannedRepliesService } from '../services/marvin-canned-replies.service';
import { MarvinCreditService, InsufficientMarvCreditsError } from '../services/marvin-credit.service';
import { MarvinPromptBuilderService, type MarvThreadPost } from '../services/marvin-prompt-builder.service';
import { MarvinRoutingService } from '../services/marvin-routing.service';
import { MarvinToolHandlersService } from '../services/marvin-tool-handlers.service';
import { MarvinUsageService } from '../services/marvin-usage.service';
import { PresenceRealtimeService } from '../../presence/presence-realtime.service';
import { MARV_ERROR_CODES, buildMarvIdempotencyKey } from '../marvin.constants';
import { JobsService } from '../../jobs/jobs.service';
import { JOBS } from '../../jobs/jobs.constants';
import { MarvinThreadSummaryService } from '../services/marvin-thread-summary.service';
import {
  MarvinThreadContextService,
  type MarvThreadContextPost,
} from '../services/marvin-thread-context.service';
import { LinkMetadataService } from '../../link-metadata/link-metadata.service';
/**
 * How often to re-emit `posts:typing` while the AI call is in flight.
 * The web client expires the indicator after 7 000ms (`usePostTyping.TYPING_TTL_MS`),
 * so we heartbeat at half that to keep the indicator alive through long tool loops.
 */
const TYPING_HEARTBEAT_MS = 3000;

export type MarvinPublicReplyJobPayload = {
  postId: string;
  rootPostId: string;
  requestingUserId: string;
  /** Optional mode override (from `x-marv-mode` header on the post create call). */
  requestedMode?: MarvinMode | null;
  /** Snapshot of the original post body (used as Marv's question seed). */
  bodySnippet?: string;
  /** Visibility of the triggering post — informational; createPost mirrors parent visibility. */
  visibility?: string;
};

/**
 * BullMQ "marvin.reply.public" worker.
 *
 * Lifecycle (each step short-circuits on failure):
 *  1. Idempotency claim — table-row insert with unique key.
 *  2. Marv globally enabled? Disabled-for-user?
 *  3. Load the triggering post + author. Skip onlyMe.
 *  4. Premium gate — non-premium users get a one-shot canned reply per rootPostId.
 *  5. Pick a routed mode (Fast/Regular/Smart + sensitive-topic auto-upgrade).
 *  6. Credit gate — insufficient credits → out-of-credits DM (no AI call).
 *  7. Rate-limit gate — per-user/hour, per-user/day, per-thread cooldown.
 *  8. Build prompt → call MarvinAIService → post the reply via PostsService.createPost.
 *  9. Spend credits + record MarvinUsageEvent + emit `marv:credits-updated`.
 */
@Injectable()
export class MarvinPublicReplyProcessor {
  private readonly logger = new Logger(MarvinPublicReplyProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly appConfig: AppConfigService,
    private readonly identity: MarvinBotIdentityService,
    private readonly posts: PostsService,
    private readonly credits: MarvinCreditService,
    private readonly routing: MarvinRoutingService,
    private readonly promptBuilder: MarvinPromptBuilderService,
    private readonly ai: MarvinAIService,
    private readonly tools: MarvinToolHandlersService,
    private readonly usage: MarvinUsageService,
    private readonly canned: MarvinCannedRepliesService,
    private readonly jobs: JobsService,
    private readonly threadSummary: MarvinThreadSummaryService,
    private readonly threadContext: MarvinThreadContextService,
    private readonly linkMetadata: LinkMetadataService,
    private readonly presenceRealtime: PresenceRealtimeService,
  ) {}

  async process(payload: MarvinPublicReplyJobPayload): Promise<void> {
    const startedAt = Date.now();
    const { postId, rootPostId, requestingUserId } = payload;
    this.logger.log(
      `[marv] public-reply START post=${postId} root=${rootPostId} user=${requestingUserId} requestedMode=${payload.requestedMode ?? 'null'}`,
    );
    if (!postId || !requestingUserId) {
      this.logger.warn('[marv] public-reply payload missing required ids; skipping.');
      return;
    }

    // 1. Idempotency claim.
    const idempotencyKey = buildMarvIdempotencyKey({
      source: 'public_thread',
      sourceId: postId,
      userId: requestingUserId,
      messageId: postId,
    });
    const claimed = await this.tryClaimIdempotency(idempotencyKey);
    if (!claimed) {
      this.logger.log(`[marv] public-reply EXIT reason=duplicate_idempotency key=${idempotencyKey}`);
      return;
    }

    // Track whether the AI reply was delivered so the idempotency key is only released
    // on pre-delivery failures (allowing BullMQ retries), never after delivery (which
    // would risk a duplicate post on retry).
    let delivered = false;
    try {

    // 2. Marv globally enabled? Disabled for user?
    const cfg = this.appConfig.marvBot();
    if (!cfg.enabled) {
      this.logger.log('[marv] public-reply EXIT reason=marv_disabled');
      return;
    }
    const settings = await this.prisma.marvinUserSettings.findUnique({
      where: { userId: requestingUserId },
      select: { preferredMode: true, disabledByAdmin: true },
    });
    if (settings?.disabledByAdmin) {
      this.logger.log(`[marv] public-reply EXIT reason=disabled_by_admin user=${requestingUserId}`);
      await this.usage.recordEvent({
        userId: requestingUserId,
        source: 'public_thread',
        sourceId: postId,
        rootPostId,
        requestedMode: payload.requestedMode ?? settings.preferredMode ?? 'auto',
        effectiveMode: payload.requestedMode ?? settings.preferredMode ?? 'auto',
        creditsSpent: 0,
        errorCode: MARV_ERROR_CODES.disabledByAdmin,
        latencyMs: Date.now() - startedAt,
      });
      return;
    }

    // 3. Load the post + author + premium-flag + media + poll.
    const post = await this.prisma.post.findFirst({
      where: { id: postId, deletedAt: null },
      select: {
        id: true,
        body: true,
        visibility: true,
        rootId: true,
        userId: true,
        communityGroupId: true,
        user: {
          select: { id: true, username: true, name: true, premium: true, premiumPlus: true, bannedAt: true },
        },
        mentions: {
          select: { user: { select: { id: true, username: true } } },
        },
        media: {
          where: { kind: { not: 'video' } },
          select: { id: true, kind: true, source: true, r2Key: true, url: true, position: true },
          orderBy: { position: 'asc' },
        },
        poll: {
          select: {
            totalVoteCount: true,
            endsAt: true,
            options: {
              select: { text: true, voteCount: true },
              orderBy: { position: 'asc' },
            },
          },
        },
      },
    });
    if (!post) {
      this.logger.log(`[marv] public-reply EXIT reason=post_missing post=${postId}`);
      return;
    }
    if (post.user.bannedAt) {
      this.logger.log(`[marv] public-reply EXIT reason=user_banned user=${requestingUserId}`);
      await this.usage.recordEvent({
        userId: requestingUserId,
        source: 'public_thread',
        sourceId: postId,
        rootPostId,
        requestedMode: payload.requestedMode ?? settings?.preferredMode ?? 'auto',
        effectiveMode: payload.requestedMode ?? settings?.preferredMode ?? 'auto',
        creditsSpent: 0,
        errorCode: MARV_ERROR_CODES.userBanned,
        latencyMs: Date.now() - startedAt,
      });
      return;
    }
    if (post.visibility === 'onlyMe') {
      this.logger.log(`[marv] public-reply EXIT reason=only_me_visibility post=${postId}`);
      // Skip silently — record for admin observability.
      await this.usage.recordEvent({
        userId: requestingUserId,
        source: 'public_thread',
        sourceId: postId,
        rootPostId,
        requestedMode: payload.requestedMode ?? settings?.preferredMode ?? 'auto',
        effectiveMode: payload.requestedMode ?? settings?.preferredMode ?? 'auto',
        creditsSpent: 0,
        errorCode: MARV_ERROR_CODES.onlyMeVisibility,
        latencyMs: Date.now() - startedAt,
      });
      return;
    }

    // Group posts: Marv only replies when he is an active member (gate also runs at enqueue time).
    const postGroupId = (post.communityGroupId ?? '').trim() || null;
    if (postGroupId) {
      const marvId = this.identity.cachedMarvUserId() ?? (await this.identity.getMarvUserId());
      if (marvId) {
        const marvMembership = await this.prisma.communityGroupMember.findUnique({
          where: { groupId_userId: { groupId: postGroupId, userId: marvId } },
          select: { status: true },
        });
        if (marvMembership?.status !== 'active') {
          this.logger.log(
            `[marv] public-reply EXIT reason=marv_not_in_group post=${postId} groupId=${postGroupId}`,
          );
          return;
        }
      }
    }

    const requesterIsPremium = Boolean(post.user.premium || post.user.premiumPlus);
    // 'auto' (or null) means let the routing service decide from fast upward.
    const requestedMode = payload.requestedMode ?? settings?.preferredMode ?? 'auto';
    this.logger.log(
      `[marv] public-reply gate-pass step=load_post bodyLen=${(post.body ?? '').length} author=@${post.user.username ?? '?'} premium=${requesterIsPremium} visibility=${post.visibility}`,
    );

    // 4. Premium gate — non-premium → canned reply (once per rootPostId).
    if (!requesterIsPremium) {
      this.logger.log(`[marv] public-reply EXIT reason=not_premium user=${requestingUserId}`);
      await this.canned.sendNonPremiumThreadReply({
        requestingUserId,
        triggeringPostId: postId,
        rootPostId,
      });
      await this.usage.recordEvent({
        userId: requestingUserId,
        source: 'public_thread',
        sourceId: postId,
        rootPostId,
        requestedMode,
        effectiveMode: requestedMode,
        creditsSpent: 0,
        errorCode: MARV_ERROR_CODES.notPremium,
        latencyMs: Date.now() - startedAt,
      });
      return;
    }

    // 5. Routing decision (mode + crisis detection).
    const text = post.body ?? '';
    const routed = this.routing.resolve({
      requested: requestedMode,
      source: 'public_thread',
      estimatedInputTokens: this.routing.estimateTokens(text),
      text,
      webSearchEnabled: this.appConfig.marvOpenAI().webSearchEnabled,
    });
    const effectiveMode: ResolvedMarvinMode = routed.mode;
    this.logger.log(
      `[marv] public-reply gate-pass step=routing requested=${requestedMode} effective=${effectiveMode} reason=${routed.reason} crisis=${routed.crisisDetected} webSearchDemanded=${routed.webSearchDemanded}`,
    );

    // 6. Credit gate — must afford the routed cost + vision + worst-case one web search call.
    const cost = this.credits.costForMode(effectiveMode);
    const creditCfg = this.appConfig.marvCredits();
    const openAICfg = this.appConfig.marvOpenAI();
    const visionActive = openAICfg.visionEnabled && openAICfg.visionModes.includes(effectiveMode as string);
    // Count images on the triggering post for the upfront vision cost estimate.
    const triggeringPostImageCount = visionActive
      ? Math.min((post.media ?? []).length, openAICfg.visionMaxImagesPerTurn)
      : 0;
    const visionCost = triggeringPostImageCount * creditCfg.visionCreditCostPerImage;
    // Buffer for at most one web search so the spend call can't fail post-success on a 1-search reply.
    const webSearchBuffer = openAICfg.webSearchEnabled && openAICfg.webSearchModes.includes(effectiveMode as string)
      ? creditCfg.webSearchCreditCost
      : 0;
    const reservedCost = cost + visionCost + webSearchBuffer;
    const summary = await this.credits.refill(requestingUserId);
    this.logger.log(
      `[marv] public-reply gate-pass step=credits balance=${summary.credits} cost=${cost} vision=${visionCost} webSearchBuffer=${webSearchBuffer} reserved=${reservedCost} ok=${summary.credits >= reservedCost}`,
    );
    if (summary.credits < reservedCost) {
      this.logger.log(
        `[marv] public-reply EXIT reason=no_credits balance=${summary.credits} reserved=${reservedCost}`,
      );
      await this.canned.sendOutOfCreditsDm({
        userId: requestingUserId,
        currentCredits: summary.credits,
        requiredCredits: reservedCost,
        triggeringPostId: postId,
      });
      await this.usage.recordEvent({
        userId: requestingUserId,
        source: 'public_thread',
        sourceId: postId,
        rootPostId,
        requestedMode,
        effectiveMode: effectiveMode,
        creditsSpent: 0,
        modelUsed: this.ai.modelForMode(effectiveMode),
        routingReason: routed.reason,
        errorCode: MARV_ERROR_CODES.noCredits,
        latencyMs: Date.now() - startedAt,
      });
      return;
    }

    // 7. Rate-limit gate.
    const limits = this.appConfig.marvLimits();
    const [pastHourCount, pastDayCount, threadBurstCount] = await Promise.all([
      this.usage.countRecent({ userId: requestingUserId, source: 'public_thread', windowMinutes: 60 }),
      this.usage.countRecent({
        userId: requestingUserId,
        source: 'public_thread',
        windowMinutes: 24 * 60,
      }),
      this.usage.countRecentRepliesForRootAndUser({
        rootPostId,
        userId: requestingUserId,
        windowSeconds: limits.publicThreadBurstWindowSeconds,
      }),
    ]);
    const overHourly = pastHourCount >= limits.publicMaxPerUserPerHour;
    const overDaily = pastDayCount >= limits.publicMaxPerUserPerDay;
    // Burst limiter: allow up to `publicThreadBurstLimit` Marv replies to the same
    // (thread, user) within the sliding window before kicking the cooldown DM. The
    // count reflects successful replies already issued; once it hits the limit, the
    // *next* mention is blocked.
    const threadBurstHit = threadBurstCount >= limits.publicThreadBurstLimit;
    if (overHourly || overDaily || threadBurstHit) {
      const errorCode = overDaily
        ? MARV_ERROR_CODES.rateLimitDaily
        : overHourly
          ? MARV_ERROR_CODES.rateLimitHourly
          : MARV_ERROR_CODES.threadCooldown;
      this.logger.log(
        `[marv] public-reply EXIT reason=${errorCode} user=${requestingUserId} hour=${pastHourCount}/${limits.publicMaxPerUserPerHour} day=${pastDayCount}/${limits.publicMaxPerUserPerDay} threadBurst=${threadBurstCount}/${limits.publicThreadBurstLimit}`,
      );
      // Notify the user via DM so they know why Marv didn't reply in the thread.
      // No extra dedup needed — the BullMQ job is idempotent per postId, so this
      // method is called at most once per triggering post.
      await this.canned.sendRateLimitedDm({
        userId: requestingUserId,
        kind: overDaily ? 'daily' : threadBurstHit ? 'thread_cooldown' : 'per10min',
        triggeringPostId: postId,
      });
      await this.usage.recordEvent({
        userId: requestingUserId,
        source: 'public_thread',
        sourceId: postId,
        rootPostId,
        requestedMode,
        effectiveMode: effectiveMode,
        creditsSpent: 0,
        modelUsed: this.ai.modelForMode(effectiveMode),
        routingReason: routed.reason,
        errorCode,
        latencyMs: Date.now() - startedAt,
      });
      return;
    }

    this.logger.log(`[marv] public-reply gate-pass step=rate_limit hour=${pastHourCount} day=${pastDayCount}`);

    // 8. Build prompt + call AI.
    if (!this.ai.isConfigured()) {
      // Premium user, but the agent literally can't reply (missing OPENAI_API_KEY etc.).
      // Post a one-shot canned reply per (user, rootPostId) so they know to contact an
      // admin instead of thinking Marv is ignoring them.
      this.logger.warn(
        '[marv] public-reply EXIT reason=ai_not_configured (missing OPENAI_API_KEY or OPENAI_MARV_PROMPT_ID); posting canned thread reply.',
      );
      try {
        await this.canned.sendNotConfiguredThreadReply({
          requestingUserId,
          triggeringPostId: postId,
          rootPostId,
        });
      } catch (err) {
        this.logger.error(
          `[marv] Failed to send not-configured thread reply: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      await this.usage.recordEvent({
        userId: requestingUserId,
        source: 'public_thread',
        sourceId: postId,
        rootPostId,
        requestedMode,
        effectiveMode: effectiveMode,
        creditsSpent: 0,
        modelUsed: this.ai.modelForMode(effectiveMode),
        routingReason: routed.reason,
        errorCode: MARV_ERROR_CODES.aiNotConfigured,
        latencyMs: Date.now() - startedAt,
      });
      return;
    }

    const referenced = post.mentions
      .map((m) => m.user.username ?? '')
      .filter((u) => u && u.toLowerCase() !== this.identity.marvUsernameLower());
    const requesterRow = post.user;

    // Pre-fetch BIDIRECTIONAL thread context (ancestors above + replies below the
    // triggering post) so the model reasons about the whole conversation — not just a
    // flat recent-replies list. The rolling summary covers older posts beyond the window.
    const { ancestors, triggeringPost, descendants, imageUrls, hasGifAttached } =
      await this.fetchBidirectionalContext(post.id, openAICfg);
    const rollingSummary = await this.threadSummary.getSummaryText(rootPostId).catch(() => null);

    // Collect link previews from triggering post + last 3 replies below it (read-only, no fetch).
    const recentBodies = [
      post.body ?? '',
      ...descendants.slice(-3).map((p) => p.body),
    ].join('\n');
    const linkPreviews = await this.linkMetadata.previewLinks(recentBodies);

    const built = this.promptBuilder.build({
      source: 'public_thread',
      requester: {
        userId: requesterRow.id,
        username: requesterRow.username,
        displayName: requesterRow.name,
      },
      currentQuestion: post.body ?? '',
      triggeringPostId: post.id,
      rootPostId,
      ancestors,
      triggeringPost,
      descendants,
      rollingSummary,
      referencedUsernames: [...new Set(referenced)],
      crisisDetected: routed.crisisDetected,
      webSearchDemanded: routed.webSearchDemanded,
      linkPreviews: linkPreviews.length > 0 ? linkPreviews : undefined,
      hasGifAttached: hasGifAttached || undefined,
    });
    const aiStartedAt = Date.now();
    this.logger.log(
      `[marv] public-reply AI call START mode=${effectiveMode} model=${this.ai.modelForMode(effectiveMode)} userMsgLen=${built.userMessage.length}`,
    );

    // Show "@marv is replying…" on the triggering post while the AI call runs.
    const marvUserIdForTyping = this.identity.cachedMarvUserId() ?? (await this.identity.getMarvUserId());
    const { stop: stopTyping } = marvUserIdForTyping
      ? this.startTypingHeartbeat({ postId, marvUserId: marvUserIdForTyping })
      : { stop: () => {} };

    let aiResult: Awaited<ReturnType<MarvinAIService['respond']>> | null = null;
    try {
      aiResult = await this.ai.respond({
        source: 'public_thread',
        mode: effectiveMode,
        developerNote: built.developerNote,
        userMessage: built.userMessage,
        imageUrls: imageUrls.length > 0 ? imageUrls : undefined,
        dispatchTool: (name, args, ctx) => this.tools.dispatch(name, args, ctx),
        toolContext: {
          rootPostId,
          triggeringPostId: post.id,
          requesterUserId: requesterRow.id,
          requesterUsername: requesterRow.username,
        },
        cacheKey: `marv:public:${rootPostId}`,
      });
      this.logger.log(
        `[marv] public-reply AI call DONE in ${Date.now() - aiStartedAt}ms textLen=${(aiResult.text ?? '').length} model=${aiResult.modelUsed} resp=${aiResult.responseId} tools=${aiResult.toolCallCount} tokens=in${aiResult.inputTokens ?? 0}/out${aiResult.outputTokens ?? 0}/cached${aiResult.cachedInputTokens ?? 0} errorCode=${aiResult.errorCode ?? '-'}`,
      );
    } catch (err) {
      stopTyping();
      const isNotConfigured = err instanceof MarvinAINotConfiguredError;
      const code = isNotConfigured ? MARV_ERROR_CODES.aiNotConfigured : MARV_ERROR_CODES.aiError;
      this.logger.error(
        `[marv] public-reply AI call THREW after ${Date.now() - aiStartedAt}ms: ${err instanceof Error ? err.message : String(err)}`,
        err instanceof Error ? err.stack : undefined,
      );
      // If the failure was specifically "AI not configured", surface it to the user
      // as the canned thread reply (idempotent per (user, rootPostId, ai_not_configured)).
      // Other AI errors stay observability-only — they could be transient, and we don't
      // want to spam the thread on a flaky upstream.
      if (isNotConfigured) {
        try {
          await this.canned.sendNotConfiguredThreadReply({
            requestingUserId,
            triggeringPostId: postId,
            rootPostId,
          });
        } catch (postErr) {
          this.logger.error(
            `[marv] Failed to send not-configured thread reply (post-AI-error): ${postErr instanceof Error ? postErr.message : String(postErr)}`,
          );
        }
      }
      await this.usage.recordEvent({
        userId: requestingUserId,
        source: 'public_thread',
        sourceId: postId,
        rootPostId,
        requestedMode,
        effectiveMode: effectiveMode,
        creditsSpent: 0,
        modelUsed: this.ai.modelForMode(effectiveMode),
        routingReason: routed.reason,
        errorCode: code,
        latencyMs: Date.now() - startedAt,
      });
      return;
    }

    const replyText = (aiResult.text ?? '').trim();
    if (!replyText) {
      stopTyping();
      this.logger.warn(
        `[marv] public-reply EXIT reason=ai_no_text errorCode=${aiResult.errorCode ?? 'no_text'} resp=${aiResult.responseId} model=${aiResult.modelUsed} — posting transient-error thread reply`,
      );
      // Post a visible "try again" reply so the user isn't left in silence.
      // Deduplicated once per (user, rootPostId) — they see at most one error notice per thread.
      try {
        await this.canned.sendTransientErrorThreadReply({
          requestingUserId,
          triggeringPostId: postId,
          rootPostId,
        });
      } catch (err) {
        this.logger.error(
          `[marv] Failed to send transient-error thread reply: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      await this.usage.recordEvent({
        userId: requestingUserId,
        source: 'public_thread',
        sourceId: postId,
        rootPostId,
        requestedMode,
        effectiveMode: effectiveMode,
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

    // 9. Compute actual credit cost now that the AI turn is complete, then charge
    // before delivering. Charging first ensures we never give away a free reply.
    const actualVisionCost = (aiResult.imagesAttached ?? 0) * creditCfg.visionCreditCostPerImage;
    const webSearchSurcharge = (aiResult.webSearchCount ?? 0) * creditCfg.webSearchCreditCost;
    const urlFetchSurcharge = (aiResult.urlFetchCount ?? 0) * creditCfg.urlFetchCreditCost;
    const totalCost = cost + actualVisionCost + webSearchSurcharge + urlFetchSurcharge;
    if (actualVisionCost > 0) {
      this.logger.log(
        `[marv] public-reply vision surcharge: ${aiResult.imagesAttached} image(s) × ${creditCfg.visionCreditCostPerImage} = ${actualVisionCost} extra credits`,
      );
    }
    if (webSearchSurcharge > 0) {
      this.logger.log(
        `[marv] public-reply web-search surcharge: ${aiResult.webSearchCount} search(es) × ${creditCfg.webSearchCreditCost} = ${webSearchSurcharge} extra credits (total=${totalCost})`,
      );
    }
    if (urlFetchSurcharge > 0) {
      this.logger.log(
        `[marv] public-reply url-fetch surcharge: ${aiResult.urlFetchCount} fetch(es) × ${creditCfg.urlFetchCreditCost} = ${urlFetchSurcharge} extra credits (total=${totalCost})`,
      );
    }

    let postSpend: Awaited<ReturnType<MarvinCreditService['spend']>> | null = null;
    try {
      postSpend = await this.credits.spend(requestingUserId, totalCost, {
        recentSummary: { credits: summary.credits, lastRefilledAt: summary.lastRefilledAt },
      });
    } catch (err) {
      stopTyping();
      if (err instanceof InsufficientMarvCreditsError) {
        this.logger.warn(
          `[marv] public-reply EXIT reason=no_credits_at_spend balance=${err.currentCredits} needed=${totalCost}`,
        );
        await this.usage.recordEvent({
          userId: requestingUserId,
          source: 'public_thread',
          sourceId: postId,
          rootPostId,
          requestedMode,
          effectiveMode,
          creditsSpent: 0,
          modelUsed: aiResult.modelUsed,
          routingReason: routed.reason,
          responseId: aiResult.responseId,
          errorCode: MARV_ERROR_CODES.noCredits,
          latencyMs: Date.now() - startedAt,
        });
        return;
      }
      // Unexpected spend error — rethrow so the outer catch can release the
      // idempotency key (delivered is still false) and let BullMQ retry.
      throw err;
    }

    // Post the reply as Marv. createPost will mirror parent visibility automatically.
    const marvId = await this.identity.getMarvUserId();
    if (!marvId) {
      stopTyping();
      this.logger.error('[marv] Cannot post AI reply — Marv user not resolved.');
      // Credits already spent; record the failure honestly. Mark as delivered to
      // prevent key deletion — we do not want a double-charge on a BullMQ retry.
      delivered = true;
      await this.usage.recordEvent({
        userId: requestingUserId,
        source: 'public_thread',
        sourceId: postId,
        rootPostId,
        requestedMode,
        effectiveMode,
        creditsSpent: totalCost,
        modelUsed: aiResult.modelUsed,
        routingReason: routed.reason,
        responseId: aiResult.responseId,
        errorCode: MARV_ERROR_CODES.botUserMissing,
        postSpendSummary: postSpend,
        latencyMs: Date.now() - startedAt,
      }).catch(() => undefined);
      return;
    }

    // Brief pause so the indicator is still visible right before the post lands.
    await new Promise<void>((resolve) => setTimeout(resolve, 350));
    stopTyping();

    this.logger.log(
      `[marv] public-reply posting reply parent=${postId} length=${replyText.length}`,
    );
    let createdPostId: string | null = null;
    try {
      const created = await this.posts.createPost({
        userId: marvId,
        body: replyText,
        // Visibility is overridden by createPost to mirror parent's visibility.
        visibility: 'public',
        parentId: postId,
        media: [],
        poll: null,
      });
      createdPostId = created.post?.id ?? null;
      this.logger.log(`[marv] public-reply post CREATED id=${createdPostId} parent=${postId}`);
    } catch (err) {
      this.logger.error(
        `[marv] public-reply POST CREATE FAILED parent=${postId}: ${err instanceof Error ? err.message : String(err)}`,
        err instanceof Error ? err.stack : undefined,
      );
      // Credits already spent but delivery failed. Mark as delivered to prevent key
      // deletion — we don't want a BullMQ retry that charges a second time for a post
      // that will never land.
      delivered = true;
      await this.usage.recordEvent({
        userId: requestingUserId,
        source: 'public_thread',
        sourceId: postId,
        rootPostId,
        requestedMode,
        effectiveMode,
        creditsSpent: totalCost,
        modelUsed: aiResult.modelUsed,
        routingReason: routed.reason,
        responseId: aiResult.responseId,
        errorCode: MARV_ERROR_CODES.postFailed,
        postSpendSummary: postSpend,
        latencyMs: Date.now() - startedAt,
      }).catch(() => undefined);
      return;
    }

    // Delivery successful.
    delivered = true;

    // Post-delivery steps are best-effort — must not propagate and block the job.
    try {
      await this.usage.recordEvent({
        userId: requestingUserId,
        source: 'public_thread',
        sourceId: postId,
        rootPostId,
        requestedMode,
        effectiveMode: effectiveMode,
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
    } catch (e) {
      this.logger.warn(`[marv] public-reply usage.recordEvent failed: ${String(e)}`);
    }

    this.logger.log(
      `[marv] public-reply ok user=${requestingUserId} post=${postId} reply=${createdPostId} cost=${totalCost} (mode=${cost} + vision=${actualVisionCost} + webSearch=${webSearchSurcharge} + urlFetch=${urlFetchSurcharge})`,
    );

    // Fire-and-forget: keep the thread summary fresh for future Marv replies.
    // Skipped silently if the trigger threshold isn't met or the queue is offline.
    try {
      const should = await this.threadSummary.shouldSummarize(rootPostId);
      if (should) {
        await this.jobs.enqueue(JOBS.marvinSummarizeThread, { rootPostId });
      }
    } catch (err) {
      this.logger.warn(
        `[marv] failed to enqueue summarize-thread for root=${rootPostId}: ${(err as Error).message}`,
      );
    }

    } catch (err) {
      // Unexpected error before delivery — release the idempotency key so BullMQ can retry.
      if (!delivered) {
        await this.prisma.marvinIdempotencyKey
          .delete({ where: { key: idempotencyKey } })
          .catch((e: unknown) => this.logger.warn(`[marv] public-reply failed to release idempotency key: ${String(e)}`));
      }
      throw err;
    }
  }

  /**
   * Show "@marv is replying…" to post-room subscribers for the duration of the
   * AI call. Returns `stop()`. Always call it in a `finally` block so the
   * indicator never gets stuck.
   */
  private startTypingHeartbeat(args: {
    postId: string;
    marvUserId: string;
  }): { stop: () => void } {
    const { postId, marvUserId } = args;
    if (!postId || !marvUserId) return { stop: () => {} };

    const marvUsername = this.appConfig.marvBot().username;
    let stopped = false;

    const emit = (typing: boolean): void => {
      try {
        this.presenceRealtime.emitPostsTyping(postId, {
          postId,
          user: {
            id: marvUserId,
            username: marvUsername,
            verifiedStatus: 'manual',
            premium: true,
            premiumPlus: false,
            isOrganization: false,
          },
          typing,
          status: typing ? 'replying' : undefined,
        });
      } catch {
        // best-effort: typing indicator is non-essential UX
      }
    };

    emit(true);
    const interval = setInterval(() => {
      if (!stopped) emit(true);
    }, TYPING_HEARTBEAT_MS);

    return {
      stop: () => {
        if (stopped) return;
        stopped = true;
        clearInterval(interval);
        emit(false);
      },
    };
  }

  /**
   * Collect the bidirectional conversation around the triggering post (ancestors above +
   * reply subtree below) via {@link MarvinThreadContextService}, map it into the prompt
   * builder's {@link MarvThreadPost} shape, and apply the first-then-tail image selection
   * rule across all collected posts.
   *
   * Returns:
   *  - `ancestors`: posts above the triggering post (root-most → parent).
   *  - `triggeringPost`: the post that mentioned Marv (undefined if it couldn't be loaded).
   *  - `descendants`: replies below the triggering post (reading order).
   *  - `imageUrls`: up to `visionMaxImagesPerTurn` image/GIF URLs (first, then tail), or [].
   *  - `hasGifAttached`: true when at least one selected URL came from a GIF.
   */
  private async fetchBidirectionalContext(
    triggeringPostId: string,
    openAICfg: ReturnType<AppConfigService['marvOpenAI']>,
  ): Promise<{
    ancestors: MarvThreadPost[];
    triggeringPost: MarvThreadPost | undefined;
    descendants: MarvThreadPost[];
    imageUrls: string[];
    hasGifAttached: boolean;
  }> {
    const emptyResult = {
      ancestors: [] as MarvThreadPost[],
      triggeringPost: undefined as MarvThreadPost | undefined,
      descendants: [] as MarvThreadPost[],
      imageUrls: [] as string[],
      hasGifAttached: false,
    };
    try {
      const context = await this.threadContext.collect({ focalPostId: triggeringPostId });

      const toThreadPost = (p: MarvThreadContextPost): MarvThreadPost => ({
        id: p.id,
        authorUsername: p.authorUsername,
        authorDisplayName: p.authorDisplayName,
        body: p.body,
        createdAt: p.createdAt.toISOString(),
        isMarv: p.isMarv,
        checkinPrompt: p.checkinPrompt,
        poll: p.poll ?? null,
      });

      const ancestors = context.ancestors.map(toThreadPost);
      const triggeringPost = context.focal ? toThreadPost(context.focal) : undefined;
      const descendants = context.descendants.map(toThreadPost);

      // Image selection across the whole collected conversation (shared with "Catch me up").
      const { imageUrls, hasGifAttached } = this.threadContext.selectImageMedia(context, {
        visionEnabled: openAICfg.visionEnabled,
        visionMaxImagesPerTurn: openAICfg.visionMaxImagesPerTurn,
        publicBaseUrl: this.appConfig.r2()?.publicBaseUrl ?? null,
      });

      return { ancestors, triggeringPost, descendants, imageUrls, hasGifAttached };
    } catch (err) {
      this.logger.warn(
        `[marv] fetchBidirectionalContext failed for focal=${triggeringPostId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return emptyResult;
    }
  }

  /**
   * Insert the idempotency key inside its own transaction; a `P2002` unique violation means
   * another worker already claimed this job.
   */
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
