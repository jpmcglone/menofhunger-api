import { Logger } from '@nestjs/common';

const log = new Logger('RumbleLinkMetadata');

export type VideoEmbedSizedBy = 'embedjs' | 'oembed';

export type VideoEmbedDto = {
  platform: 'rumble';
  embedUrl: string;
  thumbnailUrl: string | null;
  width: number;
  height: number;
  /** How width/height were chosen. Omitted on pre-embedJS cache rows. */
  sizedBy?: VideoEmbedSizedBy;
};

function normalizeRumbleHost(hostname: string): string {
  return hostname.replace(/^www\./i, '').toLowerCase();
}

export function isRumbleVideoUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return normalizeRumbleHost(u.hostname) === 'rumble.com';
  } catch {
    return false;
  }
}

function normalizeEmbedUrl(url: string): string | null {
  try {
    const u = new URL(url);
    const host = normalizeRumbleHost(u.hostname);
    if (host !== 'rumble.com') return null;
    if (!u.pathname.startsWith('/embed/')) return null;
    if (!u.pathname.endsWith('/')) u.pathname = `${u.pathname}/`;
    u.protocol = 'https:';
    return u.toString();
  } catch {
    return null;
  }
}

function extractIframeSrc(html: string): string | null {
  const m = (html ?? '').toString().match(/<iframe[^>]+src="([^"]+)"[^>]*>/i);
  return m?.[1] ?? null;
}

/** Embed id from `/embed/v456is6/` or `/embed/u4nvf6q.v70bqqu/` (last dotted segment). */
export function rumbleEmbedIdFromUrl(url: string): string | null {
  try {
    const u = new URL(url);
    if (normalizeRumbleHost(u.hostname) !== 'rumble.com') return null;
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts[0] !== 'embed' || !parts[1]) return null;
    const segments = parts[1].split('.').filter(Boolean);
    const id = segments[segments.length - 1];
    return id && /^[a-z0-9]+$/i.test(id) ? id : null;
  } catch {
    return null;
  }
}

/**
 * Encoded file size from embedJS JSON. Prefer top-level `w`/`h` — do not use the
 * `t` thumbnail array (landscape videos often include both 16:9 and 9:16 thumbs).
 */
export function dimensionsFromEmbedJs(data: unknown): { width: number; height: number } | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const rec = data as Record<string, unknown>;
  const w = Number(rec.w);
  const h = Number(rec.h);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
  return { width: Math.floor(w), height: Math.floor(h) };
}

/** Legacy rumble rows predate embedJS sizing and should be re-fetched once. */
export function needsRumbleDimensionRefresh(meta: {
  videoEmbed?: VideoEmbedDto | null;
} | null): boolean {
  const embed = meta?.videoEmbed;
  if (!embed || embed.platform !== 'rumble') return false;
  return embed.sizedBy !== 'embedjs' && embed.sizedBy !== 'oembed';
}

async function fetchEmbedJsDimensions(
  embedId: string,
  signal: AbortSignal,
): Promise<{ width: number; height: number } | null> {
  const endpoint = new URL('https://rumble.com/embedJS/u3/');
  endpoint.searchParams.set('request', 'video');
  endpoint.searchParams.set('v', embedId);
  const res = await fetch(endpoint.toString(), { method: 'GET', signal });
  if (!res.ok) {
    log.warn(`Rumble embedJS returned ${res.status} for ${embedId}`);
    return null;
  }
  return dimensionsFromEmbedJs(await res.json());
}

/**
 * Fetch Rumble oEmbed server-side (no CORS restriction) and return a
 * `VideoEmbedDto` for storage in `LinkMetadata.videoEmbed`.
 *
 * oEmbed width/height is the player chrome, often 16:9 even for portrait files.
 * embedJS `w`/`h` is the encoded video — prefer that when present.
 */
export async function enrichRumbleVideo(
  pageUrl: string,
  signal: AbortSignal,
): Promise<VideoEmbedDto | null> {
  try {
    const u = new URL(pageUrl);
    if (normalizeRumbleHost(u.hostname) !== 'rumble.com') return null;

    let embedUrl: string | null = null;
    let fallbackWidth = 854;
    let fallbackHeight = 480;
    let thumbnailUrl: string | null = null;

    const directEmbed = normalizeEmbedUrl(pageUrl);
    if (directEmbed) {
      embedUrl = directEmbed;
    } else {
      const endpoint = new URL('https://rumble.com/api/Media/oembed.json');
      endpoint.searchParams.set('url', u.toString());

      const res = await fetch(endpoint.toString(), { method: 'GET', signal });
      if (!res.ok) {
        log.warn(`Rumble oEmbed returned ${res.status} for ${pageUrl}`);
        return null;
      }

      type RumbleOEmbed = { html?: string; width?: number; height?: number; thumbnail_url?: string };
      const data = (await res.json()) as RumbleOEmbed;
      const iframeSrc = extractIframeSrc(data.html ?? '');
      embedUrl = iframeSrc ? normalizeEmbedUrl(iframeSrc) : null;
      if (!embedUrl) return null;

      if (Number.isFinite(data.width)) fallbackWidth = Math.max(1, Math.floor(data.width!));
      if (Number.isFinite(data.height)) fallbackHeight = Math.max(1, Math.floor(data.height!));
      const thumb = typeof data.thumbnail_url === 'string' ? data.thumbnail_url.trim() : '';
      thumbnailUrl = thumb || null;
    }

    const embedId = rumbleEmbedIdFromUrl(embedUrl);
    const jsDims = embedId ? await fetchEmbedJsDimensions(embedId, signal) : null;
    return {
      platform: 'rumble',
      embedUrl,
      thumbnailUrl,
      width: jsDims?.width ?? fallbackWidth,
      height: jsDims?.height ?? fallbackHeight,
      sizedBy: jsDims ? 'embedjs' : 'oembed',
    };
  } catch (err) {
    log.warn(`Rumble oEmbed fetch failed for ${pageUrl}: ${String(err)}`);
    return null;
  }
}
