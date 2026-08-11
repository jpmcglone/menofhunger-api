/**
 * Pure helpers for admin media-review reference resolution.
 * Kept separate so orphan matching can be unit-tested without R2/Prisma.
 */

/** Map a stored DB value (raw R2 key or public CDN URL) back to a candidate key. */
export function matchStoredAssetToKey(
  stored: string | null | undefined,
  keySet: Set<string>,
  urlToKey: Map<string, string>,
): string | null {
  const raw = (stored ?? '').trim();
  if (!raw) return null;
  if (keySet.has(raw)) return raw;

  const noHash = raw.split('#')[0] ?? raw;
  const noQuery = (noHash.split('?')[0] ?? noHash).replace(/\/+$/, '');

  const fromUrl = urlToKey.get(raw) ?? urlToKey.get(noQuery) ?? urlToKey.get(`${noQuery}/`);
  if (fromUrl) return fromUrl;

  // CDN / host drift: pathname ends with "/{key}".
  for (const key of keySet) {
    if (key.length < 8) continue;
    if (noQuery.endsWith(`/${key}`) || noQuery === key) return key;
  }
  return null;
}

/** True when TipTap (or plain) article body embeds this R2 key. */
export function articleBodyContainsKey(body: string | null | undefined, key: string): boolean {
  const b = body ?? '';
  const k = (key ?? '').trim();
  if (!b || !k) return false;
  return b.includes(k);
}

type TipTapNode = {
  type?: string;
  attrs?: { src?: unknown; [k: string]: unknown };
  content?: TipTapNode[];
  [k: string]: unknown;
};

/**
 * Remove TipTap image nodes whose src references `key`.
 * Returns the updated body string and whether anything changed.
 */
export function scrubKeyFromArticleBody(
  body: string | null | undefined,
  key: string,
): { body: string; changed: boolean } {
  const raw = body ?? '';
  const k = (key ?? '').trim();
  if (!raw || !k || !raw.includes(k)) return { body: raw, changed: false };

  try {
    const doc = JSON.parse(raw) as TipTapNode;
    const changed = removeImagesWithKey(doc, k);
    if (!changed) return { body: raw, changed: false };
    return { body: JSON.stringify(doc), changed: true };
  } catch {
    // Non-JSON legacy body: don't invent a rewrite.
    return { body: raw, changed: false };
  }
}

function removeImagesWithKey(node: TipTapNode, key: string): boolean {
  let changed = false;
  if (!node || typeof node !== 'object') return false;

  if (Array.isArray(node.content)) {
    const next: TipTapNode[] = [];
    for (const child of node.content) {
      const src = typeof child?.attrs?.src === 'string' ? child.attrs.src : '';
      if (child?.type === 'image' && src.includes(key)) {
        changed = true;
        continue;
      }
      if (removeImagesWithKey(child, key)) changed = true;
      next.push(child);
    }
    node.content = next;
  }
  return changed;
}
