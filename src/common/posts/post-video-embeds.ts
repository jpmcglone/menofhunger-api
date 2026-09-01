import type { Prisma } from '@prisma/client';
import type { PostVideoEmbedDto } from '../dto/post.dto';

/** Mirrors www `PostRowLinkPreview.previewLink`: last non-MoH http(s) link in the body. */
export function previewLinkForPostBody(body: string | null | undefined): string | null {
  const input = (body ?? '').toString();
  const matches = input.match(/https?:\/\/[^\s<>"')\]]+/gi) ?? [];
  for (let i = matches.length - 1; i >= 0; i--) {
    const raw = (matches[i] ?? '').replace(/[.,;:!?]+$/, '');
    if (!raw) continue;
    try {
      const u = new URL(raw);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') continue;
      const host = u.hostname.toLowerCase();
      if (host === 'menofhunger.com' || host.endsWith('.menofhunger.com')) continue;
      return u.toString();
    } catch {
      // not a URL
    }
  }
  return null;
}

function toPostVideoEmbed(url: string, raw: Prisma.JsonValue | null | undefined): PostVideoEmbedDto | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  if (rec.platform !== 'rumble') return null;
  const embedUrl = typeof rec.embedUrl === 'string' ? rec.embedUrl.trim() : '';
  const width = Number(rec.width);
  const height = Number(rec.height);
  if (!embedUrl || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  return {
    url,
    platform: 'rumble',
    embedUrl,
    thumbnailUrl: typeof rec.thumbnailUrl === 'string' && rec.thumbnailUrl.trim() ? rec.thumbnailUrl.trim() : null,
    width: Math.floor(width),
    height: Math.floor(height),
  };
}

/**
 * Cached-only lookup of `LinkMetadata.videoEmbed` for each post's preview link.
 * One indexed `IN` query per page; never fetches externally (that is the
 * `/link-metadata` endpoint's job, and the post side-effects pre-warm). A post
 * without a cached row is simply absent from the map and the client falls back
 * to its own fetch.
 */
export async function loadPostVideoEmbeds(
  prisma: {
    linkMetadata: {
      findMany: (args: {
        where: { url: { in: string[] } };
        select: { url: true; videoEmbed: true };
      }) => Promise<Array<{ url: string; videoEmbed: Prisma.JsonValue | null }>>;
    };
  },
  posts: Iterable<{ id: string; body?: string | null }>,
): Promise<Map<string, PostVideoEmbedDto>> {
  const urlByPostId = new Map<string, string>();
  for (const p of posts) {
    const url = previewLinkForPostBody(p.body);
    if (url) urlByPostId.set(p.id, url);
  }
  const out = new Map<string, PostVideoEmbedDto>();
  if (urlByPostId.size === 0) return out;

  const urls = [...new Set(urlByPostId.values())];
  let rows: Array<{ url: string; videoEmbed: Prisma.JsonValue | null }>;
  try {
    rows = await prisma.linkMetadata.findMany({
      where: { url: { in: urls } },
      select: { url: true, videoEmbed: true },
    });
  } catch {
    // Best-effort enrichment — never fail a feed page over it.
    return out;
  }
  const embedByUrl = new Map<string, PostVideoEmbedDto>();
  for (const r of rows) {
    const dto = toPostVideoEmbed(r.url, r.videoEmbed);
    if (dto) embedByUrl.set(r.url, dto);
  }
  for (const [postId, url] of urlByPostId) {
    const dto = embedByUrl.get(url);
    if (dto) out.set(postId, dto);
  }
  return out;
}
