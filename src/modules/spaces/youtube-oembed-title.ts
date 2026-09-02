const YOUTUBE_ID_RE = /^[a-zA-Z0-9_-]{6,20}$/;

export function youtubeVideoId(url: string): string | null {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, '').toLowerCase();
    let id: string | null = null;
    if (host === 'youtu.be') {
      id = u.pathname.split('/').filter(Boolean)[0] ?? null;
    } else if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'music.youtube.com') {
      if (u.pathname === '/watch') id = u.searchParams.get('v');
      else if (u.pathname.startsWith('/shorts/')) id = u.pathname.split('/')[2] ?? null;
      else if (u.pathname.startsWith('/embed/')) id = u.pathname.split('/')[2] ?? null;
      else if (u.pathname.startsWith('/live/')) id = u.pathname.split('/')[2] ?? null;
    }
    if (!id) return null;
    id = id.split('?')[0] ?? id;
    return YOUTUBE_ID_RE.test(id) ? id : null;
  } catch {
    return null;
  }
}

export function youtubeOEmbedRequestUrl(pageUrl: string): string | null {
  const id = youtubeVideoId(pageUrl);
  if (!id) return null;
  return `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${encodeURIComponent(id)}&format=json`;
}

/**
 * Stable YouTube poster for email. `hqdefault` is always present; `maxresdefault`
 * 404s for some videos and clients have no onerror fallback.
 */
export function youtubeEmailPosterUrl(pageUrl: string | null | undefined): string | null {
  const trimmed = (pageUrl ?? '').trim();
  if (!trimmed) return null;
  const id = youtubeVideoId(trimmed);
  if (!id) return null;
  return `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
}

/** Keyless public oEmbed — more reliable than scraping YouTube HTML. */
export async function fetchYouTubeOEmbedTitle(pageUrl: string): Promise<string | null> {
  const endpoint = youtubeOEmbedRequestUrl(pageUrl);
  if (!endpoint) return null;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 4000);
  timer.unref?.();
  try {
    const res = await fetch(endpoint, { method: 'GET', signal: ac.signal });
    if (!res.ok) return null;
    const data = (await res.json()) as { title?: unknown };
    const title = typeof data.title === 'string' ? data.title.trim() : '';
    return title || null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
