import { seededUnitInterval } from "../../common/random/seeded-random";
import { selectFreshForYou } from "./for-you-freshness";
import type { ConversationsService } from "./conversations.service";
import type { ForYouCandidate } from "./posts-feed-for-you-lanes";
import { POSTS_RANKING } from "./posts-ranking.config";

export type ForYouSeenState = { lastSeenAt: Date; seenCount: number; lastSource: string | null };

export type ForYouScoringInput = {
  candidates: ForYouCandidate[];
  conversationContexts: Awaited<ReturnType<ConversationsService["contexts"]>>;
  /** Authors the viewer follows. */
  youFollow: Set<string>;
  /** Authors who follow the viewer. */
  followsYou: Set<string>;
  /** Authors the viewer recently boosted or replied to. */
  engagedWithAuthorIds: Set<string>;
  socialProofCountById: Map<string, number>;
  seenById: Map<string, ForYouSeenState>;
  now: number;
  /** A deliberate pull-to-refresh on page one demotes recently seen rows harder. */
  isRefreshPage: boolean;
};

export type ForYouScoredCandidate = { candidate: ForYouCandidate; unjittered: number; seen: boolean };

/**
 * Score every candidate before jitter: relationship tier, seen decay, recency, lane bonuses, and
 * the conversation bonus. Jitter strength depends on how saturated the ordered page is, so it is
 * applied by the caller after this pass.
 */
