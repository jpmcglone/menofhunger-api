import { ForbiddenException, HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import type { MarvinMode } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AppConfigService } from '../../app/app-config.service';
import { CacheService } from '../../redis/cache.service';
import { PostsService } from '../../posts/posts.service';
import { LinkMetadataService } from '../../link-metadata/link-metadata.service';
import type { MarvinCatchUpDto } from '../../../common/dto/marvin';
import { MarvinAIService } from './marvin-ai.service';
import { MarvinCreditService } from './marvin-credit.service';
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

/** Cache lifetime for a generated summary (a fresh reply or two invalidates via the marker). */
const SUMMARY_CACHE_TTL_SECONDS = 15 * 60;

/**
 * "Catch me up" — a synchronous, premium, credit-spending request that summarizes the
 * conversation BOTH above and below a focal post (ancestors + descendant subtree).
 *
 * Mirrors the credit/routing/usage discipline of the reply processors, but returns the
 * summary in the HTTP envelope instead of posting it. Results are cached per-thread
 * (keyed by a freshness marker) so a second viewer — or the same viewer re-opening the
 * modal — pays nothing while the thread is unchanged.
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
    //    a freshness marker (descendant count + latest updatedAt/createdAt across all posts).
    //    A forced refresh (the "Regenerate" button) skips the read and recomputes.
    const marker = this.freshnessMarker(context);
    const imgToken = includeImages ? 'img' : 'noimg';
    const cacheKey = `marv:catchup:${postId}:${requestedMode}:${imgToken}:${marker}`;
    if (!params.forceRefresh) {
      const cached = await this.cache.getJson<MarvinCatchUpDto>(cacheKey);
      if (cached) {
        this.logger.log(`[marv] catch-up CACHE HIT post=${postId} mode=${requestedMode} marker=${marker}`);
        return {
          ...cached,
          creditsSpent: 0,
          costBreakdown: { mode: 0, vision: 0, webSearch: 0, urlFetch: 0 },
          cached: true,
        };
      }
    }

    if (!this.ai.isConfigured()) {
      throw new HttpException(
        { message: 'Marv is not available right now. Please try again later.', error: MARV_ERROR_CODES.aiNotConfigured },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

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

    let postSpend: Awaited<ReturnType<MarvinCreditService['spend']>> | null = null;
    try {
      postSpend = await this.credits.spend(userId, totalCost, {
        recentSummary: { credits: balance.credits, lastRefilledAt: balance.lastRefilledAt },
      });
    } catch (err) {
      this.logger.warn(
        `[marv] catch-up credit spend failed after success: ${err instanceof Error ? err.message : String(err)}`,
      );
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
      included: {
        ancestors: context.ancestors.length,
        descendants: context.descendants.length,
        totalDescendants: context.totalDescendants,
      },
      generatedAt: new Date().toISOString(),
    };

    // Cache for the next viewer of this unchanged thread.
    void this.cache
      .setJson(cacheKey, dto, { ttlSeconds: SUMMARY_CACHE_TTL_SECONDS })
      .catch(() => undefined);

    this.logger.log(
      `[marv] catch-up ok post=${postId} mode=${effectiveMode} cost=${totalCost} (mode=${cost} + vision=${actualVisionCost} + webSearch=${webSearchSurcharge} + urlFetch=${urlFetchSurcharge}) images=${aiResult.imagesAttached ?? 0} ancestors=${dto.included.ancestors} descendants=${dto.included.descendants}/${dto.included.totalDescendants}`,
    );
    return dto;
  }

  /**
   * Cache-only "peek": resolve the exact cache key for (post, mode, current thread state)
   * and return the cached summary if one exists — WITHOUT ever calling the AI or spending
   * credits. Used by the client to decide whether opening the modal can show a free summary
   * immediately (cache hit) or must wait for an explicit, credit-spending "Catch me up".
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
      const [viewer, settings] = await Promise.all([
        this.prisma.user.findUnique({ where: { id: userId }, select: { premium: true, premiumPlus: true } }),
        this.prisma.marvinUserSettings.findUnique({
          where: { userId },
          select: { disabledByAdmin: true, preferredMode: true },
        }),
      ]);
      if (!cfg.enabled || settings?.disabledByAdmin) return null;
      if (!viewer?.premium && !viewer?.premiumPlus) return null;

      const requestedMode: MarvinMode = params.requestedMode ?? settings?.preferredMode ?? 'auto';

      // Visibility: resolve through PostsService so we never peek a cache key for a post the
      // viewer can't see. Any access error → treat as "nothing cached".
      const post = await this.posts.getById({ viewerUserId: userId, id: postId });

      const context = await this.context.collect({ focalPostId: postId });
      const marker = this.freshnessMarker(context);
      const imgToken = includeImages ? 'img' : 'noimg';
      const cacheKey = `marv:catchup:${postId}:${requestedMode}:${imgToken}:${marker}`;
      const cached = await this.cache.getJson<MarvinCatchUpDto>(cacheKey);
      if (!cached) return null;

      this.logger.log(`[marv] catch-up PEEK hit post=${postId} mode=${requestedMode} marker=${marker}`);
      void post;
      return {
        ...cached,
        creditsSpent: 0,
        costBreakdown: { mode: 0, vision: 0, webSearch: 0, urlFetch: 0 },
        cached: true,
      };
    } catch {
      return null;
    }
  }

  /**
   * Parse the AI's two-section output into structured fields.
   * Expected format (when hasReplies):
   *   POST: <text>
   *   REPLIES: <text>
   * Falls back gracefully when the model doesn't follow the format exactly.
   */
  private parseSections(
    text: string,
    hasReplies: boolean,
  ): { summary: string; sections: MarvinCatchUpDto['sections'] } {
    if (!hasReplies) {
      return { summary: text, sections: null };
    }
    const postMatch = /^POST:\s*(.+?)(?=\nREPLIES:|$)/ms.exec(text);
    const repliesMatch = /^REPLIES:\s*([\s\S]+?)$/ms.exec(text);
    if (postMatch && repliesMatch) {
      const post = postMatch[1].trim();
      const replies = repliesMatch[1].trim();
      return {
        summary: replies ? `${post}\n\n${replies}` : post,
        sections: { post, replies: replies || null },
      };
    }
    // AI didn't follow the format — strip any partial markers and return as a single blob.
    const stripped = text.replace(/^(POST|REPLIES):\s*/gm, '').trim();
    return { summary: stripped || text, sections: null };
  }

  /**
   * Marker that changes when: a reply is added/removed, any visible post is edited
   * (updatedAt), or the focal post itself changes. Covers edits to the focal post, ancestors,
   * or any descendant — ensuring stale summaries don't survive a meaningful thread update.
   */
  private freshnessMarker(context: MarvThreadContext): string {
    let latestMs = 0;
    const touch = (p: MarvThreadContextPost) => {
      latestMs = Math.max(latestMs, p.createdAt.getTime(), p.editedAt?.getTime() ?? 0);
    };
    if (context.focal) touch(context.focal);
    for (const p of context.ancestors) touch(p);
    for (const p of context.descendants) touch(p);
    return `${context.totalDescendants}-${latestMs}`;
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
    },
  ): { developerNote: string; userMessage: string } {
    const { imageCount, hasGifAttached, rollingSummary, linkPreviews } = opts;
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
      lines.push(
        'FORMAT: Output EXACTLY two labeled paragraphs with no other text:\n' +
          'POST: [the highlighted post\'s point, read IN CONTEXT of the path above it. ' +
          'If it is a reply, make clear what it is responding to. One or two sentences.]\n' +
          'REPLIES: [synthesis of the replies BELOW the highlighted post — throughline, key points, any conclusion]',
      );
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
      lines.push('Replies below the highlighted post (depth-first reading order):');
      for (const p of context.descendants) {
        const indent = '  '.repeat(Math.max(1, p.depth));
        lines.push(`${indent}${this.renderPost(p)}`);
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
