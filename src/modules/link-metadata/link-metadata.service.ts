import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfigService } from '../app/app-config.service';
import { RedisKeys } from '../redis/redis-keys';
import { CacheService } from '../redis/cache.service';
import { CacheTtl } from '../redis/cache-ttl';

export type LinkMetadataDto = {
  url: string;
  title: string | null;
  description: string | null;
  imageUrl: string | null;
  siteName: string | null;
};

const FETCH_TIMEOUT_MS = 2000;
const STALE_DAYS = 7;

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
    };
  } catch {
    return { url, title: 'Men of Hunger', description: null, imageUrl: null, siteName: 'Men of Hunger' };
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
      return cached.meta ?? null;
    }

    const existing = await this.prisma.linkMetadata.findUnique({
      where: { url: normalized },
    });

    const staleThreshold = new Date(Date.now() - STALE_DAYS * 24 * 60 * 60 * 1000);
    if (existing && existing.updatedAt >= staleThreshold) {
      const dto = this.toDto(existing);
      // Keep a short front-cache even when DB is fresh to reduce load.
      void this.cache.setJson(cacheKey, { meta: dto }, { ttlSeconds: CacheTtl.linkMetaFrontSeconds }).catch(() => undefined);
      return dto;
    }

    // Stampede protection: one fetch per URL at a time.
    const lockKey = RedisKeys.linkMetaLock(normalized);
    const wrapped = await this.cache.getOrSetJsonWithLock<{ meta: LinkMetadataDto | null }>({
      enabled: true,
      key: cacheKey,
      ttlSeconds: CacheTtl.linkMetaFrontSeconds,
      lockKey,
      lockTtlMs: 4_000,
      lockWaitMs: 250,
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

  private toDto(row: { url: string; title: string | null; description: string | null; imageUrl: string | null; siteName: string | null }): LinkMetadataDto {
    return {
      url: row.url,
      title: normalizeText(row.title),
      description: normalizeText(row.description),
      imageUrl: normalizeText(row.imageUrl),
      siteName: normalizeText(row.siteName),
    };
  }

  private async fetchAndUpsert(url: string): Promise<{ url: string; title: string | null; description: string | null; imageUrl: string | null; siteName: string | null } | null> {
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
        },
        update: {
          title: meta.title,
          description: meta.description,
          imageUrl: meta.imageUrl,
          siteName: meta.siteName,
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
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
      const u = new URL(url);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;

      try {
        const microlinkUrl = `https://api.microlink.io/?url=${encodeURIComponent(u.toString())}&screenshot=false`;
        const r = await fetch(microlinkUrl, { method: 'GET', signal: controller.signal });
        if (r.ok) {
          const json = (await r.json()) as MicrolinkResponse;
          if (json?.status === 'success' && json.data) {
            const img =
              Array.isArray(json.data.image) ? json.data.image?.[0]?.url : (json.data.image as { url?: string } | undefined)?.url;
            return {
              url: normalizeText(json.data.url ?? null) ?? u.toString(),
              title: normalizeText(json.data.title ?? null),
              description: normalizeText(json.data.description ?? null),
              siteName: normalizeText(json.data.publisher ?? null) ?? normalizeText(json.data.author ?? null),
              imageUrl: normalizeText(img ?? null),
            } as LinkMetadataDto;
          }
        }
      } catch {
        // fall through to Jina
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
      };
    } catch (err) {
      const name = (err as { name?: string })?.name;
      if (name === 'AbortError' || name === 'TimeoutError') return null;
      throw err;
    } finally {
      clearTimeout(timeout);
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

  /** Run backfill for recent posts: extract links from last 7 days, fetch and cache. */
  async runBackfill(): Promise<{ urlsFound: number; cached: number }> {
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const posts = await this.prisma.post.findMany({
      where: {
        deletedAt: null,
        body: { not: '' },
        createdAt: { gte: since },
      },
      select: { body: true },
    });
    const seen = new Set<string>();
    for (const p of posts) {
      for (const url of this.extractLinks(p.body ?? '')) {
        seen.add(url);
      }
    }
    const urls = Array.from(seen);
    const cached = await this.backfillForUrls(urls);
    return { urlsFound: urls.length, cached };
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