export function scoreForYouCandidates(input: ForYouScoringInput): ForYouScoredCandidate[] {
  const { candidates, conversationContexts, youFollow, followsYou, engagedWithAuthorIds, socialProofCountById, seenById, now, isRefreshPage } = input;
  return candidates.map((c) => {
    const conversation = conversationContexts.get(c.id);
    const youFollowThem = youFollow.has(c.userId);
    const theyFollowYou = followsYou.has(c.userId);
    const youEngagedWithThem =
      youFollowThem && engagedWithAuthorIds.has(c.userId);
    // Relationship tiers (A+ > A > B > E > C > D):
    //   A+ (2.0) — you follow them AND recently boosted/replied to their content
    //   A  (1.8) — mutual follow
    //   B  (1.1) — you follow them
    //   E  (0.85) — friend engaged, but you don't follow the author
    //   C  (0.65) — they follow you (no friend engagement)
    //   D  (0.15) — no relationship
    const relMult = youEngagedWithThem
      ? POSTS_RANKING.forYouRelMultEngaged
      : youFollowThem && theyFollowYou
        ? POSTS_RANKING.forYouRelMultMutual
        : youFollowThem
          ? POSTS_RANKING.forYouRelMultFollowing
          : c.friendEngaged
            ? POSTS_RANKING.forYouFriendCommentedMult
            : theyFollowYou
              ? POSTS_RANKING.forYouRelMultFollower
              : POSTS_RANKING.forYouRelMultStranger;

    const seen = seenById.get(c.id);
    const seenHoursAgo = seen
      ? Math.max(0, (now - seen.lastSeenAt.getTime()) / (60 * 60 * 1000))
      : Number.POSITIVE_INFINITY;
    let seenMult = 1.0;
    if (seen) {
      const hours = seenHoursAgo;
      const recovery =
        1 - Math.exp(-hours / POSTS_RANKING.forYouSeenHalfLifeHours);
      seenMult =
        POSTS_RANKING.forYouSeenFloor +
        (1 - POSTS_RANKING.forYouSeenFloor) * recovery;
      if (seen.seenCount > 1) {
        const repeatPenalty =
          1 /
          (1 +
            Math.log2(seen.seenCount) *
              POSTS_RANKING.forYouSeenRepeatPenaltyStrength);
        seenMult *= repeatPenalty;
      }
      if (
        seen.lastSource === "feed_scroll" &&
        hours < POSTS_RANKING.forYouRecentFeedSeenExtraPenaltyHours
      ) {
        seenMult *= POSTS_RANKING.forYouRecentFeedSeenExtraPenaltyMult;
      }
    }

    // Only compound the 2.2x bonus when you already follow the author (tiers A/B). For the
    // E tier (friend engaged, stranger/follower author) the social proof is fully captured in
    // forYouFriendCommentedMult — stacking would over-reward the same signal twice.
    const friendMult =
      c.friendEngaged && youFollowThem
        ? POSTS_RANKING.forYouFriendEngagementMult
        : 1.0;
    const followedUnseenMult = c.followingUnseen
      ? POSTS_RANKING.forYouFollowedUnseenMult
      : 1.0;
    const secondDegreePathBonus = c.secondDegree
      ? Math.min(
          POSTS_RANKING.forYouSecondDegreePathBonusMax,
          1 + Math.max(0, c.secondDegreePaths - 1) * 0.15,
        )
      : 1.0;
    const secondDegreeMult = c.secondDegree
      ? POSTS_RANKING.forYouSecondDegreeMult * secondDegreePathBonus
      : 1.0;
    const groupMult = c.memberGroup
      ? POSTS_RANKING.forYouMemberGroupMult
      : c.openFollowGroup
        ? POSTS_RANKING.forYouOpenFollowGroupMult
        : 1.0;
    // Effective age uses the freshest of (post createdAt, latest friend engagement) — a months-old
    // post with a 2h-ago reply from someone the viewer follows ranks like fresh content.
    const friendEngagementMs = c.lastFriendEngagementAt?.getTime() ?? 0;
    const effectiveAtMs = Math.max(
      c.createdAt.getTime(),
      friendEngagementMs,
      conversation?.reply ? Date.parse(conversation.reply.createdAt) : 0,
    );
    const ageHours = Math.max(0, (now - effectiveAtMs) / (60 * 60 * 1000));
    const decay =
      POSTS_RANKING.forYouRecencyFloor +
      (1 - POSTS_RANKING.forYouRecencyFloor) *
        Math.exp(-ageHours / POSTS_RANKING.forYouRecencyHalfLifeHours);
    const freshBoost =
      ageHours < 24
        ? POSTS_RANKING.forYouFreshBoost24h
        : ageHours < 48
          ? POSTS_RANKING.forYouFreshBoost48h
          : ageHours < 72
            ? POSTS_RANKING.forYouFreshBoost72h
            : 1.0;
    const recencyMult = decay * freshBoost;
    const replyMult = c.parentId ? POSTS_RANKING.forYouReplyMult : 1.0;

    // Base score is user-first, not content-first:
    //   - Friend-engaged: social proof (N follows who engaged × weight) dominates over global trending,
    //     so a post engaged by 3 of your follows outranks a viral post with zero social connection.
    //   - Pure discovery (no social connection to author + no second-degree/group signal): global
    //     trending is demoted 40% so strangers' viral content doesn't crowd out social posts.
    //     We check the RELATIONSHIP (youFollowThem/theyFollowYou), not lane flags, because a seen
    //     post from a followed author only enters via trending scan (followingUnseen=false) but still
    //     has a social connection and must NOT be demoted.
    //   - All other cases (author in social graph, second-degree, groups): use trendingScore as-is.
    const rawTrending = 1 + Math.max(0, c.trendingScore ?? 0);
    const socialProofCount = Math.min(
      POSTS_RANKING.forYouSocialProofMaxPeople,
      socialProofCountById.get(c.id) ?? 0,
    );
    const noSocialConnection =
      !youFollowThem &&
      !theyFollowYou &&
      !c.secondDegree &&
      !c.memberGroup &&
      !c.openFollowGroup;
    let rawBase: number;
    if (c.friendEngaged) {
      const socialBase =
        socialProofCount * POSTS_RANKING.forYouSocialProofBaseWeight;
      rawBase = Math.max(socialBase, rawTrending);
    } else if (noSocialConnection) {
      rawBase = rawTrending * 0.4;
    } else {
      rawBase = rawTrending;
    }
    const conversationBonus =
      conversation?.kind === "unanswered"
        ? 1.5
        : conversation?.kind === "newReplies"
          ? 3
          : conversation?.kind === "followUp"
            ? 1
            : 0;
    const base =
      conversationBonus +
      (c.friendEngaged
        ? Math.max(rawBase, POSTS_RANKING.forYouFriendEngagementBaseFloor)
        : rawBase);
    // A pull-to-refresh is the viewer saying "I've read these". The ordinary seen decay
    // recovers over days, which is the right call for a passive reload but far too slow for
    // a deliberate refresh, so hand those slots to unseen candidates.
    const refreshSeenMult =
      isRefreshPage &&
      seenHoursAgo < POSTS_RANKING.forYouRefreshSeenDemotionHours
        ? POSTS_RANKING.forYouRefreshSeenDemotionMult
        : 1.0;
    const unjittered =
      base *
      recencyMult *
      relMult *
      seenMult *
      friendMult *
      followedUnseenMult *
      secondDegreeMult *
      groupMult *
      replyMult *
      refreshSeenMult;
    return { candidate: c, unjittered, seen: Boolean(seen) };
  });
}

