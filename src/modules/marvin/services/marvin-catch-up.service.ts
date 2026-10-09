import { Inject } from '@nestjs/common';
import { PostsFeedLookupService } from '../../posts/posts-feed-lookup.service';
import { requireAiConsent } from './ai-consent';
import { ForbiddenException, HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import type { MarvinMode } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AppConfigService } from '../../app/app-config.service';
import { CacheService } from '../../redis/cache.service';

import { LinkMetadataService } from '../../link-metadata/link-metadata.service';
import type { MarvinCatchUpDto } from '../../../common/dto/marvin';
import { MarvinAIService } from './marvin-ai.service';
import { MarvinCreditService, InsufficientMarvCreditsError } from './marvin-credit.service';
import { MarvinRoutingService, type ResolvedMarvinMode } from './marvin-routing.service';
import { MarvinUsageService } from './marvin-usage.service';
import { MarvinThreadSummaryService } from './marvin-thread-summary.service';
import { MarvinToolHandlersService } from './marvin-tool-handlers.service';
import { MarvinThreadContextService, type MarvThreadContext } from './marvin-thread-context.service';
import { MARV_ERROR_CODES } from '../marvin.constants';
import { fillVisionSlots } from './marvin-vision-media';
import { buildCatchUpPrompt } from './marvin-catch-up-prompt';
import { MarvinCatchUpCacheService, freshnessMarker, freshnessMarkerToken } from './marvin-catch-up-cache.service';

/**
 * "Catch me up" — a synchronous, premium, credit-spending request that summarizes the
 * conversation around a focal post (the full public thread, siblings included).
 *
 * Mirrors the credit/routing/usage discipline of the reply processors, but returns the
 * summary in the HTTP envelope instead of posting it. Results are cached per (post, mode,
 * images) and shared across viewers, so a second viewer — or the same viewer re-opening the
 * modal — pays nothing. Invalidation is SOFT: when the thread has moved on, the previous
 * summary is still served free and flagged `stale` with a `newReplies` count, so the client
 * can offer an informed "Update" instead of a dead end.
 */
@Injectable()
export class MarvinCatchUpService {
  private readonly logger = new Logger(MarvinCatchUpService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly appConfig: AppConfigService,
    private readonly cache: CacheService,
    @Inject(PostsFeedLookupService) private readonly postsLookup: Pick<PostsFeedLookupService, 'getById'>,
    private readonly context: MarvinThreadContextService,
    private readonly routing: MarvinRoutingService,
    private readonly ai: MarvinAIService,
    private readonly credits: MarvinCreditService,
    private readonly usage: MarvinUsageService,
    private readonly threadSummary: MarvinThreadSummaryService,
    private readonly tools: MarvinToolHandlersService,
    private readonly linkMetadata: LinkMetadataService,
    private readonly cacheStore: MarvinCatchUpCacheService,
  ) {}

  async peekCached(params: { userId: string; postId: string; requestedMode?: MarvinMode | null; includeImages?: boolean }): Promise<MarvinCatchUpDto | null> {
    return this.cacheStore.peekCached(params);
  }

