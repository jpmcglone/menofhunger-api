import type { MarvinModeDto } from './marvin-mode.dto';

/**
 * Body for `POST /marvin/catch-up/:postId`. The mode mirrors the user's Marv mode
 * selector; omit (or pass `auto`) to let the routing service pick the tier.
 */
export type MarvinCatchUpBodyDto = {
  mode?: MarvinModeDto | 'auto';
  /** Skip the cache and regenerate a fresh summary (the "Regenerate" button). Spends credits. */
  refresh?: boolean;
  /** Peek mode: return the cached summary if one exists, else null. Never spends credits. */
  cacheOnly?: boolean;
  /**
   * When true (default), pass images from across the thread to vision-capable models.
   * When false, skip vision entirely — no images attached, no vision surcharge, cheaper.
   */
  includeImages?: boolean;
};

/**
 * Result of a "Catch me up" request — an AI summary of the conversation above AND
 * below a focal post. Returned by `POST /marvin/catch-up/:postId`.
 */
export type MarvinCatchUpDto = {
  postId: string;
  rootPostId: string | null;
  /** The generated summary text (markers stripped; always present for backwards compat). */
  summary: string;
  /**
   * Structured summary sections, present when the thread has replies.
   * `post` summarises the focal post; `replies` synthesises the replies below.
   * `since` is present only when this summary was generated over a thread the viewer had
   * already summarized — it's the delta, i.e. what changed since then, and clients should
   * lead with it because it's the part the reader doesn't know yet.
   * Null when the AI didn't output the expected markers (single-blob fallback).
   */
  sections?: { post: string; replies: string | null; since?: string | null } | null;
  /** The model tier that actually ran (after routing/auto-upgrades). */
  effectiveMode: MarvinModeDto;
  /** Credits spent on this request (0 on a cache hit). */
  creditsSpent: number;
  /**
   * Breakdown of what drove the total spend (all 0 on a cache hit).
   * Lets the UI render e.g. "5 credits: 2 model + 2 image + 1 web search".
   */
  costBreakdown: {
    mode: number;
    vision: number;
    webSearch: number;
    urlFetch: number;
  };
  /** True when this summary was served from cache (no new credits spent). */
  cached: boolean;
  /**
   * True when the thread changed after this summary was generated. The summary is still
   * served for free — the client shows it immediately and labels it, so regenerating is an
   * informed choice rather than a paywall. Always false on a freshly generated summary.
   */
  stale: boolean;
  /**
   * Replies added since this summary was generated. 0 when fresh, and also 0 when `stale`
   * is true but only edits (no new replies) caused the drift.
   */
  newReplies: number;
  /** How much of the thread the summary was built from. */
  included: {
    ancestors: number;
    descendants: number;
    /** Total descendants discovered within traversal depth (may exceed `descendants`). */
    totalDescendants: number;
  };
  /** ISO timestamp of when the underlying summary was generated. */
  generatedAt: string;
};
