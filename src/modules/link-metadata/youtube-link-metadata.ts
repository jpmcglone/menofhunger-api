/** Only recognized video URLs are sent to YouTube's fixed oEmbed endpoint. */
export function youtubeVideoId(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    const host = url.hostname.toLowerCase();
    const parts = url.pathname.split('/').filter(Boolean);
    let id: string | null = null;
    if (host === 'youtu.be' || host === 'www.youtu.be') id = parts[0] ?? null;
    else if (['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtube-nocookie.com', 'www.youtube-nocookie.com'].includes(host)) {
      if (url.pathname === '/watch') id = url.searchParams.get('v');
      else if (['shorts', 'live', 'embed'].includes(parts[0] ?? '')) id = parts[1] ?? null;
    }
    return id && /^[a-zA-Z0-9_-]{11}$/.test(id) ? id : null;
  } catch { return null; }
}

export function needsYoutubeEnrichment(meta: { title: string | null; siteName: string | null } | null): boolean {
  return !meta?.title?.trim() || !meta.siteName?.startsWith('YouTube · ');
}

export async function fetchYoutubeMetadata(url: string, signal: AbortSignal) {
  const id = youtubeVideoId(url);
  if (!id) return null;
  const endpoint = new URL('https://www.youtube.com/oembed');
  endpoint.searchParams.set('url', `https://www.youtube.com/watch?v=${id}`);
  endpoint.searchParams.set('format', 'json');
  const response = await fetch(endpoint, { signal, redirect: 'error' });
  if (!response.ok) return null;
  const payload: unknown = await response.json();
  if (!payload || typeof payload !== 'object') return null;
  const data = payload as Record<string, unknown>;
  const title = typeof data.title === 'string' ? data.title.trim() : '';
  const author = typeof data.author_name === 'string' ? data.author_name.trim() : '';
  if (!title || !author || data.type !== 'video') return null;
  // Generate the trusted poster URL; never render provider HTML or instantiate a player.
  return {
    title,
    description: null,
    siteName: `YouTube · ${author}`,
    imageUrl: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
  };
}
