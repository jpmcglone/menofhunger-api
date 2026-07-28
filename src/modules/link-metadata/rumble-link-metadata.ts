import { Logger } from '@nestjs/common';

const log = new Logger('RumbleLinkMetadata');

export type VideoEmbedDto = {
  platform: 'rumble';
  embedUrl: string;
  thumbnailUrl: string | null;
  width: number;
  height: number;
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

/**
 * Fetch Rumble oEmbed server-side (no CORS restriction) and return a
 * `VideoEmbedDto` for storage in `LinkMetadata.videoEmbed`.
 */
export async function enrichRumbleVideo(
  pageUrl: string,
  signal: AbortSignal,
): Promise<VideoEmbedDto | null> {
  try {
    const u = new URL(pageUrl);
    if (normalizeRumbleHost(u.hostname) !== 'rumble.com') return null;

    // If already an embed URL, no need to call oEmbed.
    const directEmbed = normalizeEmbedUrl(pageUrl);
    if (directEmbed) {
      return { platform: 'rumble', embedUrl: directEmbed, thumbnailUrl: null, width: 854, height: 480 };
    }

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
    const embedUrl = iframeSrc ? normalizeEmbedUrl(iframeSrc) : null;
    if (!embedUrl) return null;

    const width = Number.isFinite(data.width) ? Math.max(1, Math.floor(data.width!)) : 854;
    const height = Number.isFinite(data.height) ? Math.max(1, Math.floor(data.height!)) : 480;
    const thumb = typeof data.thumbnail_url === 'string' ? data.thumbnail_url.trim() : '';
    return { platform: 'rumble', embedUrl, thumbnailUrl: thumb || null, width, height };
  } catch (err) {
    log.warn(`Rumble oEmbed fetch failed for ${pageUrl}: ${String(err)}`);
    return null;
  }
}
