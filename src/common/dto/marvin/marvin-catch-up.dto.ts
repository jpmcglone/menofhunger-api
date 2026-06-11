import type { MarvinModeDto } from './marvin-mode.dto';

/**
 * Body for `POST /marvin/catch-up/:postId`. The mode mirrors the user's Marv mode
 * selector; omit (or pass `auto`) to let the routing service pick the tier.
 */
export type MarvinCatchUpBodyDto = {
  mode?: MarvinModeDto | 'auto';
  /** Skip the cache and regenerate a fresh summary (the "Regenerate" button). Spends credits. */
  refresh?: boolean;
};

/**
 * Result of a "Catch me up" request — an AI summary of the conversation above AND
 * below a focal post. Returned by `POST /marvin/catch-up/:postId`.
 */
export type MarvinCatchUpDto = {
  postId: string;
  rootPostId: string | null;
  /** The generated summary text. */
  summary: string;
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
