import { extractLinks } from '../link-metadata/link-metadata-extract';

/** Max distinct links stored per post; bounds rows and the search join. */
export const MAX_POST_LINKS = 20;

/** Normalized external URLs in a post body, keyed exactly like `LinkMetadata.url`. */
export function postLinkUrls(body: string | null | undefined): string[] {
  return extractLinks(body ?? '').slice(0, MAX_POST_LINKS);
}

/** Nested-create data for a new post: `data: { links: postLinksCreate(body) }`. */
export function postLinksCreate(body: string | null | undefined) {
  const urls = postLinkUrls(body);
  return urls.length ? { create: urls.map((url) => ({ url })) } : undefined;
}

/** Nested-update data for an edited post: replaces the whole link set. */
export function postLinksReplace(body: string | null | undefined) {
  return { deleteMany: {}, create: postLinkUrls(body).map((url) => ({ url })) };
}
