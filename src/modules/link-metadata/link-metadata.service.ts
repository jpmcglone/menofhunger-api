import { fetchWebsiteMetadata } from "./website-profile-metadata";
import { fetchPickaxProfile, pickaxProfileHandle } from "./pickax-profile-metadata";
import { publicPreviewUrl } from "../../common/urls/public-preview-url";
import { isSpotifyShareUrl, resolveSpotifyShareUrl } from "./spotify-link-metadata";
import { Injectable, Logger } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { AppConfigService } from "../app/app-config.service";
import { RedisKeys } from "../redis/redis-keys";
import { CacheService } from "../redis/cache.service";
import { CacheTtl } from "../redis/cache-ttl";
import { isPickaxPostUrl, needsPickaxEnrichment } from "./pickax-link-metadata";
import { isXPostUrl } from "./x-link-metadata";
import { isRumbleVideoUrl, needsRumbleDimensionRefresh } from "./rumble-link-metadata";
import { needsYoutubeEnrichment, youtubeVideoId } from "./youtube-link-metadata";
import { X_CONNECTOR_LAUNCHED_AT, STALE_DAYS, MOH_HOSTNAME, normalizeText, buildMohSyntheticMeta, normalizeUrl, type LinkMetadataDto } from './link-metadata.constants';
import { toDto } from './link-metadata-extract';
import { fetchFromExternal } from './link-metadata-fetch';
import { fromJsonValue, toJsonInput } from '../../common/prisma/json';
import { NOT_DELETED } from '../../common/prisma/where';
export type { GroupLinkPreviewDto, LinkMetadataDto } from './link-metadata.constants';

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
        if (configured && (h === configured || h === `www.${configured}`))
          return true;
      } catch {
        /* ignore */
      }
    }
    return false;
  }

  /** Slug when `url` points at a group on a Men of Hunger host (`/g/:slug` or `/groups/:slug/...`). */
  groupSlugFromUrl(url: string): string | null {
    const normalized = normalizeUrl(url);
    if (!normalized) return null;
    const u = new URL(normalized);
    if (!this.isMohHost(u.hostname)) return null;
    const [first, slug] = u.pathname.split("/").filter(Boolean);
    if ((first !== "g" && first !== "groups") || !slug) return null;
    if (first === "groups" && ["new", "invites", "mine"].includes(slug)) return null;
    try {
      return decodeURIComponent(slug).toLowerCase();
    } catch {
      return null;
    }
  }

  /**
   * Group cards are verified-only: signed-out and unverified viewers get a locked stub that
   * reveals nothing about the group. Never cache the result in shared caches.
   */
  async getGroupPreview(
    url: string,
    slug: string,
    viewerUserId: string | null,
  ): Promise<LinkMetadataDto> {
    const base = {
      url,
      title: "Group",
      imageUrl: null,
      siteName: "Men of Hunger",
      socialPost: null,
      videoEmbed: null,
      group: null,
    };
    if (!viewerUserId) {
      return { ...base, description: "Sign in and verify to see this group.", locked: "signIn" };
    }
    const viewer = await this.prisma.user.findUnique({
      where: { id: viewerUserId },
      select: { verifiedStatus: true },
    });
    if (!viewer || !viewer.verifiedStatus || viewer.verifiedStatus === "none") {
      return { ...base, description: "Verify to see this group.", locked: "verify" };
    }
    const group = await this.prisma.communityGroup.findFirst({
      where: { slug, ...NOT_DELETED },
      select: {
        slug: true,
        name: true,
        description: true,
        avatarImageUrl: true,
        coverImageUrl: true,
        memberCount: true,
        joinPolicy: true,
      },
    });
    if (!group) return { ...base, title: "Group not found", description: null, locked: null };
    const description = group.description.trim().slice(0, 300);
    return {
      ...base,
      title: group.name,
      description,
      imageUrl: group.coverImageUrl ?? group.avatarImageUrl,
      locked: null,
      group: {
        slug: group.slug,
        name: group.name,
        description,
        avatarUrl: group.avatarImageUrl,
        coverUrl: group.coverImageUrl,
        memberCount: group.memberCount,
        joinPolicy: group.joinPolicy,
      },
    };
  }

  async getMetadata(
    url: string,
    profilePreview = false,
  ): Promise<LinkMetadataDto | null> {
    const normalized = normalizeUrl(url);
    if (!normalized || (profilePreview && !publicPreviewUrl(normalized)))
      return null;

    const pickaxHandle = profilePreview
      ? pickaxProfileHandle(normalized)
      : null;
    if (pickaxHandle) {
      const key = `pickax-profile:v1:${pickaxHandle}`;
      const result = await this.cache.getOrSetJsonWithLock<{
        meta: LinkMetadataDto | null;
      }>({
        enabled: true,
        key,
        lockKey: `${key}:lock`,
        lockTtlMs: 12000,
        lockWaitMs: 500,
        ttlSeconds: (value) => (value.meta ? 86400 : 300),
        computeAndSet: async () => {
          const saved = await this.prisma.integrationPublicSnapshot.findUnique({
            where: { key },
          });
          if (saved && saved.expiresAt > new Date())
            return { meta: fromJsonValue<LinkMetadataDto>(saved.payload) };
          try {
            const meta = await fetchPickaxProfile(pickaxHandle);
            if (meta) {
              const data = {
                kind: "pickax-profile",
                identity: pickaxHandle,
                handle: pickaxHandle,
                payload: toJsonInput(meta),
                fetchedAt: new Date(),
                expiresAt: new Date(Date.now() + 86400000),
              };
              await this.prisma.integrationPublicSnapshot.upsert({
                where: { key },
                create: { key, ...data },
                update: data,
              });
            }
            return { meta };
          } catch {
            return { meta: null };
          }
        },
        fallback: async () => ({ meta: null }),
      });
      if (result?.meta) return result.meta;
    }

    // Keep canonical URLs in the existing metadata contract; no new persisted media fields.
    if (isSpotifyShareUrl(normalized)) {
      const identity = `${normalized}:spotify-share-v1`;
      const result = await this.cache.getOrSetJsonWithLock<{
        meta: LinkMetadataDto | null;
      }>({
        enabled: true,
        key: RedisKeys.linkMeta(identity),
        lockKey: RedisKeys.linkMetaLock(identity),
        ttlSeconds: (value) =>
          value.meta
            ? CacheTtl.linkMetaFrontSeconds
            : CacheTtl.linkMetaNullSeconds,
        lockTtlMs: 8_000,
        lockWaitMs: 250,
        computeAndSet: async () => {
          try {
            const canonical = await resolveSpotifyShareUrl(
              normalized,
              AbortSignal.timeout(4_000),
            );
            if (!canonical) return { meta: null };
            const meta = await this.getMetadata(canonical);
            return {
              meta: meta ?? {
                url: canonical,
                title: "Spotify",
                description: null,
                imageUrl: null,
                siteName: "Spotify",
                socialPost: null,
                videoEmbed: null,
              },
            };
          } catch {
            return { meta: null };
          }
        },
        fallback: async () => ({ meta: null }),
      });
      return result?.meta ?? null;
    }

    // MoH internal links: return synthetic metadata immediately without hitting external
    // scrapers. Avoids caching "Login | Men of Hunger" for auth-gated pages.
    try {
      const u = new URL(normalized);
      if (this.isMohHost(u.hostname)) {
        return buildMohSyntheticMeta(normalized);
      }
    } catch {
      /* fall through */
    }

    const youtube = youtubeVideoId(normalized) != null;
    // Bypass old scraper/null results without flushing unrelated caches.
    const cacheIdentity = profilePreview
      ? `${normalized}:profile-v2`
      : youtube
        ? `${normalized}:youtube-v1`
        : normalized;
    const cacheKey = RedisKeys.linkMeta(cacheIdentity);
    const cached = await this.cache.getJson<{ meta: LinkMetadataDto | null }>(
      cacheKey,
    );
    if (cached && Object.prototype.hasOwnProperty.call(cached, "meta")) {
      const cachedMeta = cached.meta ?? null;
      const cachedNeedsPickaxEnrichment =
        isPickaxPostUrl(normalized) && needsPickaxEnrichment(cachedMeta);
      const cachedNeedsXEnrichment =
        isXPostUrl(normalized) &&
        cachedMeta != null &&
        !Object.prototype.hasOwnProperty.call(cachedMeta, "socialPost");
      const cachedNeedsRumbleRefresh =
        isRumbleVideoUrl(normalized) && needsRumbleDimensionRefresh(cachedMeta);
      if (
        !cachedNeedsPickaxEnrichment &&
        !cachedNeedsXEnrichment &&
        !cachedNeedsRumbleRefresh
      ) {
        return cachedMeta;
      }
    }

    if (profilePreview) {
      const saved = await this.prisma.integrationPublicSnapshot.findUnique({
        where: { key: cacheIdentity },
      });
      if (saved && saved.expiresAt > new Date())
        return fromJsonValue<LinkMetadataDto>(saved.payload);
    }

    const existing = await this.prisma.linkMetadata.findUnique({
      where: { url: normalized },
    });

    const staleThreshold = new Date(
      Date.now() - (profilePreview ? 1 : STALE_DAYS) * 24 * 60 * 60 * 1000,
    );
    const existingIsFresh = Boolean(
      existing && existing.updatedAt >= staleThreshold,
    );
    const existingNeedsPickaxEnrichment =
      Boolean(existing) &&
      isPickaxPostUrl(normalized) &&
      needsPickaxEnrichment(existing);
    const existingNeedsXEnrichment =
      existing != null &&
      isXPostUrl(normalized) &&
      existing.updatedAt < X_CONNECTOR_LAUNCHED_AT &&
      (!existing.socialPost ||
        typeof existing.socialPost !== "object" ||
        Array.isArray(existing.socialPost) ||
        existing.socialPost.platform !== "x");
    const existingNeedsRumbleRefresh =
      existing != null &&
      isRumbleVideoUrl(normalized) &&
      needsRumbleDimensionRefresh(toDto(existing));

    if (
      !profilePreview &&
      existingIsFresh &&
      !existingNeedsPickaxEnrichment &&
      !existingNeedsXEnrichment &&
      !existingNeedsRumbleRefresh &&
      !(youtube && needsYoutubeEnrichment(existing)) &&
      existing
    ) {
      const dto = toDto(existing);
      // Keep a short front-cache even when DB is fresh to reduce load.
      void this.cache
        .setJson(
          cacheKey,
          { meta: dto },
          { ttlSeconds: CacheTtl.linkMetaFrontSeconds },
        )
        .catch(() => undefined);
      return dto;
    }

    // Stampede protection: one fetch per URL at a time.
    const lockKey = RedisKeys.linkMetaLock(cacheIdentity);
    const pickax = isPickaxPostUrl(normalized);
    const xPost = isXPostUrl(normalized);
    const rumble = isRumbleVideoUrl(normalized);
    const wrapped = await this.cache.getOrSetJsonWithLock<{
      meta: LinkMetadataDto | null;
    }>({
      enabled: true,
      key: cacheKey,
      ttlSeconds: (value) =>
        value.meta
          ? CacheTtl.linkMetaFrontSeconds
          : CacheTtl.linkMetaNullSeconds,
      lockKey,
      lockTtlMs: profilePreview
        ? 16000
        : youtube
          ? 6_000
          : pickax
            ? 12_000
            : xPost
              ? 10_000
              : rumble
                ? 8_000
                : 4_000,
      lockWaitMs: pickax || xPost || rumble ? 500 : 250,
      computeAndSet: async () => {
        const fresh = await this.fetchAndUpsert(normalized, profilePreview);
        const dto = fresh ? toDto(fresh) : null;
        if (profilePreview && dto) {
          const data = {
            kind: "website-profile",
            identity: normalized,
            payload: toJsonInput(dto),
            fetchedAt: new Date(),
            expiresAt: new Date(Date.now() + 86400000),
          };
          await this.prisma.integrationPublicSnapshot.upsert({
            where: { key: cacheIdentity },
            create: { key: cacheIdentity, ...data },
            update: data,
          });
        }
        // Cache nulls briefly to avoid repeated external fetches for bad URLs.
        await this.cache.setJson(
          cacheKey,
          { meta: dto },
          {
            ttlSeconds: dto
              ? CacheTtl.linkMetaFrontSeconds
              : CacheTtl.linkMetaNullSeconds,
          },
        );
        return { meta: dto };
      },
      fallback: async () => {
        // If lock contention, fall back to stale DB value (if present).
        return {
          meta:
            existing && (!profilePreview || existingIsFresh)
              ? toDto(existing)
              : null,
        };
      },
    });
    return wrapped?.meta ?? null;
  }

  async previewLinks(text: string): Promise<
    Array<{
      url: string;
      title: string | null;
      description: string | null;
      siteName: string | null;
      imageUrl: string | null;
    }>
  > {
    if (!text) return [];
    const urlRegex = /https?:\/\/[^\s"'>)]+/gi;
    const found = text.match(urlRegex) ?? [];
    const urls = [
      ...new Set(
        found.map((u) => normalizeUrl(u)).filter((u): u is string => Boolean(u)),
      ),
    ].slice(0, 12);
    if (urls.length === 0) return [];
    const byUrl = new Map<
      string,
      {
        url: string;
        title: string | null;
        description: string | null;
        siteName: string | null;
        imageUrl: string | null;
      }
    >();
    try {
      const rows = await this.prisma.linkMetadata.findMany({
        where: { url: { in: urls } },
        select: {
          url: true,
          title: true,
          description: true,
          siteName: true,
          imageUrl: true,
        },
      });
      for (const r of rows) {
        byUrl.set(r.url, {
          url: r.url,
          title: normalizeText(r.title),
          description: normalizeText(r.description),
          siteName: normalizeText(r.siteName),
          imageUrl: normalizeText(r.imageUrl),
        });
      }
    } catch (err) {
      this.logger.warn(
        `[link-metadata] previewLinks DB error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const missing = urls.filter((url) => !byUrl.has(url)).slice(0, 8);
    await Promise.all(
      missing.map(async (url) => {
        try {
          const meta = await this.getMetadata(url);
          if (!meta) return;
          byUrl.set(url, {
            url: meta.url,
            title: normalizeText(meta.title),
            description: normalizeText(meta.description),
            siteName: normalizeText(meta.siteName),
            imageUrl: normalizeText(meta.imageUrl),
          });
        } catch {
          // Keep the raw URL even when the fetch fails.
        }
      }),
    );
    return urls.map(
      (url) =>
        byUrl.get(url) ?? {
          url,
          title: null,
          description: null,
          siteName: null,
          imageUrl: null,
        },
    );
  }

  private async fetchAndUpsert(url: string, profilePreview = false) {
    try {
      const direct = profilePreview
        ? await fetchWebsiteMetadata(url).catch(() => null)
        : null;
      const meta = direct ?? (await fetchFromExternal(url));
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
            ? toJsonInput(meta.socialPost)
            : Prisma.JsonNull,
          videoEmbed: meta.videoEmbed
            ? toJsonInput(meta.videoEmbed)
            : Prisma.JsonNull,
        },
        update: {
          title: meta.title,
          description: meta.description,
          imageUrl: meta.imageUrl,
          siteName: meta.siteName,
          socialPost: meta.socialPost
            ? toJsonInput(meta.socialPost)
            : Prisma.JsonNull,
          videoEmbed: meta.videoEmbed
            ? toJsonInput(meta.videoEmbed)
            : Prisma.JsonNull,
        },
      });
      return upserted;
    } catch (err) {
      this.logger.warn(
        `Failed to fetch link metadata for ${url}: ${(err as Error).message}`,
      );
      return null;
    }
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
      const staleThreshold = new Date(
        Date.now() - STALE_DAYS * 24 * 60 * 60 * 1000,
      );
      if (existing && existing.updatedAt >= staleThreshold) continue;

      const result = await this.fetchAndUpsert(normalized);
      if (result) cached += 1;
    }
    return cached;
  }
}
