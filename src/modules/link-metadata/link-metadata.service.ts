import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfigService } from '../app/app-config.service';
import { RedisKeys } from '../redis/redis-keys';
import { CacheService } from '../redis/cache.service';
import { CacheTtl } from '../redis/cache-ttl';
import {
  isPickaxGatedMarkdown,
  isPickaxPostUrl,
  isWeakPickaxImage,
  needsPickaxEnrichment,
  parsePickaxAuthorFromJina,
  parsePickaxBodyFromJina,
  pickaxAuthorFromTitle,
} from './pickax-link-metadata';
import {
  isXPostUrl,
  parseXSyndicationResponse,
  parseXPostUrl,
  type SocialPostMetadataDto,
  xSyndicationToken,
} from './x-link-metadata';
import { isRumbleVideoUrl, enrichRumbleVideo, type VideoEmbedDto } from './rumble-link-metadata';
import { isSubstackPostUrl, enrichSubstackPost } from './substack-link-metadata';

export type LinkMetadataDto = {
  url: string;
  title: string | null;
  description: string | null;
  imageUrl: string | null;
  siteName: string | null;
  socialPost: SocialPostMetadataDto | null;
  videoEmbed: VideoEmbedDto | null;
};

const FETCH_TIMEOUT_MS = 2000;
/** Pickax post pages need a longer scrape window to recover avatar + @handle. */
const PICKAX_ENRICH_TIMEOUT_MS = 8_000;
const X_ENRICH_TIMEOUT_MS = 6_000;
const SUBSTACK_ENRICH_TIMEOUT_MS = 6_000;
const X_CONNECTOR_LAUNCHED_AT = new Date('2026-07-16T00:00:00.000Z');
const STALE_DAYS = 7;
/** Keyset pagination page size when scanning recent posts during backfill. */
const BACKFILL_POST_PAGE_SIZE = 500;
/** Hard cap on posts scanned per backfill run to bound memory/DB pressure. */
const BACKFILL_MAX_POSTS = 20_000;
/** Hard cap on distinct URLs fetched per backfill run. */
const BACKFILL_MAX_URLS = 2_000;

// ─── MoH internal URL handling ───────────────────────────────────────────────
// When someone shares a menofhunger.com link, we skip external scraping entirely
// (which would hit a login-redirect and cache "Login | Men of Hunger") and instead
// synthesize clean, accurate metadata from the URL path.

const MOH_HOSTNAME = 'menofhunger.com';

function getMohPageTitle(pathname: string): string {
  const parts = pathname.split('/').filter(Boolean);
  const s0 = parts[0] ?? '';
  const s1 = parts[1] ?? '';

  if (!s0 || s0 === 'login' || s0 === 'index') return 'Men of Hunger';
  if (s0 === 'home') return 'Home';
  if (s0 === 'u' && s1) return `@${s1}`;
  if (s0 === 'p') return 'Post';
  if (s0 === 'a') return 'Article';
  if (s0 === 'spaces' || s0 === 's') return 'Space';
  if (s0 === 'admin') return 'Admin';

  if (s0 === 'settings') {
    if (!s1) return 'Settings';
    const settingsLabels: Record<string, string> = {
      billing: 'Billing', account: 'Account', notifications: 'Notifications',
      verification: 'Verification', profile: 'Profile', privacy: 'Privacy',
    };
    const label = settingsLabels[s1] ?? (s1.charAt(0).toUpperCase() + s1.slice(1));
    return `${label} · Settings`;
  }

  const topLabels: Record<string, string> = {
    notifications: 'Notifications', messages: 'Messages', discover: 'Discover',
    groups: 'Groups', search: 'Search', coins: 'Coins', earn: 'Earn',
    checkins: 'Check-ins', explore: 'Explore', leaderboard: 'Leaderboard',
  };
  if (topLabels[s0]) return topLabels[s0]!;

  // Fallback: capitalize each path segment, join with ·
  return parts.map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join(' · ');
}

