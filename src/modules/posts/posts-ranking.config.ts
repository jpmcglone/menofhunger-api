/**
 * Tuning constants for post ranking: trending/popular scores, the featured
 * subset, and the For You feed blend. Shared by PostsRankingService (score
 * computation) and the feed-query methods in PostsService.
 */
export const POSTS_RANKING = {
  boostScoreTtlMs: 10 * 60 * 1000,
  /** 12h half-life so trending favors recent engagement. */
  popularHalfLifeSeconds: 12 * 60 * 60,
  popularLookbackDays: 30,
  popularWarmupTake: 200,
  /**
   * Score penalty for posts that have deleted ancestors.
   * We avoid expensive recursive ancestry checks; instead we penalize based on:
   * - deleted direct parent (for replies to deleted replies)
   * - deleted thread root (for replies under a deleted root post)
   *
   * If both apply, penalty compounds.
   */
  deletedAncestorPenalty: 0.85,
  // Popular feed candidate selection: bias toward recency, but include top engaged.
  // Keep bounded so we never score/sort an unbounded 30-day set.
  popularRecentWindowHours: 72,
  popularCandidatesRecentTake: 8000,
  popularCandidatesBoostedTake: 1500,
  popularCandidatesBookmarkedTake: 1500,
  popularCandidatesCommentedTake: 1500,
  popularCandidatesRepliesTake: 1200,
  /** Weight for comment score in trending (same as bookmarks: quieter signal than boosts). */
  commentScoreWeight: 0.5,
  /** Top-level posts get this multiplier so they rank slightly above replies with similar engagement. */
  popularTopLevelScoreBoost: 1.15,
  /** Pin score: "I think this is important" — premium pinner > verified > neither (same hierarchy as boost weights). */
  pinScorePremium: 0.5,
  pinScoreVerified: 0.3,
  pinScoreBase: 0.15,
  /**
   * Trending hashtag bonus: small additive bump so "hot topic" posts surface a bit sooner,
   * but engagement signals (boosts/bookmarks/comments) still dominate.
   *
   * Base applies when the post has >=1 hashtag that appears in the latest trending snapshot.
   * Scaled applies proportional to the post's strongest trending hashtag score (normalized to snapshot max).
   */
  popularTrendingHashtagBaseBonus: 0.05,
  popularTrendingHashtagMaxScaledBonus: 0.15,

  /** Engagement-rate bonus: small multiplier when (boost+bookmark+comment) / (views+k) is high. Cap so it never dominates. */
  popularEngagementRateK: 10,
  popularEngagementRateWeight: 0.03,
  popularEngagementRateCap: 0.06,
  /** Reposts signal content spread / virality; weighted similarly to bookmarks. */
  popularRepostScoreWeight: 0.5,
  popularCandidatesRepostedTake: 1500,

  // "Featured" is an automated, stable subset of trending:
  // - Top-level posts only
  // - Shorter lookback window (more “fresh”)
  // - Light author diversity (avoid 5 posts in a row from same author)
  featuredLookbackDays: 10,
  featuredMaxPerAuthor: 1,
  featuredScanTakeMax: 500,
  featuredRisingWindowHours: 48,
  featuredRisingHalfLifeSeconds: 6 * 60 * 60,
  featuredRisingMixTopRatio: 0.7,

  // For You: blends followed-unseen posts, friend-engaged discovery, and broader trending.
  forYouScanTakeMax: 240,
  forYouCursorServedIdMax: 300,
  forYouRecentFollowedWindowHours: 48,
  /**
   * Followed-unseen quota ratio is now depth-aware (see listForYouFeed):
   *   page 1 (servedIds == 0):  70% — strongly user-first
   *   page 2 (servedIds 1–50): 55% — slightly more discovery
   *   page 3+ (servedIds 50+): 40% — fans out further
   * This constant is kept for reference only.
   */
  forYouFollowedUnseenQuotaRatio: 0.65,
  forYouFollowedUnseenMult: 3.5,
  /**
   * Relationship tiers (A+ > A > B > E > C > D):
   *   A+ (2.0) — you follow them AND recently boosted/replied to their content (engagement history)
   *   A  (1.8) — mutual follow
   *   B  (1.1) — you follow them
   *   E  (0.85) — friend engaged, but you don't follow the author
   *   C  (0.65) — they follow you (no friend engagement)
   *   D  (0.15) — no relationship
   */
  forYouRelMultEngaged: 2.0,
  /** Lookback window (days) for viewer's boost/reply engagement history used to identify A+ tier authors. */
  forYouEngagedWithWindowDays: 30,
  forYouRelMultMutual: 1.8,
  forYouRelMultFollowing: 1.1,
  /**
   * E tier: viewer doesn't follow the author, but someone they follow engaged (replied/boosted).
   * Sits between "you follow them" (1.1) and "they follow you" (0.65) — trusted social proof
   * without a direct follow relationship. The `forYouFriendEngagementMult` bonus does NOT stack
   * on top of this tier; it is already factored into the 0.85 value.
   */
  forYouFriendCommentedMult: 0.85,
  forYouRelMultFollower: 0.65,
  /** Demoted: no social connection means global virality is not a good relevance signal. */
  forYouRelMultStranger: 0.15,
  /** Floor multiplier for a post you saw moments ago (recovers toward ~0.95 after about four days). */
  forYouSeenFloor: 0.12,
  /** Time constant (hours) for the seen-decay recovery. */
  forYouSeenHalfLifeHours: 48,
  /**
   * Extra compounding bonus for posts by authors the viewer follows that ALSO got friend
   * engagement — both signals point at the same post, so compounding is warranted. For the E
   * tier (friend engaged, viewer doesn't follow the author) this mult is NOT applied; the
   * social proof is already captured in forYouFriendCommentedMult.
   */
  forYouFriendEngagementMult: 2.2,
  forYouFriendEngagementBaseFloor: 6,
  /**
   * Social proof base weight: each following-user who engaged a friend-engaged post adds this
   * many base points, making social-graph density the primary ranking signal over global virality.
   */
  forYouSocialProofBaseWeight: 4.0,
  /** Low-priority discovery: authors followed by people the viewer follows. */
  forYouSecondDegreeMult: 1.5,
  /** Extended to 1 week so the second-degree lane fans out meaningfully as users scroll deeper. */
  forYouSecondDegreeWindowHours: 168,
  /** Widened to surface more social-graph-adjacent authors for discovery. */
  forYouSecondDegreeMaxAuthors: 200,
  forYouSecondDegreePathBonusMax: 1.5,
  /**
   * Strong freshness bias: posts in the last 24h dominate, then 48h, then 72h, with a low floor so
   * months-old content can't ride a tall trendingScore back onto page one. A genuinely popular older
   * post still wins when its raw trending is high enough — the floor is non-zero on purpose.
   */
  forYouRecencyHalfLifeHours: 36,
  forYouRecencyFloor: 0.1,
  /** Explicit fresh-window boosts so 24h > 48h > 72h ordering is unambiguous at parity. */
  forYouFreshBoost24h: 1.2,
  forYouFreshBoost48h: 1.05,
  /** Member-group posts should rank by relationship; open non-member groups stay lower-priority discovery. */
  forYouMemberGroupMult: 1.0,
  /** Demoted: open groups are weakly social and should not crowd the early feed. */
  forYouOpenFollowGroupMult: 0.35,
  forYouGroupWindowHours: 72,
  /** Repeated exposures should recover slower than posts seen once. */
  forYouSeenRepeatPenaltyStrength: 0.35,
  forYouRecentFeedSeenExtraPenaltyHours: 24,
  forYouRecentFeedSeenExtraPenaltyMult: 0.65,
  /** Per-author diversity walk: max 1 occurrence in any window of this many consecutive rows. */
  forYouMaxPerAuthorWindow: 5,
  /**
   * Logged-out viewers have no last-seen signal, so jitter the adjusted score +/- this
   * fraction to vary ordering between refreshes while keeping recent/relevant posts near
   * the top. Authed paths are unaffected (jitter is 1.0 when viewerUserId is set).
   */
  forYouAnonJitterStrength: 0.35,
  /**
   * Width of the recency tier used when ordering the followed-unseen quota. Within the same tier
   * we prefer engaged-with > mutuals > one-way follows; across tiers, the newer tier always wins.
   * 2h is the sweet spot: a brand-new follow-only post still beats a 3-hour-old mutual, but a
   * 30-minute-old mutual beats a 90-minute-old one-way.
   */
  forYouFollowedQuotaBucketHours: 2,
} as const;
