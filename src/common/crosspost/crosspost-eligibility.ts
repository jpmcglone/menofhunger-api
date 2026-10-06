import { parseTweet, extractUrlsWithIndices } from "twitter-text";
/**
 * Shared rules for "link back" vs "full post" cross-posting.
 * X's length matches twitter-text v3: most characters count as 1, characters
 * outside the BMP Latin/punctuation ranges (CJK, emoji) count as 2, and each
 * http(s) URL counts as 23. Clients must keep the same vectors.
 */

export const X_POST_MAX_WEIGHTED = 280;
export const X_POST_MAX_IMAGES = 4;
export const X_URL_WEIGHT = 23;

/** $0.015 and $0.20, in millionths of a dollar. */
export const X_NATIVE_COST_MICROS = 15_000;
export const X_LINK_COST_MICROS = 200_000;

export type CrosspostMode = "link" | "native";

export type CrosspostMedia = {
  kind: string;
  source: string;
  r2Key: string | null;
  deletedAt: Date | null;
};

export type CrosspostPost = {
  body: string;
  visibility: string;
  kind: string;
  boardOnly: boolean;
  isDraft: boolean;
  deletedAt: Date | null;
  scheduledAt: Date | null;
  parentId: string | null;
  communityGroupId: string | null;
  quotedPostId: string | null;
  repostedPostId: string | null;
  hasPoll: boolean;
  media: CrosspostMedia[];
};

export type NativeLimits = {
  maxChars: number;
  /** When true, `maxChars` is an X weighted length. Otherwise it is `string.length`. */
  weighted: boolean;
  maxImages: number;
};

export function xWeightedLength(text: string): number {
  return parseTweet(text).weightedLength;
}

export function xContainsLink(text: string): boolean {
  return (
    extractUrlsWithIndices(text).length > 0 ||
    /https?:\/\/|(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?\.)+(?:[\p{L}]{2,63}|xn--[a-z0-9-]+)(?![\p{L}\p{N}-])/iu.test(
      text,
    )
  );
}

export function xPostCostMicros(text: string): number {
  return xContainsLink(text) ? X_LINK_COST_MICROS : X_NATIVE_COST_MICROS;
}

/** Link shares point at the original. They do not copy its words. */
export const SHARE_LINK_BLURB = "Check this out on Men of Hunger";

export function buildShareText(url: string): string {
  return `${SHARE_LINK_BLURB} ${url}`;
}

/** Why even a link-back post is impossible, or null when a link is fine. */
export function linkBlocker(post: CrosspostPost): string | null {
  if (post.deletedAt || post.isDraft || post.scheduledAt)
    return "not_published";
  if (post.visibility !== "public") return "not_public";
  if (post.communityGroupId) return "group_post";
  // Board posts can only be shared as a link back to the thread.
  if (post.kind !== "board" && (post.boardOnly || post.kind !== "regular"))
    return "unsupported_kind";
  if (post.parentId) return "reply";
  if (post.quotedPostId || post.repostedPostId) return "quote_or_repost";
  return null;
}

function liveMedia(post: CrosspostPost): CrosspostMedia[] {
  return post.media.filter((media) => !media.deletedAt);
}

/** Why a full native post is impossible. Assumes a link would otherwise be allowed. */
export function nativeBlocker(
  post: CrosspostPost,
  limits: NativeLimits,
): string | null {
  if (post.kind === "board") return "unsupported_kind";
  if (post.hasPoll) return "poll";
  const text = post.body.trim();
  const media = liveMedia(post);
  if (!text && media.length === 0) return "empty";
  const length = limits.weighted ? xWeightedLength(text) : text.length;
  if (length > limits.maxChars) return "too_long";
  if (
    media.some(
      (item) =>
        item.kind !== "image" || item.source !== "upload" || !item.r2Key,
    )
  )
    return "unsupported_media";
  if (media.length > limits.maxImages) return "too_many_images";
  return null;
}

/**
 * Preserve the requested rendering; adaptation must be an explicit user choice.
 * A link blocker still skips the cross-post entirely.
 */
export function resolveCrosspostMode(
  post: CrosspostPost,
  requested: CrosspostMode,
  limits: NativeLimits,
): { mode: CrosspostMode } | { skip: string } {
  const link = linkBlocker(post);
  if (link) return { skip: link };
  if (requested === "link") return { mode: "link" };
  const native = nativeBlocker(post, limits);
  if (native) return { skip: native };
  return { mode: "native" };
}

/** X never falls back to a link. Recheck both queued choices and the latest content. */
export function xPostBlocker(
  post: CrosspostPost,
  requested: CrosspostMode,
  linksEnabled = false,
): string | null {
  if (requested !== "native") return "link_sharing_unsupported";
  if (!linksEnabled && xContainsLink(post.body)) return "links_unsupported";
  return (
    linkBlocker(post) ??
    nativeBlocker(post, {
      maxChars: X_POST_MAX_WEIGHTED,
      weighted: true,
      maxImages: X_POST_MAX_IMAGES,
    })
  );
}

export function xBlockerMessage(reason: string): string {
  switch (reason) {
    case "links_unsupported":
      return "Remove any links to post to X.";
    case "link_sharing_unsupported":
      return "Sharing links to X is not supported.";
    case "poll":
      return "Polls cannot be posted to X.";
    case "too_long":
      return "Shorten this post to 280 characters to post to X.";
    case "unsupported_media":
      return "Only uploaded photos can be posted to X. Remove videos and GIFs.";
    case "too_many_images":
      return "Use no more than 4 photos to post to X.";
    case "not_public":
      return "Make this post public to post to X.";
    case "group_post":
      return "Group posts cannot be posted to X.";
    case "reply":
      return "Replies cannot be posted to X.";
    case "quote_or_repost":
      return "Quoted posts cannot be posted to X.";
    case "unsupported_kind":
      return "This type of post cannot be posted to X.";
    case "empty":
      return "Add text or a photo to post to X.";
    default:
      return "This post can no longer be posted to X.";
  }
}
