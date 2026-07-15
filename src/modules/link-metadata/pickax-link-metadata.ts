/**
 * Pure helpers for Pickax post link-metadata enrichment.
 * Kept free of Nest deps so unit tests can lock the scrape contract.
 */

/** Stable public Pickax wordmark (512² PNG). Safe to use as attribution in previews. */
export const PICKAX_LOGO_URL = 'https://pickax.com/favicon.png';

export function normalizePickaxText(v: string | null | undefined): string | null {
  const s = (v ?? '').trim();
  return s ? s : null;
}

export function isPickaxPostUrl(url: string): boolean {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    if (host !== 'pickax.com') return false;
    return /^\/post\/\d+\/?$/i.test(u.pathname);
  } catch {
    return false;
  }
}

/** Favicon / logo images are useless for a post-like Pickax card. */
export function isWeakPickaxImage(imageUrl: string | null | undefined): boolean {
  const s = (imageUrl ?? '').trim().toLowerCase();
  if (!s) return true;
  return s.includes('pickax.com/favicon') || s.includes('/logo');
}

/**
 * True when cached meta still looks incomplete for a post-like Pickax card.
 * Done when we have an `img.pickax.com` avatar, or when enrichment already produced
 * an `@handle` (avatar may still be missing after a best-effort scrape).
 */
export function needsPickaxEnrichment(meta: {
  title?: string | null;
  description?: string | null;
  imageUrl?: string | null;
  siteName?: string | null;
} | null | undefined): boolean {
  if (!meta) return true;
  const title = (meta.title ?? '').trim();
  const body = (meta.description ?? '').trim();
  const image = (meta.imageUrl ?? '').trim().toLowerCase();
  const site = (meta.siteName ?? '').trim();

  // A full body plus a normalized author title proves enrichment completed.
  // Some Jina snapshots omit author chrome, so avatar/handle cannot be required.
  if (body && title && !/posted\.?$/i.test(title)) {
    return false;
  }

  // Avatar/handle without body is still incomplete: older enrichment cached exactly
  // that partial shape and produced an empty-looking card.
  if (!body) return true;
  if (image.includes('pickax.com/favicon') || image.includes('/logo')) return true;
  if (/posted\.?$/i.test(title)) return true;
  if (!site || /^pickax(?:\.com)?$/i.test(site)) return true;
  return false;
}

export function pickaxAuthorFromTitle(title: string | null | undefined): string | null {
  const t = (title ?? '').trim();
  if (!t) return null;
  const m = t.match(/^(.+?)\s+posted\.?$/i);
  return normalizePickaxText(m?.[1] ?? t);
}

/**
 * Jina Reader markdown for Pickax posts starts with the author avatar linked to their profile:
 * [![...](https://img.pickax.com/...)](https://pickax.com/Username)
 */
export function parsePickaxAuthorFromJina(md: string): { avatarUrl: string | null; username: string | null } {
  const m = (md ?? '').toString().match(
    /!\[[^\]]*\]\((https:\/\/img\.pickax\.com\/[^)\s]+)\)\]\((https:\/\/(?:www\.)?pickax\.com\/([^)/\s?#]+))\)/i,
  );
  if (!m) {
    const avatarOnly = (md ?? '')
      .toString()
      .match(/!\[[^\]]*\]\((https:\/\/img\.pickax\.com\/[^)\s]+)\)/i);
    return { avatarUrl: normalizePickaxText(avatarOnly?.[1] ?? null), username: null };
  }
  const username = normalizePickaxText(m[3] ?? null);
  // Skip non-profile paths accidentally captured from later images.
  if (username && /^(post|api|login|signup|settings|top-users)$/i.test(username)) {
    return { avatarUrl: normalizePickaxText(m[1] ?? null), username: null };
  }
  return {
    avatarUrl: normalizePickaxText(m[1] ?? null),
    username,
  };
}

/**
 * Returns true when the Jina markdown is actually Pickax's signup/landing page
 * rather than a real post. This happens when Pickax requires authentication and
 * redirects unauthenticated Jina crawls to the marketing/registration page.
 */
export function isPickaxGatedMarkdown(md: string): boolean {
  const text = (md ?? '').toString();
  // Distinctive phrases that only appear on Pickax's signup/marketing page.
  const gatedSignals = [
    /Own your audience\.\s*Post without algorithms/i,
    /Email\s*\*/,
    /Password\s*\*/,
    /Free to join\.\s*No algorithms/i,
    /No algorithms or shadow bans/i,
    /Anti-Robot check/i,
  ];
  let hits = 0;
  for (const re of gatedSignals) {
    if (re.test(text)) hits++;
    if (hits >= 2) return true;
  }
  return false;
}

/**
 * Body text sits between the author avatar markdown and the next image / reply block.
 */
export function parsePickaxBodyFromJina(md: string): string | null {
  if (isPickaxGatedMarkdown(md)) return null;
  const text = (md ?? '').toString();
  const contentMarker = /Markdown Content:\s*/i.exec(text);
  const bodySection = contentMarker?.index != null
    ? text.slice(contentMarker.index + contentMarker[0].length)
    : text;

  const authorMatch = bodySection.match(
    /\[!\[[^\]]*\]\((https:\/\/img\.pickax\.com\/[^)\s]+)\)\]\((https:\/\/(?:www\.)?pickax\.com\/[^)\s]+)\)/i,
  );
  const beforeAuthor = authorMatch?.index != null
    ? bodySection.slice(0, authorMatch.index).replace(/^\s*Warning:.*$/gim, '').trim()
    : '';
  // When the first linked avatar is at the top, it is the post author. Some cached
  // Jina snapshots omit that chrome entirely and begin directly with the body.
  const bodyStart =
    authorMatch?.index != null && !beforeAuthor
      ? bodySection.slice(authorMatch.index + authorMatch[0].length)
      : bodySection;
  // A later linked Pickax user avatar starts the replies.
  const nextReply = bodyStart.search(
    /\[!\[[^\]]*\]\(https:\/\/img\.pickax\.com\/user-[^)\s]+\)\]\(https:\/\/(?:www\.)?pickax\.com\/[^)\s]+\)/i,
  );
  const raw = (nextReply >= 0 ? bodyStart.slice(0, nextReply) : bodyStart)
    .replace(/\r\n/g, '\n')
    .replace(/^\s*Title:.*$/gim, '')
    .replace(/^\s*URL Source:.*$/gim, '')
    .replace(/^\s*Markdown Content:\s*$/gim, '')
    .replace(/^\s*Warning:.*$/gim, '')
    .replace(/\[([^\]]+)\]\(https?:\/\/(?:www\.)?pickax\.com\/[^)\s]+\)/gi, '$1')
    .replace(/^\s*\u00ad\s*$/gm, '')
    .trim();

  // Drop trailing relative-time / chrome lines that sometimes leak before the next image.
  const lines = raw
    .split('\n')
    .map((l) => l.replace(/\u00ad/g, '').trimEnd())
    .filter((l, idx, arr) => {
      const t = l.trim();
      if (!t) return idx > 0 && idx < arr.length - 1;
      if (/^\d+\s+(minute|minutes|hour|hours|day|days|week|weeks|month|months|year|years)\s+ago$/i.test(t)) {
        return false;
      }
      return true;
    });

  while (lines.length && !lines[0]?.trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1]?.trim()) lines.pop();

  return normalizePickaxText(lines.join('\n'));
}
