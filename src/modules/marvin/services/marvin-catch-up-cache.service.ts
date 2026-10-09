import { Inject } from '@nestjs/common';
import { PostsFeedLookupService } from '../../posts/posts-feed-lookup.service';
import { Injectable, Logger } from '@nestjs/common';
import type { MarvinMode } from '@prisma/client';
import { AppConfigService } from '../../app/app-config.service';

import { PrismaService } from '../../prisma/prisma.service';
import { CacheService } from '../../redis/cache.service';
import type { MarvinCatchUpDto } from '../../../common/dto/marvin';
import { MarvinThreadContextService, type MarvThreadContext, type MarvThreadContextPost } from './marvin-thread-context.service';

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
export type FreshnessMarker = { totalDescendants: number; latestMs: number };

/**
 * What actually lives in Redis: the summary plus the thread state it was generated against.
 * The marker is stored in the VALUE rather than baked into the key so a changed thread can
 * still find (and soft-serve) the previous summary. Keying by marker made a single new reply
 * orphan a paid summary and drop the user back onto a paywall with no context.
 */
export type CachedCatchUp = { dto: MarvinCatchUpDto; marker: FreshnessMarker };

/** A cache read that's worth serving, with how far the thread has drifted since. */
export type CacheReadHit = { dto: MarvinCatchUpDto; stale: boolean; newReplies: number };

/**
 * Marker that changes when: a reply is added/removed, any visible post is edited
 * (updatedAt), or the focal post itself changes. Covers edits to the focal post, ancestors,
 * or any descendant — so a summary is never silently presented as current after a
 * meaningful thread update.
 */
export function freshnessMarker(context: MarvThreadContext): FreshnessMarker {
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
export function freshnessMarkerToken(marker: FreshnessMarker): string {
  return `${marker.totalDescendants}-${marker.latestMs}`;
}

/** Stored catch-up summaries: envelope guard, freshness evaluation, soft-stale serving, and the free peek. */
@Injectable()
export class MarvinCatchUpCacheService {
  private readonly logger = new Logger(MarvinCatchUpCacheService.name);

  constructor(
    private readonly appConfig: AppConfigService,
    private readonly cache: CacheService,
    private readonly context: MarvinThreadContextService,
    @Inject(PostsFeedLookupService) private readonly postsLookup: Pick<PostsFeedLookupService, 'getById'>,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Fetch the stored envelope, guarding the shape. Entries written before the marker moved
   * into the value have no `.marker` and can't be compared against the current thread, so
   * they're treated as absent; they expire on their own.
   */
  async readCachedEnvelope(cacheKey: string): Promise<CachedCatchUp | null> {
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
  evaluateCached(entry: CachedCatchUp, current: FreshnessMarker): CacheReadHit | null {
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
  async writeCached(cacheKey: string, dto: MarvinCatchUpDto, marker: FreshnessMarker): Promise<void> {
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

      const requestedMode: MarvinMode =
        params.requestedMode ?? settings?.preferredMode ?? "auto";

      // Visibility: resolve through PostsFeedLookupService so we never peek a cache key for a post the
      // viewer can't see. Any access error → treat as "nothing cached".
      const _post = await this.postsLookup.getById({
        viewerUserId: userId,
        id: postId,
      });

      const context = await this.context.collect({ focalPostId: postId });
      const marker = freshnessMarker(context);
      const imgToken = includeImages ? "img" : "noimg";
      const cacheKey = `marv:catchup:${postId}:${requestedMode}:${imgToken}`;
      const entry = await this.readCachedEnvelope(cacheKey);
      const hit = entry ? this.evaluateCached(entry, marker) : null;
      if (!hit) return null;

      this.logger.log(
        `[marv] catch-up PEEK hit post=${postId} mode=${requestedMode} stale=${hit.stale} newReplies=${hit.newReplies}`,
      );
      return hit.dto;
    } catch (err) {
      this.logger.debug(
        `[marv] catch-up PEEK error post=${postId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }
}