function buildMohSyntheticMeta(url: string): LinkMetadataDto {
  try {
    const u = new URL(url);
    return {
      url,
      title: getMohPageTitle(u.pathname),
      description: null,
      imageUrl: null,
      siteName: 'Men of Hunger',
      socialPost: null,
      videoEmbed: null,
    };
  } catch {
    return {
      url,
      title: 'Men of Hunger',
      description: null,
      imageUrl: null,
      siteName: 'Men of Hunger',
      socialPost: null,
      videoEmbed: null,
    };
  }
}

type MicrolinkResponse = {
  status: 'success' | 'error';
  data?: {
    url?: string;
    title?: string;
    description?: string;
    publisher?: string;
    author?: string;
    image?: { url?: string } | { url?: string }[];
  };
};

function normalizeText(v: string | null | undefined): string | null {
  const s = (v ?? '').trim();
  return s ? s : null;
}

function normalizeUrl(raw: string): string | null {
  const s = (raw ?? '').trim();
  if (!s) return null;
  try {
    const u = new URL(s);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.toString();
  } catch {
    return null;
  }
}

@Injectable()
export class LinkMetadataService {
  private readonly logger = new Logger(LinkMetadataService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
    private readonly appConfig: AppConfigService,
  ) {}

  /** Returns true if the hostname is a MoH-owned domain (production or dev). */
  private isMohHost(hostname: string): boolean {
    const h = hostname.toLowerCase();
    if (h === MOH_HOSTNAME || h === `www.${MOH_HOSTNAME}`) return true;
    // Also match the configured frontend base URL (covers staging / custom domains).
    const configuredBase = this.appConfig.frontendBaseUrl();
    if (configuredBase) {
      try {
        const configured = new URL(configuredBase).hostname.toLowerCase();
        if (configured && (h === configured || h === `www.${configured}`)) return true;
      } catch { /* ignore */ }
    }
    return false;
  }

  async getMetadata(url: string): Promise<LinkMetadataDto | null> {
    const normalized = normalizeUrl(url);
    if (!normalized) return null;

    // MoH internal links: return synthetic metadata immediately without hitting external
    // scrapers. Avoids caching "Login | Men of Hunger" for auth-gated pages.
    try {
      const u = new URL(normalized);
      if (this.isMohHost(u.hostname)) {
        return buildMohSyntheticMeta(normalized);
      }
    } catch { /* fall through */ }

    const cacheKey = RedisKeys.linkMeta(normalized);
    const cached = await this.cache.getJson<{ meta: LinkMetadataDto | null }>(cacheKey);
    if (cached && Object.prototype.hasOwnProperty.call(cached, 'meta')) {
      const cachedMeta = cached.meta ?? null;
      const cachedNeedsPickaxEnrichment =
        isPickaxPostUrl(normalized) && needsPickaxEnrichment(cachedMeta);
      const cachedNeedsXEnrichment =
        isXPostUrl(normalized) &&
        cachedMeta != null &&
        !Object.prototype.hasOwnProperty.call(cachedMeta, 'socialPost');
      if (!cachedNeedsPickaxEnrichment && !cachedNeedsXEnrichment) {
        return cachedMeta;
      }
    }

    const existing = await this.prisma.linkMetadata.findUnique({
      where: { url: normalized },
    });

    const staleThreshold = new Date(Date.now() - STALE_DAYS * 24 * 60 * 60 * 1000);
    const existingIsFresh = Boolean(existing && existing.updatedAt >= staleThreshold);
    const existingNeedsPickaxEnrichment =
      Boolean(existing) &&
      isPickaxPostUrl(normalized) &&
      needsPickaxEnrichment(existing);
    const existingNeedsXEnrichment =
      existing != null &&
      isXPostUrl(normalized) &&
      existing.updatedAt < X_CONNECTOR_LAUNCHED_AT &&
      (!existing.socialPost ||
        typeof existing.socialPost !== 'object' ||
        Array.isArray(existing.socialPost) ||
        existing.socialPost.platform !== 'x');

    if (
      existingIsFresh &&
      !existingNeedsPickaxEnrichment &&
      !existingNeedsXEnrichment &&
      existing
    ) {
      const dto = this.toDto(existing);
      // Keep a short front-cache even when DB is fresh to reduce load.
      void this.cache.setJson(cacheKey, { meta: dto }, { ttlSeconds: CacheTtl.linkMetaFrontSeconds }).catch(() => undefined);
      return dto;
    }

    // Stampede protection: one fetch per URL at a time.
    const lockKey = RedisKeys.linkMetaLock(normalized);
    const pickax = isPickaxPostUrl(normalized);
    const xPost = isXPostUrl(normalized);
    const wrapped = await this.cache.getOrSetJsonWithLock<{ meta: LinkMetadataDto | null }>({
      enabled: true,
      key: cacheKey,
      ttlSeconds: CacheTtl.linkMetaFrontSeconds,
      lockKey,
      lockTtlMs: pickax ? 12_000 : xPost ? 10_000 : 4_000,
      lockWaitMs: pickax || xPost ? 500 : 250,
      computeAndSet: async () => {
        const fresh = await this.fetchAndUpsert(normalized);
        const dto = fresh ? this.toDto(fresh) : null;
        // Cache nulls briefly to avoid repeated external fetches for bad URLs.
        await this.cache.setJson(
          cacheKey,
          { meta: dto },
          { ttlSeconds: dto ? CacheTtl.linkMetaFrontSeconds : CacheTtl.linkMetaNullSeconds },
        );
        return { meta: dto };
      },
      fallback: async () => {
        // If lock contention, fall back to stale DB value (if present).
        return { meta: existing ? this.toDto(existing) : null };
      },
    });
    return wrapped?.meta ?? null;
  }

