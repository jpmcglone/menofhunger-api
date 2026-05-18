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
import { LinkMetadataService } from '../../link-metadata/link-metadata.service';
import { publicAssetUrl } from '../../../common/assets/public-asset-url';

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

    // Pre-fetch thread context so the model always sees the full conversation without
    // needing a tool call. Mirrors the get_post_thread_recent_messages tool query.
    const { threadContext, imageUrls, hasGifAttached } = await this.fetchThreadContext(rootPostId, post.id, openAICfg);

    // Collect link previews from triggering post + last 3 thread posts (read-only, no fetch).
    const recentBodies = [
      post.body ?? '',
      ...threadContext.slice(-3).map((p) => p.body),
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
      threadContext,
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

    let aiResult: Awaited<ReturnType<typeof this.ai.respond>> | null = null;
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

    // Post the reply as Marv. createPost will mirror parent visibility automatically.
    const marvId = await this.identity.getMarvUserId();
    if (!marvId) {
      stopTyping();
      this.logger.error('[marv] Cannot post AI reply — Marv user not resolved.');
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
        errorCode: MARV_ERROR_CODES.botUserMissing,
        latencyMs: Date.now() - startedAt,
      });
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
        errorCode: MARV_ERROR_CODES.postFailed,
        latencyMs: Date.now() - startedAt,
      });
      return;
    }

    // 9. Spend credits + record success. Pass the pre-check refill summary so spend
    // can skip its own inner refill SELECT — saves one Postgres round-trip on the
    // hot path (the pre-check ran milliseconds ago).
    // Actual vision cost from images the AI service confirmed were sent.
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
    let postSpend: Awaited<ReturnType<typeof this.credits.spend>> | null = null;
    try {
      postSpend = await this.credits.spend(requestingUserId, totalCost, {
        recentSummary: { credits: summary.credits, lastRefilledAt: summary.lastRefilledAt },
      });
    } catch (err) {
      // Should never happen — we just refilled and checked credits — but log + continue.
      this.logger.warn(
        `[marv] credit spend failed after success: ${err instanceof Error ? err.message : String(err)}`,
      );
      if (!(err instanceof InsufficientMarvCreditsError)) throw err;
    }

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
   * Fetch the root post + recent replies for a thread, format as MarvThreadPost[]
   * (oldest → newest), and apply the first-then-tail image selection rule.
   *
   * Returns:
   *  - `threadContext`: post rows with poll + body for the developer note.
   *  - `imageUrls`: up to `visionMaxImagesPerTurn` image/GIF URLs selected from
   *    the thread (first chronologically, then tail), or [] when vision is off.
   *  - `hasGifAttached`: true when at least one selected URL came from a GIF.
   */
  private async fetchThreadContext(
    rootPostId: string,
    triggeringPostId: string,
    openAICfg: ReturnType<AppConfigService['marvOpenAI']>,
  ): Promise<{ threadContext: MarvThreadPost[]; imageUrls: string[]; hasGifAttached: boolean }> {
    const mediaSelect = {
      where: { kind: { not: 'video' as const } },
      select: { id: true, kind: true, source: true, r2Key: true, url: true, position: true },
      orderBy: { position: 'asc' as const },
    };
    const pollSelect = {
      select: {
        totalVoteCount: true,
        endsAt: true,
        options: {
          select: { text: true, voteCount: true },
          orderBy: { position: 'asc' as const },
        },
      },
    };
    try {
      const marvUserId = await this.identity.getMarvUserId();
      const [root, replies] = await Promise.all([
        this.prisma.post.findFirst({
          where: { id: rootPostId, deletedAt: null, visibility: { not: 'onlyMe' } },
          select: {
            id: true,
            body: true,
            createdAt: true,
            checkinPrompt: true,
            userId: true,
            user: { select: { username: true, name: true } },
            media: mediaSelect,
            poll: pollSelect,
          },
        }),
        this.prisma.post.findMany({
          where: { rootId: rootPostId, deletedAt: null, visibility: { not: 'onlyMe' } },
          select: {
            id: true,
            body: true,
            createdAt: true,
            checkinPrompt: true,
            userId: true,
            user: { select: { username: true, name: true } },
            media: mediaSelect,
            poll: pollSelect,
          },
          orderBy: { createdAt: 'desc' },
          take: 19, // room for root as the 20th
        }),
      ]);
      if (!root) return { threadContext: [], imageUrls: [], hasGifAttached: false };
      const orderedReplies: typeof replies = replies.slice().reverse();
      const allPosts = [root, ...orderedReplies];
      const publicBase = this.appConfig.r2()?.publicBaseUrl ?? null;

      // Build MarvThreadPost array (used for developer note).
      const threadContext: MarvThreadPost[] = allPosts.map((p) => ({
        id: p.id,
        authorUsername: p.user.username,
        authorDisplayName: p.user.name,
        body: (p.body ?? '').slice(0, 500),
        createdAt: p.createdAt.toISOString(),
        isTriggeringPost: p.id === triggeringPostId,
        isMarv: marvUserId !== null && p.userId === marvUserId,
        checkinPrompt: p.checkinPrompt,
        poll: p.poll ?? null,
      }));

      // Build image URL list using first-then-tail rule.
      if (!openAICfg.visionEnabled) return { threadContext, imageUrls: [], hasGifAttached: false };

      type MediaEntry = { resolvedUrl: string; kind: string };
      const allEntries: MediaEntry[] = [];
      for (const p of allPosts) {
        for (const m of p.media ?? []) {
          const resolved =
            m.source === 'upload' && m.r2Key
              ? publicAssetUrl({ publicBaseUrl: publicBase, key: m.r2Key })
              : (m.url ?? null);
          if (resolved) allEntries.push({ resolvedUrl: resolved, kind: m.kind });
        }
      }

      const maxImages = openAICfg.visionMaxImagesPerTurn;
      const selected: MediaEntry[] = [];
      if (allEntries.length > 0) {
        selected.push(allEntries[0]); // first chronologically
        for (let j = allEntries.length - 1; j >= 1 && selected.length < maxImages; j--) {
          if (allEntries[j].resolvedUrl !== allEntries[0].resolvedUrl) {
            selected.push(allEntries[j]);
          }
        }
      }

      return {
        threadContext,
        imageUrls: selected.map((e) => e.resolvedUrl),
        hasGifAttached: selected.some((e) => e.kind === 'gif'),
      };
    } catch (err) {
      this.logger.warn(
        `[marv] fetchThreadContext failed for root=${rootPostId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { threadContext: [], imageUrls: [], hasGifAttached: false };
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