export type ForYouPickInput = {
  scored: ForYouScoredCandidate[];
  limit: number;
  /** Anonymous viewers have no seen-history, so they always jitter. */
  isAnonymous: boolean;
  isRefreshPage: boolean;
  jitterSeed: string;
  /** Posts already served in this session; deeper pages fan out from followed authors toward discovery. */
  servedCount: number;
  now: number;
  youFollow: Set<string>;
  followsYou: Set<string>;
  engagedWithAuthorIds: Set<string>;
  seenById: ForYouScoringInput['seenById'];
  conversationContexts: ForYouScoringInput['conversationContexts'];
};

export type ForYouRankedCandidate = { candidate: ForYouCandidate; adjusted: number };

/**
 * Jitter the scored candidates (stronger when the page would be mostly already-seen), order them,
 * reserve the depth-aware followed-unseen quota at the top, and pick the page with the freshness tiers.
 */
export function rankAndPickForYou(input: ForYouPickInput): {
  ranked: ForYouRankedCandidate[];
  picked: ForYouRankedCandidate[];
} {
  const { scored, limit, isAnonymous, isRefreshPage, jitterSeed, servedCount, now, youFollow, followsYou, engagedWithAuthorIds, seenById, conversationContexts } = input;
  // Saturation: how much of the page the viewer would actually be served has it already
  // seen. Measuring the whole candidate pool understates this badly — the discovery scan is
  // mostly low-scoring posts that never reach the page, so the pool reads as fresh while
  // every visible row is something the viewer read hours ago, and the reshuffle that exists
  // for exactly that case never engages.
  const servedSlice = [...scored]
    .sort((a, b) => b.unjittered - a.unjittered)
    .slice(0, limit);
  const saturation = servedSlice.length
    ? servedSlice.filter((r) => r.seen).length / servedSlice.length
    : 0;
  const saturationRamp = Math.max(
    0,
    (saturation - POSTS_RANKING.forYouSeenSaturationJitterThreshold) /
      (1 - POSTS_RANKING.forYouSeenSaturationJitterThreshold),
  );

  // Anon always jitters (no seen-history). Authed first paint stays deterministic for unseen
  // rows; pull-to-refresh uses a floor so a new seed actually moves the page.
  const refreshJitterFloor = isRefreshPage
    ? POSTS_RANKING.forYouRefreshJitterFloor
    : 0;
  const jitterStrengthBase =
    isAnonymous
      ? POSTS_RANKING.forYouAnonJitterStrength
      : Math.max(POSTS_RANKING.forYouSeenJitterBase, refreshJitterFloor);
  const jitterStrength = Math.min(
    1,
    jitterStrengthBase +
      (POSTS_RANKING.forYouSeenSaturationJitterMax - jitterStrengthBase) *
        saturationRamp,
  );

  // Saturation jitter reshuffles already-seen rows so a "seen everything" refresh is not
  // identical. Unseen authed posts keep only the refresh/anon floor — otherwise ±90% jitter
  // can bury a brand-new discovery item under a just-seen trending post.
  const ranked = scored.map(({ candidate, unjittered, seen }) => {
    const postJitterStrength =
      seen || isAnonymous ? jitterStrength : jitterStrengthBase;
    const jitter =
      1 +
      (seededUnitInterval(jitterSeed, candidate.id) * 2 - 1) *
        postJitterStrength;
    return { candidate, adjusted: unjittered * jitter };
  });

  ranked.sort((a, b) => {
    if (b.adjusted !== a.adjusted) return b.adjusted - a.adjusted;
    if (a.candidate.followingUnseen !== b.candidate.followingUnseen)
      return a.candidate.followingUnseen ? -1 : 1;
    if (a.candidate.friendEngaged !== b.candidate.friendEngaged)
      return a.candidate.friendEngaged ? -1 : 1;
    const aBase = a.candidate.trendingScore ?? 0;
    const bBase = b.candidate.trendingScore ?? 0;
    if (bBase !== aBase) return bBase - aBase;
    const at = a.candidate.createdAt.getTime();
    const bt = b.candidate.createdAt.getTime();
    if (bt !== at) return bt - at;
    return a.candidate.id < b.candidate.id ? 1 : -1;
  });

  // Freshness is a priority tier, never just a multiplier: a very popular seen
  // board must not displace an unseen candidate. Diversity is relaxed within
  // each tier before advancing to the next one.
  // Depth-aware quota: the feed fans out from user-first toward social discovery as the viewer
  // scrolls deeper. servedIds.length is the number of posts already served in this session.
  const paginationDepth = servedCount;
  const followedUnseenRatio =
    paginationDepth === 0
      ? 0.7 // page 1: strongly user-first (people you follow dominate)
      : paginationDepth <= 50
        ? 0.55 // page 2: still follow-heavy but opens discovery
        : 0.4; // page 3+: fans out into friend-engaged + second-degree
  const followedQuota = Math.min(
    limit,
    Math.ceil(limit * followedUnseenRatio),
  );
  // The followed-unseen quota is the "tippy top" of the feed. Order it by recency bucket with
  // preference for authors the viewer actively engages with, then mutuals, then recency.
  // Using `ranked`'s `adjusted` score here would bury a brand-new follow post under older
  // follow posts that already accumulated trendingScore — the viewer would refresh and not
  // see the post their friend just sent.
  const bucketHours = POSTS_RANKING.forYouFollowedQuotaBucketHours;
  const followedUnseenSorted = ranked
    .filter((r) => r.candidate.followingUnseen)
    .slice()
    .sort((a, b) => {
      const aAgeH = Math.max(
        0,
        (now - a.candidate.createdAt.getTime()) / (60 * 60 * 1000),
      );
      const bAgeH = Math.max(
        0,
        (now - b.candidate.createdAt.getTime()) / (60 * 60 * 1000),
      );
      const aBucket = Math.floor(aAgeH / bucketHours);
      const bBucket = Math.floor(bAgeH / bucketHours);
      if (aBucket !== bBucket) return aBucket - bBucket;
      // Within bucket: engaged-with authors first (A+ tier), then mutuals (A), then one-way.
      const aEngaged = engagedWithAuthorIds.has(a.candidate.userId);
      const bEngaged = engagedWithAuthorIds.has(b.candidate.userId);
      if (aEngaged !== bEngaged) return aEngaged ? -1 : 1;
      const aMutual =
        youFollow.has(a.candidate.userId) &&
        followsYou.has(a.candidate.userId);
      const bMutual =
        youFollow.has(b.candidate.userId) &&
        followsYou.has(b.candidate.userId);
      if (aMutual !== bMutual) return aMutual ? -1 : 1;
      return (
        b.candidate.createdAt.getTime() - a.candidate.createdAt.getTime()
      );
    });
  // The followed-unseen preference is identical on reload and explicit refresh.
  const preferred = followedUnseenSorted.slice(0, followedQuota);
  const preferredIds = new Set(preferred.map((r) => r.candidate.id));
  const picked = selectFreshForYou([...preferred, ...ranked.filter((r) => !preferredIds.has(r.candidate.id))], {
    limit,
    seenById,
    hasNewReplies: (id) => conversationContexts.get(id)?.kind === "newReplies",
    authorWindow: POSTS_RANKING.forYouMaxPerAuthorWindow,
  });
  return { ranked, picked };
}
