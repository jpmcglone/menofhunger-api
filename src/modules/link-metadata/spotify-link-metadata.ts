export type SpotifyContent = {
  kind: string;
  id: string;
  url: string;
  embedUrl: string;
  height: number;
};

/** Only construct player URLs from supported Spotify entities, never provider HTML. */
export function spotifyContent(
  raw: string | null | undefined,
): SpotifyContent | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.port
    )
      return null;
    if (
      !['open.spotify.com', 'play.spotify.com'].includes(
        url.hostname.toLowerCase(),
      )
    )
      return null;
    let path = url.pathname
      .replace(/^\/intl-[a-z-]+\//i, '/')
      .replace(/^\/embed\//, '/');
    path = path.replace(/^\/user\/[^/]+\/playlist\//, '/playlist/');
    const match = path.match(
      /^\/(track|album|artist|playlist|episode|show)\/([a-zA-Z0-9]{22})\/?$/,
    );
    if (!match) return null;
    const [, kind, id] = match as [string, string, string];
    const canonical = `https://open.spotify.com/${kind}/${id}`;
    return {
      kind,
      id,
      url: canonical,
      embedUrl: `https://open.spotify.com/embed/${kind}/${id}?utm_source=generator`,
      height: ['track', 'episode'].includes(kind) ? 152 : 352,
    };
  } catch {
    return null;
  }
}

export function isSpotifyShareUrl(raw: string | null | undefined): boolean {
  try {
    const url = new URL(raw ?? '');
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.port &&
      ['spotify.link', 'spoti.fi'].includes(url.hostname.toLowerCase()) &&
      url.pathname !== '/'
    );
  } catch {
    return false;
  }
}

/** Resolve only Spotify share hosts; every redirect is checked before issuing another request. */
export async function resolveSpotifyShareUrl(
  raw: string,
  signal: AbortSignal,
): Promise<string | null> {
  let current = raw;
  for (let hop = 0; hop < 4; hop++) {
    const content = spotifyContent(current);
    if (content) return content.url;
    if (!isSpotifyShareUrl(current)) return null;
    const response = await fetch(current, { signal, redirect: 'manual' });
    await response.body?.cancel();
    if (![301, 302, 303, 307, 308].includes(response.status)) return null;
    const location = response.headers.get('location');
    if (!location) return null;
    current = new URL(location, current).toString();
  }
  return spotifyContent(current)?.url ?? null;
}

export async function fetchSpotifyMetadata(raw: string, signal: AbortSignal) {
  const content = spotifyContent(raw);
  if (!content) return null;
  const endpoint = new URL('https://open.spotify.com/oembed');
  endpoint.searchParams.set('url', content.url);
  const response = await fetch(endpoint, { signal, redirect: 'error' });
  if (!response.ok) return null;
  const value = (await response.json()) as {
    title?: unknown;
    thumbnail_url?: unknown;
  };
  const title = typeof value.title === 'string' ? value.title.trim() : '';
  if (!title) return null;
  let imageUrl: string | null = null;
  if (typeof value.thumbnail_url === 'string') {
    try {
      const image = new URL(value.thumbnail_url);
      if (
        image.protocol === 'https:' &&
        (image.hostname.endsWith('.scdn.co') ||
          image.hostname.endsWith('.spotifycdn.com')) &&
        !image.username &&
        !image.password &&
        !image.port
      )
        imageUrl = image.toString();
    } catch {
      /* Metadata images are optional. */
    }
  }
  return { title, description: null, imageUrl, siteName: 'Spotify' };
}
