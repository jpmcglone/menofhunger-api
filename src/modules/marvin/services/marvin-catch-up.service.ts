import { ForbiddenException, HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import type { MarvinMode } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AppConfigService } from '../../app/app-config.service';
import { CacheService } from '../../redis/cache.service';
import { PostsService } from '../../posts/posts.service';
import { LinkMetadataService } from '../../link-metadata/link-metadata.service';
import type { MarvinCatchUpDto } from '../../../common/dto/marvin';
import { MarvinAIService } from './marvin-ai.service';
import { MarvinCreditService, InsufficientMarvCreditsError } from './marvin-credit.service';
import { MarvinRoutingService, type ResolvedMarvinMode } from './marvin-routing.service';
import { MarvinUsageService } from './marvin-usage.service';
import { MarvinThreadSummaryService } from './marvin-thread-summary.service';
import { MarvinToolHandlersService } from './marvin-tool-handlers.service';
import {
  MarvinThreadContextService,
  type MarvThreadContext,
  type MarvThreadContextPost,
} from './marvin-thread-context.service';
import { MARV_ERROR_CODES } from '../marvin.constants';
import { MARV_CONCISENESS } from '../marvin-prompt-instructions';

/**
 * Cache lifetime for a generated summary. Generous because the freshness marker — not the
 * TTL — is the real invalidation mechanism: a summary of an unchanged thread stays accurate
 * indefinitely, so a short TTL only threw away good summaries and re-charged for them. The
 * ceiling exists because a summary can fold in link previews and web-search context, which
 * do drift with the outside world.
 */
const SUMMARY_CACHE_TTL_SECONDS = 6 * 60 * 60;

/**
 * How much thread growth a stale summary can absorb and still be worth serving.
 * Beyond this we treat the entry as a miss: a summary covering a small fraction of the
 * current thread is misleading even when it's labeled, and it would make the "summary
 * ready" affordance on the post row dishonest.
 */
const STALE_SERVE_MAX_NEW_REPLIES = 25;
const STALE_SERVE_MAX_GROWTH_RATIO = 0.5;

/** Thread state a summary was generated against. Drives fresh/stale/too-stale decisions. */
type FreshnessMarker = { totalDescendants: number; latestMs: number };

/**
 * What actually lives in Redis: the summary plus the thread state it was generated against.
 * The marker is stored in the VALUE rather than baked into the key so a changed thread can
 * still find (and soft-serve) the previous summary. Keying by marker made a single new reply
 * orphan a paid summary and drop the user back onto a paywall with no context.
 */
type CachedCatchUp = { dto: MarvinCatchUpDto; marker: FreshnessMarker };

/** A cache read that's worth serving, with how far the thread has drifted since. */
type CacheReadHit = { dto: MarvinCatchUpDto; stale: boolean; newReplies: number };

