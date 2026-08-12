import { publicAssetUrl } from '../../../common/assets/public-asset-url';

/** Media fields Marv can turn into a vision input (image, GIF, or video poster). */
export type MarvVisionMedia = {
  kind: string;
  source: string;
  r2Key: string | null;
  url: string | null;
  thumbnailR2Key?: string | null;
};

/**
 * Resolve a post/message media row to a public URL Marv can see.
 * Videos contribute their poster thumbnail; image/GIF use the file itself.
 */
export function resolveMarvVisionUrl(
  media: MarvVisionMedia,
  publicBaseUrl: string | null,
): string | null {
  if (media.kind === 'video') {
    return publicAssetUrl({ publicBaseUrl, key: media.thumbnailR2Key ?? null });
  }
  if (media.source === 'upload' && media.r2Key) {
    return publicAssetUrl({ publicBaseUrl, key: media.r2Key });
  }
  const direct = (media.url ?? '').trim();
  return direct || null;
}

/**
 * Merge post/message media URLs with extras (link-preview OG images), de-duped.
 * When extras exist, up to 2 slots are reserved for them so a busy thread does not
 * starve previews — but at least one post-media slot is kept when any exist.
 */
export function fillVisionSlots(
  existing: string[],
  extras: Array<string | null | undefined>,
  max: number,
): string[] {
  const cap = Math.max(0, max);
  if (cap === 0) return [];

  const seen = new Set<string>();
  const existingClean: string[] = [];
  for (const url of existing) {
    const trimmed = (url ?? '').trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    existingClean.push(trimmed);
  }
  const extraClean: string[] = [];
  for (const extra of extras) {
    const trimmed = (extra ?? '').trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    extraClean.push(trimmed);
  }

  const extraReserve =
    extraClean.length === 0
      ? 0
      : Math.min(2, extraClean.length, Math.max(0, cap - (existingClean.length > 0 ? 1 : 0)));
  const existingTake = Math.min(existingClean.length, cap - extraReserve);
  const out = existingClean.slice(0, existingTake);
  for (const extra of extraClean) {
    if (out.length >= cap) break;
    out.push(extra);
  }
  return out;
}

/** Compact inline marker so a text-only prompt still names attached media. */
export function marvMediaMarker(media: Array<{ kind: string }> | null | undefined): string {
  if (!media?.length) return '';
  const gifs = media.filter((m) => m.kind === 'gif').length;
  const videos = media.filter((m) => m.kind === 'video').length;
  const images = media.filter((m) => m.kind === 'image').length;
  const parts: string[] = [];
  if (images > 0) parts.push(images === 1 ? 'image' : `${images} images`);
  if (gifs > 0) parts.push(gifs === 1 ? 'animated GIF' : `${gifs} GIFs`);
  if (videos > 0) parts.push(videos === 1 ? 'video' : `${videos} videos`);
  return parts.length ? ` [attached: ${parts.join(' + ')}]` : '';
}