  private toDto(row: {
    url: string;
    title: string | null;
    description: string | null;
    imageUrl: string | null;
    siteName: string | null;
    socialPost: Prisma.JsonValue;
    videoEmbed?: Prisma.JsonValue;
  }): LinkMetadataDto {
    return {
      url: row.url,
      title: normalizeText(row.title),
      description: normalizeText(row.description),
      imageUrl: normalizeText(row.imageUrl),
      siteName: normalizeText(row.siteName),
      socialPost:
        row.socialPost && typeof row.socialPost === 'object' && !Array.isArray(row.socialPost)
          ? (row.socialPost as unknown as SocialPostMetadataDto)
          : null,
      videoEmbed:
        row.videoEmbed && typeof row.videoEmbed === 'object' && !Array.isArray(row.videoEmbed)
          ? (row.videoEmbed as unknown as VideoEmbedDto)
          : null,
    };
  }

  /**
   * Read-only URL preview lookup for Marv. Extracts up to 5 http(s) URLs from `text`,
   * fetches any that are already cached in the `LinkMetadata` table (no external fetch,
   * no Redis write), and returns up to 3 results with title/description/siteName.
   *
   * Silent-fail: any DB error returns [].
   */
  async previewLinks(text: string): Promise<Array<{ url: string; title: string | null; description: string | null; siteName: string | null }>> {
    if (!text) return [];
    const urlRegex = /https?:\/\/[^\s"'>)]+/gi;
    const found = text.match(urlRegex) ?? [];
    const urls = found
      .map((u) => normalizeUrl(u))
      .filter((u): u is string => Boolean(u))
      .slice(0, 5);
    if (urls.length === 0) return [];
    try {
      const rows = await this.prisma.linkMetadata.findMany({
        where: { url: { in: urls } },
        select: { url: true, title: true, description: true, siteName: true },
        take: 3,
      });
      return rows.map((r) => ({
        url: r.url,
        title: normalizeText(r.title),
        description: normalizeText(r.description),
        siteName: normalizeText(r.siteName),
      }));
    } catch (err) {
      this.logger.warn(`[link-metadata] previewLinks DB error: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  private async fetchAndUpsert(url: string) {
    try {
      const meta = await this.fetchFromExternal(url);
      if (!meta) return null;

      const upserted = await this.prisma.linkMetadata.upsert({
        where: { url },
        create: {
          url,
          title: meta.title,
          description: meta.description,
          imageUrl: meta.imageUrl,
          siteName: meta.siteName,
          socialPost: meta.socialPost
            ? (meta.socialPost as unknown as Prisma.InputJsonValue)
            : Prisma.JsonNull,
          videoEmbed: meta.videoEmbed
            ? (meta.videoEmbed as unknown as Prisma.InputJsonValue)
            : Prisma.JsonNull,
        },
        update: {
          title: meta.title,
          description: meta.description,
          imageUrl: meta.imageUrl,
          siteName: meta.siteName,
          socialPost: meta.socialPost
            ? (meta.socialPost as unknown as Prisma.InputJsonValue)
            : Prisma.JsonNull,
          videoEmbed: meta.videoEmbed
            ? (meta.videoEmbed as unknown as Prisma.InputJsonValue)
            : Prisma.JsonNull,
        },
      });
      return upserted;
    } catch (err) {
      this.logger.warn(`Failed to fetch link metadata for ${url}: ${(err as Error).message}`);
      return null;
    }
  }

  private async fetchFromExternal(url: string): Promise<LinkMetadataDto | null> {
    const controller = new AbortController();
    const timeoutMs = isPickaxPostUrl(url)
      ? PICKAX_ENRICH_TIMEOUT_MS
      : isXPostUrl(url)
        ? X_ENRICH_TIMEOUT_MS
        : isSubstackPostUrl(url)
          ? SUBSTACK_ENRICH_TIMEOUT_MS
          : FETCH_TIMEOUT_MS;
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const u = new URL(url);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;

      let base: LinkMetadataDto | null = null;
      const pickaxPost = isPickaxPostUrl(u.toString());
      let pickaxPartial: LinkMetadataDto | null = null;

      if (isXPostUrl(u.toString())) {
        const xMetadata = await this.enrichXPost(u.toString(), controller.signal);
        if (xMetadata) return xMetadata;
      }

      if (isRumbleVideoUrl(u.toString())) {
        const videoEmbed = await enrichRumbleVideo(u.toString(), controller.signal);
        if (videoEmbed) {
          return {
            url: u.toString(),
            title: null,
            description: null,
            imageUrl: videoEmbed.thumbnailUrl,
            siteName: 'Rumble',
            socialPost: null,
            videoEmbed,
          };
        }
      }

      if (isSubstackPostUrl(u.toString())) {
        const enriched = await enrichSubstackPost(u.toString(), controller.signal);
        if (enriched) {
          return {
            url: u.toString(),
            title: null,
            description: null,
            imageUrl: null,
            siteName: null,
            ...enriched,
            socialPost: null,
            videoEmbed: null,
          };
        }
      }

      // Jina is the only public source that provides the complete Pickax body and,
      // when available, author avatar/handle. Give it the full timeout budget
      // instead of spending most of that budget on weak OG metadata first.
      if (pickaxPost) {
        pickaxPartial = await this.enrichPickaxPost(u.toString(), null, controller.signal);
        if (pickaxPartial?.description) return pickaxPartial;
      }

      try {
        const microlinkUrl = `https://api.microlink.io/?url=${encodeURIComponent(u.toString())}&screenshot=false`;
        const r = await fetch(microlinkUrl, { method: 'GET', signal: controller.signal });
        if (r.ok) {
          const json = (await r.json()) as MicrolinkResponse;
          if (json?.status === 'success' && json.data) {
            const img =
              Array.isArray(json.data.image) ? json.data.image?.[0]?.url : (json.data.image as { url?: string } | undefined)?.url;
            base = {
              url: normalizeText(json.data.url ?? null) ?? u.toString(),
              title: normalizeText(json.data.title ?? null),
              description: normalizeText(json.data.description ?? null),
              siteName: normalizeText(json.data.publisher ?? null) ?? normalizeText(json.data.author ?? null),
              imageUrl: normalizeText(img ?? null),
              socialPost: null,
              videoEmbed: null,
            };
          }
        }
      } catch {
        // fall through to Jina
      }

      // Pickax OG tags only expose favicon + "Name posted". Scrape the readable page for
      // the author avatar and @handle so clients can render a post-like card.
      if (pickaxPost) {
        if (pickaxPartial) {
          return {
            ...base,
            ...pickaxPartial,
            description: pickaxPartial.description ?? base?.description ?? null,
          };
        }
        if (base) {
          return {
            ...base,
            title: pickaxAuthorFromTitle(base.title) ?? base.title,
            siteName: 'Pickax',
            imageUrl: isWeakPickaxImage(base.imageUrl) ? null : base.imageUrl,
          };
        }
      } else if (base) {
        return base;
      }

      const proxied = `https://r.jina.ai/${u.toString()}`;
      const res = await fetch(proxied, { method: 'GET', signal: controller.signal });
      if (!res.ok) return null;
      const md = await res.text();

      const titleMatch = (md ?? '').toString().match(/^\s*Title:\s*(.+)\s*$/m);
      const title = normalizeText(titleMatch?.[1] ?? null);
      const imageMatch = (md ?? '').toString().match(/!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/i);
      const imageUrl = normalizeText(imageMatch?.[1] ?? null);

      return {
        url: u.toString(),
        title,
        description: null,
        siteName: normalizeText(u.hostname.replace(/^www\./, '')) ?? null,
        imageUrl,
        socialPost: null,
        videoEmbed: null,
      };
    } catch (err) {
      const name = (err as { name?: string })?.name;
      if (name === 'AbortError' || name === 'TimeoutError') return null;
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async enrichXPost(
    url: string,
    signal: AbortSignal,
  ): Promise<LinkMetadataDto | null> {
    try {
      const parsed = parseXPostUrl(url);
      if (!parsed) return null;
      const token = xSyndicationToken(parsed.id);
      const response = await fetch(
        `https://cdn.syndication.twimg.com/tweet-result?id=${encodeURIComponent(parsed.id)}&lang=en&token=${encodeURIComponent(token)}`,
        {
          method: 'GET',
          headers: { Accept: 'application/json' },
          signal,
        },
      );
      if (!response.ok) return null;
      const socialPost = parseXSyndicationResponse(await response.json(), url);
      if (!socialPost) return null;
      return {
        url: parsed.canonicalUrl,
        title: socialPost.author.name,
        description: socialPost.text,
        imageUrl: socialPost.author.avatarUrl,
        siteName: 'X',
        socialPost,
        videoEmbed: null,
      };
    } catch (error) {
      const name = (error as { name?: string })?.name;
      if (name === 'AbortError' || name === 'TimeoutError') return null;
      this.logger.warn(
        `[link-metadata] X enrichment failed for ${url}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
  }

  private async enrichPickaxPost(
    url: string,
    base: LinkMetadataDto | null,
    signal: AbortSignal,
  ): Promise<LinkMetadataDto | null> {
    try {
      const proxied = `https://r.jina.ai/${url}`;
      const res = await fetch(proxied, { method: 'GET', signal });
      if (!res.ok) return null;
      const md = await res.text();
      if (isPickaxGatedMarkdown(md)) return null;
      const titleMatch = (md ?? '').toString().match(/^\s*Title:\s*(.+)\s*$/m);
      const titleFromJina = normalizeText(titleMatch?.[1] ?? null);
      const { avatarUrl, username } = parsePickaxAuthorFromJina(md);
      const authorName =
        pickaxAuthorFromTitle(titleFromJina) ??
        pickaxAuthorFromTitle(base?.title) ??
        normalizeText(username);
      const bodyFromJina = parsePickaxBodyFromJina(md);

      return {
        url,
        title: authorName,
        // Prefer the scraped body; OG/microlink descriptions are often truncated.
        description: bodyFromJina ?? base?.description ?? null,
        // Prefer @handle in siteName so clients can render a post-like subtitle.
        siteName: username ? `@${username}` : 'Pickax',
        imageUrl: avatarUrl ?? (isWeakPickaxImage(base?.imageUrl) ? null : (base?.imageUrl ?? null)),
        socialPost: null,
        videoEmbed: null,
      };
    } catch {
      return null;
    }
  }

  /** Extracts links from post body text (for cron backfill). Uses same logic as www extractLinksFromText. */
  extractLinks(text: string): string[] {
    const input = (text ?? '').toString();
    const urlPattern = /https?:\/\/[^\s<>"')\]]+/gi;
    const matches = input.match(urlPattern) ?? [];
    const out: string[] = [];
    const seen = new Set<string>();
    for (const m of matches) {
      const url = (m ?? '').trim();
      if (!url) continue;
      try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue;
        const norm = parsed.toString();
        if (seen.has(norm)) continue;
        seen.add(norm);
        out.push(norm);
      } catch {
        // skip invalid URLs
      }
    }
    return out;
  }

  /**
   * Run backfill for recent posts: extract links from last 7 days, fetch and cache.
   *
   * Uses keyset pagination (BACKFILL_POST_PAGE_SIZE at a time) and hard caps on
   * total posts scanned and URLs collected, so a large recent-post volume cannot
   * blow up memory or the DB.
   */
  async runBackfill(): Promise<{ urlsFound: number; cached: number; truncated: boolean }> {
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const seen = new Set<string>();

    let cursorCreatedAt: Date | null = null;
    let cursorId: string | null = null;
    let postsScanned = 0;
    let truncated = false;

    while (postsScanned < BACKFILL_MAX_POSTS && seen.size < BACKFILL_MAX_URLS) {
      const baseWhere = {
        deletedAt: null,
        body: { not: '' },
        createdAt: { gte: since },
      } as const;

      const pageWhere =
        cursorCreatedAt && cursorId
          ? {
              ...baseWhere,
              OR: [
                { createdAt: { lt: cursorCreatedAt } },
                { AND: [{ createdAt: cursorCreatedAt }, { id: { lt: cursorId } }] },
              ],
            }
          : baseWhere;

      const posts: Array<{ id: string; createdAt: Date; body: string }> =
        await this.prisma.post.findMany({
          where: pageWhere,
          select: { id: true, createdAt: true, body: true },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: BACKFILL_POST_PAGE_SIZE,
        });

      if (posts.length === 0) break;

      for (const p of posts) {
        for (const url of this.extractLinks(p.body ?? '')) {
          seen.add(url);
          if (seen.size >= BACKFILL_MAX_URLS) {
            truncated = true;
            break;
          }
        }
        if (seen.size >= BACKFILL_MAX_URLS) break;
      }

      postsScanned += posts.length;
      const last = posts[posts.length - 1];
      if (!last) break;
      cursorCreatedAt = last.createdAt;
      cursorId = last.id;

      if (posts.length < BACKFILL_POST_PAGE_SIZE) break;
    }

    if (postsScanned >= BACKFILL_MAX_POSTS) truncated = true;

    const urls = Array.from(seen);
    const cached = await this.backfillForUrls(urls);
    return { urlsFound: urls.length, cached, truncated };
  }

  /** Backfill: fetch metadata for URLs not yet in DB. Returns count of newly cached URLs. */
  async backfillForUrls(urls: string[]): Promise<number> {
    let cached = 0;
    for (const url of urls) {
      const normalized = normalizeUrl(url);
      if (!normalized) continue;

      const existing = await this.prisma.linkMetadata.findUnique({
        where: { url: normalized },
      });
      const staleThreshold = new Date(Date.now() - STALE_DAYS * 24 * 60 * 60 * 1000);
      if (existing && existing.updatedAt >= staleThreshold) continue;

      const result = await this.fetchAndUpsert(normalized);
      if (result) cached += 1;
    }
    return cached;
  }
}