/**
 * "Catch me up" — a synchronous, premium, credit-spending request that summarizes the
 * conversation BOTH above and below a focal post (ancestors + descendant subtree).
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
    private readonly posts: PostsService,
    private readonly context: MarvinThreadContextService,
    private readonly routing: MarvinRoutingService,
    private readonly ai: MarvinAIService,
    private readonly credits: MarvinCreditService,
    private readonly usage: MarvinUsageService,
    private readonly threadSummary: MarvinThreadSummaryService,
    private readonly tools: MarvinToolHandlersService,
    private readonly linkMetadata: LinkMetadataService,
  ) {}

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

    // 3. Visibility gate — resolve through PostsService so gated/onlyMe content never leaks.
    //    Throws ForbiddenException/NotFoundException, which the global filter surfaces verbatim.
    const post = await this.posts.getById({ viewerUserId: userId, id: postId });
    const rootPostId = (post as { rootId?: string | null }).rootId ?? post.id;

    // 4. Collect bidirectional context + rolling summary + link previews in parallel.
    const [context, rollingSummary] = await Promise.all([
      this.context.collect({ focalPostId: postId }),
      this.threadSummary.getSummaryText(rootPostId).catch(() => null),
    ]);

    // Link previews from focal body + last 3 descendants (DB-only, no fetch cost).
    const previewBodies = [
      context.focal?.body ?? '',
      ...context.descendants.slice(-3).map((p) => p.body),
    ]
      .filter(Boolean)
      .join('\n');
    const linkPreviews = await this.linkMetadata.previewLinks(previewBodies).catch(() => []);

    // 5. Cache check — keyed by the REQUESTED mode (so Auto/Fast/Regular/Smart cache
    //    separately and switching the picker never returns a summary from another tier) and
    //    by the images opt-in. The freshness marker is compared against the STORED marker
    //    rather than being part of the key, so a moved-on thread still finds its previous
    //    summary and serves it as `stale`.
    //    A forced refresh (the "Regenerate"/"Update" button) skips the read and recomputes.
    const marker = this.freshnessMarker(context);
    const imgToken = includeImages ? 'img' : 'noimg';
    const cacheKey = `marv:catchup:${postId}:${requestedMode}:${imgToken}`;
    // One read serves two purposes: a servable entry short-circuits the request, and an entry
    // we won't serve (too stale, or a forced update) still seeds the delta below.
    const previous = await this.readCachedEnvelope(cacheKey);
    if (!params.forceRefresh && previous) {
      const hit = this.evaluateCached(previous, marker);
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
      const routed = this.routing.resolve({
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
        hasGifAttached = selected.hasGifAttached;
        if (selected.totalImages > selected.imageUrls.length) {
          this.logger.log(
            `[marv] catch-up image cap hit post=${postId}: ${selected.totalImages} found, sending ${selected.imageUrls.length} (cap=${openAICfg.visionMaxImagesPerTurn})`,
          );
        }
        // An attached image is itself a routing signal: a "testing" post with a photo IS the photo.
        // If the routed tier can't see images, upgrade to the cheapest vision-capable tier so the
        // image is never silently dropped (mirrors how sensitive topics force Smart).
        if (
          selected.imageUrls.length > 0 &&
          openAICfg.visionEnabled &&
          !openAICfg.visionModes.includes(effectiveMode as string)
        ) {
          const visionTier = (['regular', 'smart', 'fast'] as const).find((m) => openAICfg.visionModes.includes(m));
          if (visionTier) effectiveMode = visionTier;
        }
        const visionActive = openAICfg.visionEnabled && openAICfg.visionModes.includes(effectiveMode as string);
        imageUrls = visionActive ? selected.imageUrls : [];
      }

      // 7. Credit gate — reserve base + vision (per image) + worst-case one web search, mirroring
      //    the @marv reply path so the spend can't fail after a successful, billable call.
      const cost = this.credits.costForMode(effectiveMode);
      const estimatedVisionCost = imageUrls.length * creditCfg.visionCreditCostPerImage;
      const webSearchBuffer =
        openAICfg.webSearchEnabled && openAICfg.webSearchModes.includes(effectiveMode as string)
          ? creditCfg.webSearchCreditCost
          : 0;
      const reservedCost = cost + estimatedVisionCost + webSearchBuffer;
      const balance = await this.credits.refill(userId);
      if (balance.credits < reservedCost) {
        throw new HttpException(
          {
            message: `You're out of Marv credits. You have ${Math.floor(balance.credits)}, this needs ${reservedCost}.`,
            error: MARV_ERROR_CODES.noCredits,
          },
          HttpStatus.PAYMENT_REQUIRED,
        );
      }

      // 8. Build the summarizer prompt + call the model. Real tools are available (same as
      //    mentions/chat) so Marv can look up user context cards, post details, etc.
      //    Native web search may engage for real-world context.
      const { developerNote, userMessage } = this.buildPrompt(context, {
        imageCount: imageUrls.length,
        hasGifAttached: hasGifAttached && imageUrls.length > 0,
        rollingSummary: rollingSummary ?? undefined,
        linkPreviews: linkPreviews.length > 0 ? linkPreviews : undefined,
        delta: deltaContext ?? undefined,
      });
      let aiResult: Awaited<ReturnType<MarvinAIService['respond']>>;
      try {
        aiResult = await this.ai.respond({
          source: 'catch_up',
          mode: effectiveMode,
          developerNote,
          userMessage,
          imageUrls: imageUrls.length > 0 ? imageUrls : undefined,
          dispatchTool: (name, args, ctx) => this.tools.dispatch(name, args, ctx),
          toolContext: { requesterUserId: userId, rootPostId, triggeringPostId: postId },
          cacheKey: `marv:catchup:${rootPostId}`,
        });
      } catch (err) {
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

      // 9. Spend credits + record usage (emits marv:credits-updated via postSpendSummary).
      //    Charge the ACTUAL images the AI service confirmed it sent, plus web-search/url-fetch usage.
      const actualVisionCost = (aiResult.imagesAttached ?? 0) * creditCfg.visionCreditCostPerImage;
      const webSearchSurcharge = (aiResult.webSearchCount ?? 0) * creditCfg.webSearchCreditCost;
      const urlFetchSurcharge = (aiResult.urlFetchCount ?? 0) * creditCfg.urlFetchCreditCost;
      const totalCost = cost + actualVisionCost + webSearchSurcharge + urlFetchSurcharge;

      let postSpend: Awaited<ReturnType<MarvinCreditService['spend']>>;
      try {
        postSpend = await this.credits.spend(userId, totalCost, {
          recentSummary: { credits: balance.credits, lastRefilledAt: balance.lastRefilledAt },
        });
      } catch (err) {
        // Credits drained between the pre-check (step 7) and the spend — treat the same
        // as the pre-check rejection: 402, no cache, honest usage event.
        const isInsufficient = err instanceof InsufficientMarvCreditsError;
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
      `marv:catchup:gen:${cacheKey}:${this.markerToken(marker)}`,
      { ttlMs: 120_000, waitMs: 10_000, retryDelayMs: 200 },
      async () => {
        // Double-check cache inside the lock — the previous holder may have just written it.
        // Skip this second check if forceRefresh was requested (user wants a fresh result).
        if (!params.forceRefresh) {
          const entry = await this.readCachedEnvelope(cacheKey);
          const hit = entry ? this.evaluateCached(entry, marker) : null;
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
        await this.writeCached(cacheKey, freshDto, marker);
        return { fromCache: false, dto: freshDto };
      },
    );

    if (lockResult !== null) return lockResult.dto;

    // Lock timed out (very rare) — generate independently, same as before this fix.
    this.logger.warn(`[marv] catch-up lock timeout for post=${postId}, generating independently`);
    const fallbackDto = await generateFn();
    // Also write to cache so future requests benefit (the lock is no longer held).
    void this.writeCached(cacheKey, fallbackDto, marker).catch(() => undefined);
    return fallbackDto;
  }

  /**
   * Cache-only "peek": resolve the cache key for (post, mode, images), compare the stored
   * thread state against the current one, and return the summary if it's worth serving —
   * WITHOUT ever calling the AI or spending credits. Used by the client to decide whether
   * opening the modal can show a free summary immediately or must wait for an explicit,
   * credit-spending "Catch me up".
   *
   * Deliberately NOT premium-gated. Summaries are already shared across viewers, so an
   * existing cache entry costs nothing to serve, and letting a non-premium viewer read one
   * is a better funnel than a lock icon: they experience the feature instead of reading
   * about it, and the modal puts the upgrade CTA next to real output. They still can't
   * GENERATE — `catchUp()` keeps the premium gate — so nobody gets on-demand summaries for
   * free, and an entry only exists because a premium member paid for it.
   *
   * Returns `null` on any miss, gate failure, or access error: a peek must never throw and
   * must never cost anything. The cheap gates + a context collect (recursive CTEs) are the
   * only work done; no rolling summary / link previews are fetched.
   */
  async peekCached(params: {
    userId: string;
    postId: string;
    requestedMode?: MarvinMode | null;
    includeImages?: boolean;
  }): Promise<MarvinCatchUpDto | null> {
    const { userId, postId } = params;
    const includeImages = params.includeImages !== false;
    try {
      const cfg = this.appConfig.marvBot();
      const settings = await this.prisma.marvinUserSettings.findUnique({
        where: { userId },
        select: { disabledByAdmin: true, preferredMode: true },
      });
      if (!cfg.enabled || settings?.disabledByAdmin) return null;

      const requestedMode: MarvinMode = params.requestedMode ?? settings?.preferredMode ?? 'auto';

      // Visibility: resolve through PostsService so we never peek a cache key for a post the
      // viewer can't see. Any access error → treat as "nothing cached".
      const _post = await this.posts.getById({ viewerUserId: userId, id: postId });

      const context = await this.context.collect({ focalPostId: postId });
      const marker = this.freshnessMarker(context);
      const imgToken = includeImages ? 'img' : 'noimg';
      const cacheKey = `marv:catchup:${postId}:${requestedMode}:${imgToken}`;
      const entry = await this.readCachedEnvelope(cacheKey);
      const hit = entry ? this.evaluateCached(entry, marker) : null;
      if (!hit) return null;

      this.logger.log(
        `[marv] catch-up PEEK hit post=${postId} mode=${requestedMode} stale=${hit.stale} newReplies=${hit.newReplies}`,
      );
      return hit.dto;
    } catch (err) {
      this.logger.debug(`[marv] catch-up PEEK error post=${postId}: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  /**
   * Fetch the stored envelope, guarding the shape. Entries written before the marker moved
   * into the value have no `.marker` and can't be compared against the current thread, so
   * they're treated as absent; they expire on their own.
   */
  private async readCachedEnvelope(cacheKey: string): Promise<CachedCatchUp | null> {
    const entry = await this.cache.getJson<CachedCatchUp>(cacheKey);
    if (!entry?.dto || !entry.marker) return null;
    return entry;
  }

  /**
   * Decide whether a stored summary is worth serving against the CURRENT thread state.
   * Returns null when the thread has outgrown it badly enough that showing it would mislead.
   *
   * A hit is always free: `creditsSpent` and `costBreakdown` are zeroed, `cached` is true, and
   * `stale`/`newReplies` describe the drift so the client can label it and offer an update.
   */
  private evaluateCached(entry: CachedCatchUp, current: FreshnessMarker): CacheReadHit | null {
    const newReplies = Math.max(0, current.totalDescendants - entry.marker.totalDescendants);
    const stale =
      current.totalDescendants !== entry.marker.totalDescendants || current.latestMs !== entry.marker.latestMs;

    if (stale && !this.isStaleWorthServing(newReplies, entry.marker.totalDescendants)) return null;

    return {
      dto: {
        ...entry.dto,
        creditsSpent: 0,
        costBreakdown: { mode: 0, vision: 0, webSearch: 0, urlFetch: 0 },
        cached: true,
        stale,
        newReplies,
      },
      stale,
      newReplies,
    };
  }

  /** Store the summary (normalized to free) alongside the thread state it was generated against. */
  private async writeCached(cacheKey: string, dto: MarvinCatchUpDto, marker: FreshnessMarker): Promise<void> {
    const entry: CachedCatchUp = {
      dto: {
        ...dto,
        creditsSpent: 0,
        costBreakdown: { mode: 0, vision: 0, webSearch: 0, urlFetch: 0 },
        cached: true,
        stale: false,
        newReplies: 0,
      },
      marker,
    };
    await this.cache.setJson(cacheKey, entry, { ttlSeconds: SUMMARY_CACHE_TTL_SECONDS });
  }

  /**
   * A stale summary is worth serving while the thread hasn't grown much relative to what was
   * summarized. Proportional with an absolute floor: 20 new replies is noise on a 400-reply
   * thread but the whole story on a 5-reply one.
   */
  private isStaleWorthServing(newReplies: number, summarizedTotal: number): boolean {
    const allowed = Math.max(STALE_SERVE_MAX_NEW_REPLIES, summarizedTotal * STALE_SERVE_MAX_GROWTH_RATIO);
    return newReplies <= allowed;
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

  /**
   * Marker that changes when: a reply is added/removed, any visible post is edited
   * (updatedAt), or the focal post itself changes. Covers edits to the focal post, ancestors,
   * or any descendant — so a summary is never silently presented as current after a
   * meaningful thread update.
   */
  private freshnessMarker(context: MarvThreadContext): FreshnessMarker {
    let latestMs = 0;
    const touch = (p: MarvThreadContextPost) => {
      latestMs = Math.max(latestMs, p.createdAt.getTime(), p.editedAt?.getTime() ?? 0);
    };
    if (context.focal) touch(context.focal);
    for (const p of context.ancestors) touch(p);
    for (const p of context.descendants) touch(p);
    return { totalDescendants: context.totalDescendants, latestMs };
  }

  /** Flat form of the marker, for lock keys and logs. */
  private markerToken(marker: FreshnessMarker): string {
    return `${marker.totalDescendants}-${marker.latestMs}`;
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

  private buildPrompt(
    context: MarvThreadContext,
    opts: {
      imageCount: number;
      hasGifAttached: boolean;
      rollingSummary?: string;
      linkPreviews?: Array<{ url: string; title: string | null; description: string | null; siteName: string | null }>;
      /** Present when the viewer has summarized this thread before — drives the SINCE section. */
      delta?: { previousSummary: string; sinceMs: number; newReplyCount: number };
    },
  ): { developerNote: string; userMessage: string } {
    const { imageCount, hasGifAttached, rollingSummary, linkPreviews, delta } = opts;
    const hasImages = imageCount > 0;
    const hasThread = context.ancestors.length > 0 || context.descendants.length > 0;
    const hasReplies = context.descendants.length > 0;
    const lines: string[] = [];

    // Core task + grounding
    lines.push(
      (hasThread
        ? 'TASK: Summarize what this conversation is ABOUT and where it landed — the throughline, ' +
          'the main points, any disagreement or conclusion — anchored on the highlighted post. ' +
          'SYNTHESIZE; do NOT narrate it post-by-post ("@a said X, then @b said Y"). ' +
          'Name people only when who-holds-which-position actually matters, not as a transcript. '
        : 'TASK: Summarize the point of the highlighted post in one sentence. ') +
        'Stay in your voice — brief and stoic, plain prose, no preamble. ' +
        'Length scales with substance: a thin or trivial post gets ONE sentence; only a genuinely ' +
        'busy thread earns a short paragraph. ' +
        'You may use web search or general knowledge for a quick factual gloss on a referenced ' +
        'event, person, or term — one clause, not a lecture. Any such gloss must read as background ' +
        'context, never as something said in the thread. ' +
        'Do NOT speculate about messages that might be posted later or about what you would "need." ' +
        'Stay neutral; no opinions or advice. ' +
        'Never say "nothing to summarize."' +
        (hasImages
          ? ` The ${imageCount > 1 ? `${imageCount} attached images are` : 'attached image is'} part of the ` +
            'conversation — describe what they actually show (scene, subject, any text in the image) as part ' +
            'of the summary; for a near-empty caption the image is the substance. Images are given in reading ' +
            'order, matching the posts marked [attached: …].'
          : '') +
        (hasGifAttached ? ' One attached image is an animated GIF; treat it as a moving reaction, not a still.' : ''),
    );

    // Anti-fabrication guardrail
    lines.push('');
    lines.push(
      'GROUNDING: Summarize ONLY what is actually written in this thread. ' +
        'Never invent names, quotes, numbers, claims, or details not present in the posts below. ' +
        'If something is unclear or ambiguous, omit it rather than guess.',
    );

    // Sections format (only when there are replies)
    if (hasReplies) {
      lines.push('');
      const postLine =
        'POST: [the highlighted post\'s point, read IN CONTEXT of the path above it. ' +
        'If it is a reply, make clear what it is responding to. One or two sentences.]';
      const repliesLine =
        'REPLIES: [synthesis of the replies BELOW the highlighted post — throughline, key points, any conclusion]';
      if (delta) {
        lines.push(
          'FORMAT: Output EXACTLY three labeled paragraphs with no other text:\n' +
            `SINCE: [what has changed since the earlier summary quoted below — the reader has ` +
            `ALREADY read that summary, so cover only the ${delta.newReplyCount} newer ` +
            `repl${delta.newReplyCount === 1 ? 'y' : 'ies'} marked [new] and any shift in where ` +
            `the thread landed. Do NOT repeat what the earlier summary already said. If the new ` +
            `replies add nothing of substance, say so in one short sentence.]\n` +
            `${postLine}\n${repliesLine}`,
        );
      } else {
        lines.push(`FORMAT: Output EXACTLY two labeled paragraphs with no other text:\n${postLine}\n${repliesLine}`);
      }
    }

    // Prior summary the reader has already seen — the baseline the SINCE section works against.
    if (delta) {
      lines.push('');
      lines.push('Earlier summary the reader has already read:');
      lines.push(`  ${delta.previousSummary.trim().slice(0, 1500)}`);
    }

    // Rolling summary covers posts beyond the context window (mirrors prompt-builder line 176-179).
    if (rollingSummary?.trim()) {
      lines.push('');
      lines.push('Thread summary so far (older posts beyond the window below):');
      lines.push(`  ${rollingSummary.trim().slice(0, 1500)}`);
    }

    if (context.ancestors.length > 0) {
      lines.push('');
      lines.push('Path above the highlighted post (oldest → newest):');
      for (const p of context.ancestors) lines.push(`  ${this.renderPost(p)}`);
    }

    if (context.focal) {
      lines.push('');
      lines.push(`Highlighted post: ${this.renderPost(context.focal)}`);
    }

    if (context.descendants.length > 0) {
      lines.push('');
      lines.push(
        delta
          ? 'Replies below the highlighted post (depth-first reading order); [new] marks replies posted after the earlier summary:'
          : 'Replies below the highlighted post (depth-first reading order):',
      );
      for (const p of context.descendants) {
        const indent = '  '.repeat(Math.max(1, p.depth));
        const isNew = delta ? Math.max(p.createdAt.getTime(), p.editedAt?.getTime() ?? 0) > delta.sinceMs : false;
        lines.push(`${indent}${isNew ? '[new] ' : ''}${this.renderPost(p)}`);
      }
      const hidden = context.totalDescendants - context.descendants.length;
      if (hidden > 0) lines.push(`  …and ${hidden} more repl${hidden === 1 ? 'y' : 'ies'} not shown.`);
    }

    if (linkPreviews && linkPreviews.length > 0) {
      lines.push('');
      lines.push('[Link previews from the conversation]');
      for (const lp of linkPreviews) {
        const site = lp.siteName ? ` — ${lp.siteName}` : '';
        const desc = lp.description ? ` — ${lp.description.slice(0, 120)}` : '';
        const title = lp.title ?? lp.url;
        lines.push(`  - "${title}"${site}${desc}`);
      }
    }

    lines.push('');
    lines.push(MARV_CONCISENESS);

    return {
      developerNote: lines.join('\n'),
      userMessage: 'Catch me up on this post and any conversation around it.',
    };
  }

  private renderPost(p: MarvThreadContextPost): string {
    const handle = p.isMarv ? '@marv' : p.authorUsername ? `@${p.authorUsername}` : (p.authorDisplayName ?? 'someone');
    const checkin = p.checkinPrompt ? `[check-in: "${p.checkinPrompt.slice(0, 120)}"] ` : '';
    const poll = p.poll ? ` [poll: ${p.poll.options.map((o) => `${o.text} (${o.voteCount})`).join(', ')}]` : '';
    return `${handle}: ${checkin}"${p.body}"${this.mediaMarker(p.media)}${poll}`;
  }

  /** Note attached media inline so even a non-vision summary acknowledges an image-only post. */
  private mediaMarker(media: MarvThreadContextPost['media']): string {
    if (!media || media.length === 0) return '';
    const gifs = media.filter((m) => m.kind === 'gif').length;
    const images = media.length - gifs;
    const parts: string[] = [];
    if (images > 0) parts.push(images === 1 ? 'image' : `${images} images`);
    if (gifs > 0) parts.push(gifs === 1 ? 'animated GIF' : `${gifs} GIFs`);
    return parts.length > 0 ? ` [attached: ${parts.join(' + ')}]` : '';
  }
}
