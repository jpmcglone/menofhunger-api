export type SocialPostAuthorDto = {
  name: string;
  handle: string;
  avatarUrl: string | null;
  verified: boolean;
};

export type SocialPostMediaDto = {
  type: 'image' | 'video';
  url: string;
  previewUrl: string | null;
  width: number | null;
  height: number | null;
  alt: string | null;
};

export type SocialPostEmbedDto = {
  id: string;
  url: string;
  text: string;
  createdAt: string | null;
  author: SocialPostAuthorDto;
  media: SocialPostMediaDto[];
};

export type SocialPostMetadataDto = SocialPostEmbedDto & {
  platform: 'x';
  quote: SocialPostEmbedDto | null;
  metrics: {
    replies: number | null;
    reposts: number | null;
    likes: number | null;
    views: number | null;
  };
};

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized || null;
}

function number(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function absoluteHttpUrl(value: unknown): string | null {
  const raw = text(value);
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.toString() : null;
  } catch {
    return null;
  }
}

export function parseXPostUrl(url: string): { id: string; handle: string | null; canonicalUrl: string } | null {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '').replace(/^mobile\./, '');
    if (host !== 'x.com' && host !== 'twitter.com') return null;
    const match = parsed.pathname.match(/^\/([^/]+)\/status\/(\d+)(?:\/.*)?$/i);
    if (!match?.[2]) return null;
    const handle = match[1]?.trim() || null;
    return {
      id: match[2],
      handle,
      canonicalUrl: `https://x.com/${handle ?? 'i'}/status/${match[2]}`,
    };
  } catch {
    return null;
  }
}

export function isXPostUrl(url: string): boolean {
  return parseXPostUrl(url) != null;
}

function parseSyndicationAuthor(value: unknown): SocialPostAuthorDto | null {
  const author = record(value);
  if (!author) return null;
  const name = text(author.name);
  const screenName = text(author.screen_name);
  if (!name || !screenName) return null;
  return {
    name,
    handle: `@${screenName.replace(/^@/, '')}`,
    avatarUrl:
      absoluteHttpUrl(author.profile_image_url_https) ??
      absoluteHttpUrl(author.profile_image_url),
    verified: author.is_blue_verified === true || author.verified === true,
  };
}

function parseCreatedAt(value: unknown, timestamp: unknown): string | null {
  const seconds = number(timestamp);
  if (seconds != null) return new Date(seconds * 1000).toISOString();
  const raw = text(value);
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function parseSyndicationMedia(post: UnknownRecord): SocialPostMediaDto[] {
  const out: SocialPostMediaDto[] = [];

  const photos = Array.isArray(post.photos) ? post.photos : [];
  for (const item of photos) {
    const photo = record(item);
    const url = absoluteHttpUrl(photo?.url);
    if (!photo || !url) continue;
    out.push({
      type: 'image',
      url,
      previewUrl: url,
      width: number(photo.width),
      height: number(photo.height),
      alt: text(photo.alt_text) ?? text(photo.altText),
    });
  }

  const video = record(post.video);
  if (video) {
    const variants = Array.isArray(video.variants) ? video.variants : [];
    const playable = variants
      .map(record)
      .filter((variant): variant is UnknownRecord => variant != null)
      .filter((variant) => text(variant.type)?.includes('video/mp4'))
      .sort((a, b) => (number(b.bitrate) ?? 0) - (number(a.bitrate) ?? 0));
    const url = absoluteHttpUrl(playable[0]?.src) ?? absoluteHttpUrl(playable[0]?.url);
    const previewUrl =
      absoluteHttpUrl(video.poster) ?? absoluteHttpUrl(video.poster_url);
    if (url) {
    out.push({
      type: 'video',
      url,
        previewUrl,
      width: number(video.width),
      height: number(video.height),
      alt: null,
    });
    }
  }

  return out.slice(0, 4);
}

function parseSyndicationEmbed(value: unknown): SocialPostEmbedDto | null {
  const post = record(value);
  if (!post) return null;
  const id = text(post.id_str) ?? text(post.id);
  const postText = text(post.text);
  const author = parseSyndicationAuthor(post.user);
  if (!id || !postText || !author) return null;
  return {
    id,
    url: `https://x.com/${author.handle.replace(/^@/, '')}/status/${id}`,
    text: postText,
    createdAt: parseCreatedAt(post.created_at, null),
    author,
    media: parseSyndicationMedia(post),
  };
}

export function xSyndicationToken(id: string): string {
  return ((Number(id) / 1e15) * Math.PI)
    .toString(36)
    .replace(/(0+|\.)/g, '');
}

export function parseXSyndicationResponse(
  value: unknown,
  sourceUrl: string,
): SocialPostMetadataDto | null {
  const tweet = record(value);
  const parsedUrl = parseXPostUrl(sourceUrl);
  if (!tweet || !parsedUrl || tweet.__typename === 'TweetTombstone') return null;
  const post = parseSyndicationEmbed(tweet);
  if (!post) return null;

  const views = record(tweet.views);
  return {
    ...post,
    platform: 'x',
    quote: parseSyndicationEmbed(tweet.quoted_tweet),
    metrics: {
      replies: number(tweet.conversation_count),
      reposts: number(tweet.retweet_count),
      likes: number(tweet.favorite_count),
      views: number(views?.count),
    },
  };
}
