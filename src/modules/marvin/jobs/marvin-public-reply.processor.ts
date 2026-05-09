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
import { MARV_ERROR_CODES, buildMarvIdempotencyKey } from '../marvin.constants';
import { JobsService } from '../../jobs/jobs.service';
import { JOBS } from '../../jobs/jobs.constants';
import { MarvinThreadSummaryService } from '../services/marvin-thread-summary.service';

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

    // 3. Load the post + author + premium-flag.
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

    // 6. Credit gate — must afford the routed cost.
    const cost = this.credits.costForMode(effectiveMode);
    const summary = await this.credits.refill(requestingUserId);
    this.logger.log(
      `[marv] public-reply gate-pass step=credits balance=${summary.credits} cost=${cost} ok=${summary.credits >= cost}`,
    );
    if (summary.credits < cost) {
      this.logger.log(
        `[marv] public-reply EXIT reason=no_credits balance=${summary.credits} cost=${cost}`,
      );
      await this.canned.sendOutOfCreditsDm({
        userId: requestingUserId,
        currentCredits: summary.credits,
        requiredCredits: cost,
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
    const [pastHourCount, pastDayCount, lastReplyAt] = await Promise.all([
      this.usage.countRecent({ userId: requestingUserId, source: 'public_thread', windowMinutes: 60 }),
      this.usage.countRecent({
        userId: requestingUserId,
        source: 'public_thread',
        windowMinutes: 24 * 60,
      }),
      this.usage.getLastReplyAtForRoot(rootPostId),
    ]);
    const overHourly = pastHourCount >= limits.publicMaxPerUserPerHour;
    const overDaily = pastDayCount >= limits.publicMaxPerUserPerDay;
    const cooldownActive =
      lastReplyAt && Date.now() - lastReplyAt.getTime() < limits.publicThreadCooldownSeconds * 1_000;
    if (overHourly || overDaily || cooldownActive) {
      const errorCode = overDaily
        ? MARV_ERROR_CODES.rateLimitDaily
        : overHourly
          ? MARV_ERROR_CODES.rateLimitHourly
          : MARV_ERROR_CODES.threadCooldown;
      this.logger.log(
        `[marv] public-reply EXIT reason=${errorCode} user=${requestingUserId} hour=${pastHourCount}/${limits.publicMaxPerUserPerHour} day=${pastDayCount}/${limits.publicMaxPerUserPerDay} cooldownActive=${!!cooldownActive}`,
      );
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
    const threadContext = await this.fetchThreadContext(rootPostId, post.id);

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
    });
    const aiStartedAt = Date.now();
    this.logger.log(
      `[marv] public-reply AI call START mode=${effectiveMode} model=${this.ai.modelForMode(effectiveMode)} userMsgLen=${built.userMessage.length}`,
    );

    let aiResult: Awaited<ReturnType<typeof this.ai.respond>> | null = null;
    try {
      aiResult = await this.ai.respond({
        source: 'public_thread',
        mode: effectiveMode,
        developerNote: built.developerNote,
        userMessage: built.userMessage,
        dispatchTool: (name, args, ctx) => this.tools.dispatch(name, args, ctx),
        toolContext: {
          rootPostId,
          triggeringPostId: post.id,
          requesterUserId: requesterRow.id,
        },
        cacheKey: `marv:public:${rootPostId}`,
      });
      this.logger.log(
        `[marv] public-reply AI call DONE in ${Date.now() - aiStartedAt}ms textLen=${(aiResult.text ?? '').length} model=${aiResult.modelUsed} resp=${aiResult.responseId} tools=${aiResult.toolCallCount} tokens=in${aiResult.inputTokens ?? 0}/out${aiResult.outputTokens ?? 0}/cached${aiResult.cachedInputTokens ?? 0} errorCode=${aiResult.errorCode ?? '-'}`,
      );
    } catch (err) {
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
    // If web search was used, add the per-search credit surcharge on top of the mode cost.
    const webSearchSurcharge = (aiResult.webSearchCount ?? 0) * this.appConfig.marvCredits().webSearchCreditCost;
    const totalCost = cost + webSearchSurcharge;
    if (webSearchSurcharge > 0) {
      this.logger.log(
        `[marv] public-reply web-search surcharge: ${aiResult.webSearchCount} search(es) × ${this.appConfig.marvCredits().webSearchCreditCost} = ${webSearchSurcharge} extra credits (total=${totalCost})`,
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
      `[marv] public-reply ok user=${requestingUserId} post=${postId} reply=${createdPostId} cost=${totalCost} (mode=${cost} + webSearch=${webSearchSurcharge})`,
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
   * Fetch the root post + recent replies for a thread and format them as MarvThreadPost[]
   * (oldest → newest). The triggering post is flagged so the model knows which message
   * addressed it. Capped at 20 posts to keep token cost reasonable.
   */
  private async fetchThreadContext(rootPostId: string, triggeringPostId: string): Promise<MarvThreadPost[]> {
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
          },
          orderBy: { createdAt: 'desc' },
          take: 19, // room for root as the 20th
        }),
      ]);
      if (!root) return [];
      const orderedReplies: typeof replies = replies.slice().reverse();
      const all: MarvThreadPost[] = [
        {
          id: root.id,
          authorUsername: root.user.username,
          authorDisplayName: root.user.name,
          body: (root.body ?? '').slice(0, 500),
          createdAt: root.createdAt.toISOString(),
          isTriggeringPost: root.id === triggeringPostId,
          isMarv: marvUserId !== null && root.userId === marvUserId,
          checkinPrompt: root.checkinPrompt,
        },
        ...orderedReplies.map((p) => ({
          id: p.id,
          authorUsername: p.user.username,
          authorDisplayName: p.user.name,
          body: (p.body ?? '').slice(0, 500),
          createdAt: p.createdAt.toISOString(),
          isTriggeringPost: p.id === triggeringPostId,
          isMarv: marvUserId !== null && p.userId === marvUserId,
          checkinPrompt: p.checkinPrompt,
        })),
      ];
      return all;
    } catch (err) {
      this.logger.warn(
        `[marv] fetchThreadContext failed for root=${rootPostId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
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
