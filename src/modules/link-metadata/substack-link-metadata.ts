/**
 * Pure helpers for Substack post link-metadata enrichment.
 * Kept free of Nest deps so unit tests can lock the API contract.
 *
 * Enrichment uses Substack's public, unauthenticated per-post JSON API:
 *   GET https://{subdomain}.substack.com/api/v1/posts/{slug}
 * No API key is required and there is no bot-detection block (unlike the HTML page).
 */

import { Logger } from '@nestjs/common';
import type { LinkMetadataDto } from './link-metadata.service';

const log = new Logger('SubstackLinkMetadata');

// ---------------------------------------------------------------------------
// URL detection
// ---------------------------------------------------------------------------

/**
 * Matches canonical Substack post URLs:
 *   https://newsletter.substack.com/p/some-post-slug
 *   https://newsletter.substack.com/p/some-post-slug/comments
 */
export function isSubstackPostUrl(url: string): boolean {
  const parts = parseSubstackPostParts(url);
  return parts !== null;
}

export type SubstackPostParts = {
  subdomain: string;
  slug: string;
};

export function parseSubstackPostParts(url: string): SubstackPostParts | null {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    const host = u.hostname.toLowerCase();
    // Must be *.substack.com (but not substack.com itself)
    if (!host.endsWith('.substack.com')) return null;
    const subdomain = host.replace(/\.substack\.com$/, '');
    if (!subdomain || subdomain.includes('.')) return null;
    // Path must start with /p/
    const pathMatch = u.pathname.match(/^\/p\/([^/]+)\/?/);
    if (!pathMatch?.[1]) return null;
    const slug = pathMatch[1];
    return { subdomain, slug };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Substack public API types
// ---------------------------------------------------------------------------

type SubstackApiPost = {
  title?: unknown;
  subtitle?: unknown;
  cover_image?: unknown;
  description?: unknown;
  publishedBylines?: unknown;
  publication?: {
    name?: unknown;
    subdomain?: unknown;
    logo_url?: unknown;
  };
};

function str(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s || null;
}

function absoluteUrl(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:' ? s : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Enrichment
// ---------------------------------------------------------------------------

/**
 * Fetch structured post data from the Substack public API and return mapped
 * flat `LinkMetadataDto` fields for storage.
 *
 * Maps:
 *   title       ← post title
 *   description ← post subtitle (concise) or API description field
 *   imageUrl    ← cover_image
 *   siteName    ← publication name (e.g. "Joel Webbon")
 */
export async function enrichSubstackPost(
  url: string,
  signal: AbortSignal,
): Promise<Partial<LinkMetadataDto> | null> {
  const parts = parseSubstackPostParts(url);
  if (!parts) return null;

  const apiUrl = `https://${parts.subdomain}.substack.com/api/v1/posts/${encodeURIComponent(parts.slug)}`;

  try {
    const res = await fetch(apiUrl, { method: 'GET', signal });
    if (!res.ok) {
      log.warn(`Substack API returned ${res.status} for ${url}`);
      return null;
    }
    const data = (await res.json()) as SubstackApiPost;

    const title = str(data.title);
    if (!title) return null;

    const description = str(data.subtitle) ?? str(data.description);
    const imageUrl = absoluteUrl(data.cover_image);

    // Publication name from the publication object; fall back to formatted subdomain.
    const pubName = str(data.publication?.name) ?? formatSubdomain(parts.subdomain);
    const siteName = pubName;

    return { title, description, imageUrl, siteName };
  } catch (err) {
    if ((err as { name?: string }).name === 'AbortError') throw err;
    log.warn(`Substack enrichment failed for ${url}: ${String(err)}`);
    return null;
  }
}

/** Converts a subdomain slug to a readable name: "joel-webbon" → "Joel Webbon". */
function formatSubdomain(subdomain: string): string {
  return subdomain
    .split(/[-_]/)
    .map((word) => (word ? word.charAt(0).toUpperCase() + word.slice(1) : ''))
    .join(' ');
}