  async catchUp(params: {
    userId: string;
    postId: string;
    /** Explicit mode from the request; null/undefined falls back to the user's preferred mode. */
    requestedMode?: MarvinMode | null;
    /** When true, skip the cache read and regenerate a fresh summary (still spends credits). */
    forceRefresh?: boolean;
    /** When false, skip vision entirely: no images attached, no vision surcharge. Default true. */
    includeImages?: boolean;
  }): Promise<MarvinCatchUpDto> {
    const startedAt = Date.now();
    const { userId, postId } = params;
    const includeImages = params.includeImages !== false;

    // 1. Marv enabled (globally + for this user)?
    const cfg = this.appConfig.marvBot();
    const [viewer, settings] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: userId }, select: { premium: true, premiumPlus: true } }),
      this.prisma.marvinUserSettings.findUnique({
        where: { userId },
        select: { disabledByAdmin: true, preferredMode: true },
      }),
    ]);
    if (!cfg.enabled || settings?.disabledByAdmin) {
      throw new ForbiddenException({ message: 'Marv is currently unavailable.', error: MARV_ERROR_CODES.disabled });
    }

    // Resolve the requested tier: explicit > user preference > auto.
    const requestedMode: MarvinMode = params.requestedMode ?? settings?.preferredMode ?? 'auto';

    // 2. Premium gate.
    const isPremium = Boolean(viewer?.premium || viewer?.premiumPlus);
    if (!isPremium) {
      throw new ForbiddenException({
        message: 'Catch me up is a premium feature.',
        error: MARV_ERROR_CODES.notPremium,
      });
    }

    await requireAiConsent(this.prisma, userId);

    // 3. Visibility gate — resolve through PostsFeedLookupService so gated/onlyMe content never leaks.
    //    Throws ForbiddenException/NotFoundException, which the global filter surfaces verbatim.
    const post = await this.postsLookup.getById({ viewerUserId: userId, id: postId });
    const rootPostId = (post as { rootId?: string | null }).rootId ?? post.id;

    // 4. Collect bidirectional context + rolling summary + link previews in parallel.
    const [context, rollingSummary] = await Promise.all([
      this.context.collect({ focalPostId: postId }),
      this.threadSummary.getSummaryText(rootPostId).catch(() => null),
    ]);

    const previewBodies = [context.focal, ...context.descendants]
      .filter((p): p is NonNullable<typeof p> => Boolean(p))
      .map((p) => [p.body, ...(p.urls ?? [])].join('\n'))
      .filter(Boolean)
      .join('\n');
    const linkPreviews = await this.linkMetadata.previewLinks(previewBodies).catch(() => []);

    // 5. Cache check — keyed by the REQUESTED mode (so Auto/Fast/Regular/Smart cache
    //    separately and switching the picker never returns a summary from another tier) and
    //    by the images opt-in. The freshness marker is compared against the STORED marker
    //    rather than being part of the key, so a moved-on thread still finds its previous
    //    summary and serves it as `stale`.
    //    A forced refresh (the "Regenerate"/"Update" button) skips the read and recomputes.
    const marker = freshnessMarker(context);
    const imgToken = includeImages ? 'img' : 'noimg';
    const cacheKey = `marv:catchup:${postId}:${requestedMode}:${imgToken}`;
    // One read serves two purposes: a servable entry short-circuits the request, and an entry
    // we won't serve (too stale, or a forced update) still seeds the delta below.
    const previous = await this.cacheStore.readCachedEnvelope(cacheKey);
    if (!params.forceRefresh && previous) {
      const hit = this.cacheStore.evaluateCached(previous, marker);
      if (hit) {
        this.logger.log(
          `[marv] catch-up CACHE HIT post=${postId} mode=${requestedMode} stale=${hit.stale} newReplies=${hit.newReplies}`,
        );
        return hit.dto;
      }
    }

    // Delta: when we're generating over a thread we've already summarized, hand the model the
    // previous summary and mark which replies are new, so the result leads with what changed
    // instead of re-narrating the whole thread to someone who already read it.
    const deltaContext =
      previous && previous.marker.totalDescendants < marker.totalDescendants
        ? {
            previousSummary: previous.dto.summary,
            sinceMs: previous.marker.latestMs,
            newReplyCount: marker.totalDescendants - previous.marker.totalDescendants,
          }
        : null;

    if (!this.ai.isConfigured()) {
      throw new HttpException(
        { message: 'Marv is not available right now. Please try again later.', error: MARV_ERROR_CODES.aiNotConfigured },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    // Single-flight anti-stampede: acquire a per-cache-key distributed lock so only one
    // concurrent request for the same (post, mode, freshness marker) runs the model and
    // spends credits. The lock callback does the full generate + cache write. Other waiters
    // re-check the cache when the lock releases and get the free cached copy. On lock-wait
    // timeout, fall through to generate independently (preserves availability; a rare
    // double-spend is far better than an unbounded concurrent stampede).
    const generateFn = async (): Promise<MarvinCatchUpDto> => {
      // 6. Routing — honor the requested/preferred mode, auto-upgrade for length/sensitivity.
      //    Web search is ENABLED so a post that references current events or unfamiliar
      //    terms can be summarized with real-world context (e.g. a thin single post).
      const openAICfg = this.appConfig.marvOpenAI();
      const creditCfg = this.appConfig.marvCredits();
      const contextText = this.contextPlainText(context);
      const routed = await this.routing.resolve({
        requested: requestedMode,
        source: 'catch_up',
        estimatedInputTokens: this.routing.estimateTokens(contextText),
        text: contextText,
        distinctAuthors: this.distinctAuthorCount(context),
        webSearchEnabled: openAICfg.webSearchEnabled,
      });
      let effectiveMode: ResolvedMarvinMode = routed.mode;

      // Vision: select images from across the conversation (shared with the @marv reply path)
      // so Marv can summarize what's actually shown, not just captions.
      // Skipped entirely when the caller set includeImages=false (opt-out → no surcharge).
      let imageUrls: string[] = [];
      let hasGifAttached = false;
      if (includeImages) {
        const selected = this.context.selectImageMedia(context, {
          visionEnabled: openAICfg.visionEnabled,
          visionMaxImagesPerTurn: openAICfg.visionMaxImagesPerTurn,
          publicBaseUrl: this.appConfig.r2()?.publicBaseUrl ?? null,
        });
        const merged = fillVisionSlots(
          selected.imageUrls,
          linkPreviews.map((p) => p.imageUrl),
          openAICfg.visionMaxImagesPerTurn,
        );
        hasGifAttached = selected.hasGifAttached;
        if (selected.totalImages > selected.imageUrls.length) {
          this.logger.log(
            `[marv] catch-up image cap hit post=${postId}: ${selected.totalImages} found, sending ${merged.length} (cap=${openAICfg.visionMaxImagesPerTurn})`,
          );
        }
        // An attached image is itself a routing signal: a "testing" post with a photo IS the photo.
        // If the routed tier can't see images, upgrade to the cheapest vision-capable tier so the
        // image is never silently dropped (mirrors how sensitive topics force Smart).
        if (
          merged.length > 0 &&
          openAICfg.visionEnabled &&
          !openAICfg.visionModes.includes(effectiveMode as string)
        ) {
          const visionTier = (['regular', 'smart', 'fast'] as const).find((m) => openAICfg.visionModes.includes(m));
          if (visionTier) effectiveMode = visionTier;
        }
        const visionActive = openAICfg.visionEnabled && openAICfg.visionModes.includes(effectiveMode as string);
        imageUrls = visionActive ? merged : [];
      }

      // 7. Hard-reserve credits before the AI turn (mode + vision + one web search + one URL fetch).
      const cost = this.credits.costForMode(effectiveMode);
      const threadPostCount =
        context.ancestors.length + (context.focal ? 1 : 0) + context.descendants.length;
      const threadCost = this.credits.threadContextSurcharge(threadPostCount);
      const estimatedVisionCost = imageUrls.length * creditCfg.visionCreditCostPerImage;
      const webSearchBuffer =
        openAICfg.webSearchEnabled && openAICfg.webSearchModes.includes(effectiveMode as string)
          ? creditCfg.webSearchCreditCost
          : 0;
      const urlFetchBuffer = creditCfg.urlFetchCreditCost;
      const reservedCost = cost + threadCost + estimatedVisionCost + webSearchBuffer + urlFetchBuffer;
      let reservedHeld = 0;
      let postSpend: Awaited<ReturnType<MarvinCreditService['settle']>>;
      try {
        postSpend = await this.credits.reserve(userId, reservedCost);
        reservedHeld = reservedCost;
      } catch (err) {
        if (err instanceof InsufficientMarvCreditsError) {
          throw new HttpException(
            {
              message: `You're out of Marv credits. You have ${Math.floor(err.currentCredits)}, this needs ${reservedCost}.`,
              error: MARV_ERROR_CODES.noCredits,
            },
            HttpStatus.PAYMENT_REQUIRED,
          );
        }
        throw err;
      }

      const refundHeld = async () => {
        if (reservedHeld <= 0) return;
        const amount = reservedHeld;
        reservedHeld = 0;
        await this.credits.refund(userId, amount).catch((e) => {
          this.logger.warn(`[marv] catch-up refund failed: ${String(e)}`);
        });
      };

      // 8. Build the summarizer prompt + call the model. Prefetch public profiles
      //    for anyone who appears in the window so the summary can use who they
      //    are without inventing it — or naming them unless it matters.
      const threadPosts = [
        ...context.ancestors,
        ...(context.focal ? [context.focal] : []),
        ...context.descendants,
      ];
      const memberCards = await this.tools.collectMentionedMemberCards({
        bodies: threadPosts.map((p) => p.body),
        extraUsernames: threadPosts.map((p) => p.authorUsername),
      });
      const { developerNote, userMessage } = buildCatchUpPrompt(context, {
        imageCount: imageUrls.length,
        hasGifAttached: hasGifAttached && imageUrls.length > 0,
        rollingSummary: rollingSummary ?? undefined,
        linkPreviews: linkPreviews.length > 0 ? linkPreviews : undefined,
        delta: deltaContext ?? undefined,
        memberCards: memberCards.length > 0 ? memberCards : undefined,
        group: context.group ?? undefined,
      });
      let aiResult: Awaited<ReturnType<MarvinAIService['respond']>>;
      try {
        aiResult = await this.ai.respond({
          source: 'catch_up',
          mode: effectiveMode,
          developerNote,
          userMessage,
          imageUrls: imageUrls.length > 0 ? imageUrls : undefined,
          imageNotes: { focalPostId: postId },
          dispatchTool: (name, args, ctx) => this.tools.dispatch(name, args, ctx),
          toolContext: { requesterUserId: userId, rootPostId, triggeringPostId: postId },
          cacheKey: `marv:catchup:${rootPostId}`,
          elevateReasoning: MarvinRoutingService.shouldElevateReasoning(routed),
        });
      } catch (err) {
        await refundHeld();
        this.logger.error(
          `[marv] catch-up AI call THREW post=${postId}: ${err instanceof Error ? err.message : String(err)}`,
        );
        await this.usage.recordEvent({
          userId,
          source: 'catch_up',
          sourceId: postId,
          rootPostId,
          requestedMode,
          effectiveMode,
          creditsSpent: 0,
          modelUsed: this.ai.modelForMode(effectiveMode),
          routingReason: routed.reason,
          errorCode: MARV_ERROR_CODES.aiError,
          latencyMs: Date.now() - startedAt,
        });
        throw new HttpException(
          { message: 'Marv could not summarize this thread right now. Please try again.', error: MARV_ERROR_CODES.aiError },
          HttpStatus.SERVICE_UNAVAILABLE,
        );
      }

      const rawText = (aiResult.text ?? '').trim();
      const { summary, sections } = this.parseSections(rawText, context.descendants.length > 0);
      if (!summary) {
        await refundHeld();
        await this.usage.recordEvent({
          userId,
          source: 'catch_up',
          sourceId: postId,
          rootPostId,
          requestedMode,
          effectiveMode,
          creditsSpent: 0,
          modelUsed: aiResult.modelUsed,
          routingReason: routed.reason,
          responseId: aiResult.responseId,
          errorCode: MARV_ERROR_CODES.aiNoText,
          latencyMs: Date.now() - startedAt,
        });
        throw new HttpException(
          { message: 'Marv could not summarize this thread right now. Please try again.', error: MARV_ERROR_CODES.aiNoText },
          HttpStatus.SERVICE_UNAVAILABLE,
        );
      }

      // 9. Settle reservation to actual cost + record usage (emits marv:credits-updated).
      const actualVisionCost = (aiResult.imagesAttached ?? 0) * creditCfg.visionCreditCostPerImage;
      const webSearchSurcharge = (aiResult.webSearchCount ?? 0) * creditCfg.webSearchCreditCost;
      const urlFetchSurcharge = (aiResult.urlFetchCount ?? 0) * creditCfg.urlFetchCreditCost;
      const totalCost = cost + threadCost + actualVisionCost + webSearchSurcharge + urlFetchSurcharge;

      try {
        postSpend = await this.credits.settle(userId, reservedCost, totalCost);
        reservedHeld = 0;
      } catch (err) {
        const isInsufficient = err instanceof InsufficientMarvCreditsError;
        if (!isInsufficient) await refundHeld();
        else reservedHeld = 0; // settle already refunded the reservation on overage failure
        await this.usage.recordEvent({
          userId,
          source: 'catch_up',
          sourceId: postId,
          rootPostId,
          requestedMode,
          effectiveMode,
          creditsSpent: 0,
          modelUsed: aiResult.modelUsed,
          routingReason: routed.reason,
          responseId: aiResult.responseId,
          inputTokens: aiResult.inputTokens,
          outputTokens: aiResult.outputTokens,
          cachedInputTokens: aiResult.cachedInputTokens,
          reasoningTokens: aiResult.reasoningTokens,
          estimatedCostUsd: aiResult.estimatedCostUsd,
          latencyMs: Date.now() - startedAt,
          errorCode: isInsufficient ? MARV_ERROR_CODES.noCredits : MARV_ERROR_CODES.aiError,
        });
        if (isInsufficient) {
          const cur = (err as InsufficientMarvCreditsError).currentCredits;
          throw new HttpException(
            {
              message: `You're out of Marv credits. You have ${Math.floor(cur)}, this needs ${totalCost}.`,
              error: MARV_ERROR_CODES.noCredits,
            },
            HttpStatus.PAYMENT_REQUIRED,
          );
        }
        throw err;
      }

      await this.usage.recordEvent({
        userId,
        source: 'catch_up',
        sourceId: postId,
        rootPostId,
        requestedMode,
        effectiveMode,
        creditsSpent: totalCost,
        modelUsed: aiResult.modelUsed,
        routingReason: routed.reason,
        responseId: aiResult.responseId,
        inputTokens: aiResult.inputTokens,
        outputTokens: aiResult.outputTokens,
        cachedInputTokens: aiResult.cachedInputTokens,
        reasoningTokens: aiResult.reasoningTokens,
        estimatedCostUsd: aiResult.estimatedCostUsd,
        latencyMs: Date.now() - startedAt,
        postSpendSummary: postSpend,
      });

      const dto: MarvinCatchUpDto = {
        postId,
        rootPostId,
        summary,
        sections,
        effectiveMode,
        creditsSpent: totalCost,
        costBreakdown: {
          mode: cost,
          vision: actualVisionCost,
          webSearch: webSearchSurcharge,
          urlFetch: urlFetchSurcharge,
        },
        cached: false,
        // A summary generated against the thread as it stands right now is by definition current.
        stale: false,
        newReplies: 0,
        included: {
          ancestors: context.ancestors.length,
          descendants: context.descendants.length,
          totalDescendants: context.totalDescendants,
        },
        generatedAt: new Date().toISOString(),
      };

      this.logger.log(
        `[marv] catch-up ok post=${postId} mode=${effectiveMode} cost=${totalCost} (mode=${cost} + vision=${actualVisionCost} + webSearch=${webSearchSurcharge} + urlFetch=${urlFetchSurcharge}) images=${aiResult.imagesAttached ?? 0} ancestors=${dto.included.ancestors} descendants=${dto.included.descendants}/${dto.included.totalDescendants}`,
      );
      return dto;
    };

    type LockOutcome = { fromCache: boolean; dto: MarvinCatchUpDto };
    // The LOCK key keeps the marker: two requests generating against different thread states
    // are genuinely different work and must not block each other.
    const lockResult = await this.cache.withLock<LockOutcome>(
      `marv:catchup:gen:${cacheKey}:${freshnessMarkerToken(marker)}`,
      { ttlMs: 120_000, waitMs: 10_000, retryDelayMs: 200 },
      async () => {
        // Double-check cache inside the lock — the previous holder may have just written it.
        // Skip this second check if forceRefresh was requested (user wants a fresh result).
        if (!params.forceRefresh) {
          const entry = await this.cacheStore.readCachedEnvelope(cacheKey);
          const hit = entry ? this.cacheStore.evaluateCached(entry, marker) : null;
          if (hit) {
            this.logger.log(
              `[marv] catch-up CACHE HIT (inside lock) post=${postId} mode=${requestedMode} stale=${hit.stale}`,
            );
            return { fromCache: true, dto: hit.dto };
          }
        }
        // We are the lock holder — generate, spend, and cache alongside the thread state it
        // was generated against.
        const freshDto = await generateFn();
        await this.cacheStore.writeCached(cacheKey, freshDto, marker);
        return { fromCache: false, dto: freshDto };
      },
    );

    if (lockResult !== null) return lockResult.dto;

    // Lock timed out (very rare) — generate independently, same as before this fix.
    this.logger.warn(`[marv] catch-up lock timeout for post=${postId}, generating independently`);
    const fallbackDto = await generateFn();
    // Also write to cache so future requests benefit (the lock is no longer held).
    void this.cacheStore.writeCached(cacheKey, fallbackDto, marker).catch(() => undefined);
    return fallbackDto;
  }

  /**
   * Parse the AI's labeled output into structured fields.
   * Expected format (when hasReplies):
   *   POST: <text>
   *   REPLIES: <text>
   *   SINCE: <text>          ← only when a delta was requested
   * Falls back gracefully when the model doesn't follow the format exactly.
   */
  private parseSections(
    text: string,
    hasReplies: boolean,
  ): { summary: string; sections: MarvinCatchUpDto['sections'] } {
    if (!hasReplies) {
      return { summary: text, sections: null };
    }
    const parts = this.splitLabeledSections(text);
    if (parts.POST && parts.REPLIES) {
      const post = parts.POST;
      const replies = parts.REPLIES;
      const since = parts.SINCE ?? null;
      // `summary` is the flat fallback for anything that doesn't read `sections`. Lead with
      // the delta when there is one — it's the news.
      const summary = [since, post, replies].filter(Boolean).join('\n\n');
      return { summary, sections: { post, replies: replies || null, since } };
    }
    // AI didn't follow the format — strip any partial markers and return as a single blob.
    const stripped = text.replace(/^(POST|REPLIES|SINCE):\s*/gm, '').trim();
    return { summary: stripped || text, sections: null };
  }

  /**
   * Slice text on its leading section labels. Handles labels in any order and tolerates a
   * missing one, which a positional regex per label can't do once there are three of them.
   */
  private splitLabeledSections(text: string): Partial<Record<'POST' | 'REPLIES' | 'SINCE', string>> {
    const re = /^(POST|REPLIES|SINCE):[ \t]*/gm;
    const hits: Array<{ name: 'POST' | 'REPLIES' | 'SINCE'; labelStart: number; bodyStart: number }> = [];
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
      hits.push({
        name: match[1] as 'POST' | 'REPLIES' | 'SINCE',
        labelStart: match.index,
        bodyStart: match.index + match[0].length,
      });
    }
    const out: Partial<Record<'POST' | 'REPLIES' | 'SINCE', string>> = {};
    for (let i = 0; i < hits.length; i += 1) {
      const end = i + 1 < hits.length ? hits[i + 1].labelStart : text.length;
      out[hits[i].name] = text.slice(hits[i].bodyStart, end).trim();
    }
    return out;
  }

  private distinctAuthorCount(context: MarvThreadContext): number {
    const ids = new Set<string>();
    if (context.focal) ids.add(context.focal.authorUserId);
    for (const p of context.ancestors) ids.add(p.authorUserId);
    for (const p of context.descendants) ids.add(p.authorUserId);
    return ids.size;
  }

  private contextPlainText(context: MarvThreadContext): string {
    const parts: string[] = [];
    for (const p of context.ancestors) parts.push(p.body);
    if (context.focal) parts.push(context.focal.body);
    for (const p of context.descendants) parts.push(p.body);
    return parts.join('\n');
  }

}
