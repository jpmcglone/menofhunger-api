import type { ForYouCandidate } from './posts-feed-for-you-lanes';
import { rankAndPickForYou, scoreForYouCandidates, type ForYouScoringInput } from './posts-feed-for-you-scoring';
import { POSTS_RANKING } from './posts-ranking.config';

const NOW = Date.parse('2026-10-08T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;

function candidate(overrides: Partial<ForYouCandidate> = {}): ForYouCandidate {
  return {
    id: 'p1',
    userId: 'author',
    parentId: null,
    communityGroupId: null,
    createdAt: new Date(NOW - 2 * HOUR),
    trendingScore: 10,
    followingUnseen: false,
    friendEngaged: false,
    secondDegree: false,
    secondDegreePaths: 0,
    memberGroup: false,
    openFollowGroup: false,
    lastFriendEngagementAt: null,
    ...overrides,
  };
}

function score(overrides: Partial<ForYouScoringInput> & { candidate?: ForYouCandidate } = {}) {
  const { candidate: c = candidate(), ...rest } = overrides;
  const [row] = scoreForYouCandidates({
    candidates: [c],
    conversationContexts: new Map(),
    youFollow: new Set(),
    followsYou: new Set(),
    engagedWithAuthorIds: new Set(),
    socialProofCountById: new Map(),
    seenById: new Map(),
    now: NOW,
    isRefreshPage: false,
    ...rest,
  });
  return row!;
}

describe('scoreForYouCandidates', () => {
  it('ranks relationship tiers: engaged > mutual > following > follower > stranger', () => {
    const engaged = score({ youFollow: new Set(['author']), engagedWithAuthorIds: new Set(['author']) });
    const mutual = score({ youFollow: new Set(['author']), followsYou: new Set(['author']) });
    const following = score({ youFollow: new Set(['author']) });
    const follower = score({ followsYou: new Set(['author']) });
    const stranger = score();
    const order = [engaged, mutual, following, follower, stranger].map((r) => r.unjittered);
    expect(order).toEqual([...order].sort((a, b) => b - a));
    expect(new Set(order).size).toBe(5);
  });

  it('demotes a pure-discovery post by 40% but not one from a followed author', () => {
    const stranger = score();
    const followed = score({ youFollow: new Set(['author']) });
    const strangerBase = stranger.unjittered / POSTS_RANKING.forYouRelMultStranger;
    const followedBase = followed.unjittered / POSTS_RANKING.forYouRelMultFollowing;
    expect(strangerBase / followedBase).toBeCloseTo(0.4, 5);
  });

  it('floors a seen post at the seen multiplier and recovers it over time', () => {
    const fresh = score();
    const justSeen = score({ seenById: new Map([['p1', { lastSeenAt: new Date(NOW), seenCount: 1, lastSource: 'post_open' }]]) });
    const seenLongAgo = score({ seenById: new Map([['p1', { lastSeenAt: new Date(NOW - 14 * 24 * HOUR), seenCount: 1, lastSource: 'post_open' }]]) });
    expect(justSeen.seen).toBe(true);
    expect(fresh.seen).toBe(false);
    expect(justSeen.unjittered).toBeCloseTo(fresh.unjittered * POSTS_RANKING.forYouSeenFloor, 5);
    expect(seenLongAgo.unjittered).toBeGreaterThan(justSeen.unjittered * 5);
  });

  it('penalizes repeat views and recent feed-scroll sightings more than a single open', () => {
    const base = { lastSeenAt: new Date(NOW - 2 * HOUR) };
    const once = score({ seenById: new Map([['p1', { ...base, seenCount: 1, lastSource: 'post_open' }]]) });
    const repeated = score({ seenById: new Map([['p1', { ...base, seenCount: 8, lastSource: 'post_open' }]]) });
    const scrolled = score({ seenById: new Map([['p1', { ...base, seenCount: 1, lastSource: 'feed_scroll' }]]) });
    expect(repeated.unjittered).toBeLessThan(once.unjittered);
    expect(scrolled.unjittered).toBeLessThan(once.unjittered);
  });

  it('demotes recently seen posts harder on a pull-to-refresh page', () => {
    const seenById = new Map([['p1', { lastSeenAt: new Date(NOW - HOUR), seenCount: 1, lastSource: 'post_open' }]]);
    const normal = score({ seenById });
    const refresh = score({ seenById, isRefreshPage: true });
    expect(refresh.unjittered).toBeCloseTo(normal.unjittered * POSTS_RANKING.forYouRefreshSeenDemotionMult, 5);
  });

  it('prefers newer posts and replaces age with the latest friend engagement', () => {
    const old = score({ candidate: candidate({ createdAt: new Date(NOW - 30 * 24 * HOUR) }) });
    const engagedRecently = score({
      candidate: candidate({ createdAt: new Date(NOW - 30 * 24 * HOUR), friendEngaged: true, lastFriendEngagementAt: new Date(NOW - HOUR) }),
      youFollow: new Set(['author']),
    });
    const recent = score({ candidate: candidate({ createdAt: new Date(NOW - HOUR) }) });
    expect(recent.unjittered).toBeGreaterThan(old.unjittered);
    expect(engagedRecently.unjittered).toBeGreaterThan(old.unjittered);
  });

  it('lifts a followed-unseen post and dampens replies', () => {
    const plain = score({ youFollow: new Set(['author']) });
    const unseen = score({ candidate: candidate({ followingUnseen: true }), youFollow: new Set(['author']) });
    const reply = score({ candidate: candidate({ parentId: 'root' }), youFollow: new Set(['author']) });
    expect(unseen.unjittered).toBeCloseTo(plain.unjittered * POSTS_RANKING.forYouFollowedUnseenMult, 5);
    expect(reply.unjittered).toBeCloseTo(plain.unjittered * POSTS_RANKING.forYouReplyMult, 5);
  });

  it('adds the conversation bonus to the base before multipliers', () => {
    const plain = score({ youFollow: new Set(['author']) });
    const withBonus = score({
      youFollow: new Set(['author']),
      conversationContexts: new Map([['p1', { kind: 'newReplies' }]]) as ForYouScoringInput['conversationContexts'],
    });
    expect(withBonus.unjittered).toBeGreaterThan(plain.unjittered);
  });
});

describe('rankAndPickForYou', () => {
  function pick(candidates: ForYouCandidate[], overrides: Partial<Parameters<typeof rankAndPickForYou>[0]> = {}) {
    const input = {
      candidates,
      conversationContexts: new Map() as ForYouScoringInput['conversationContexts'],
      youFollow: new Set<string>(),
      followsYou: new Set<string>(),
      engagedWithAuthorIds: new Set<string>(),
      socialProofCountById: new Map<string, number>(),
      seenById: new Map(),
      now: NOW,
      isRefreshPage: false,
    };
    const scored = scoreForYouCandidates(input);
    return rankAndPickForYou({
      scored,
      limit: 4,
      isAnonymous: false,
      isRefreshPage: false,
      jitterSeed: 'seed-1',
      servedCount: 0,
      now: NOW,
      youFollow: input.youFollow,
      followsYou: input.followsYou,
      engagedWithAuthorIds: input.engagedWithAuthorIds,
      seenById: input.seenById,
      conversationContexts: input.conversationContexts,
      ...overrides,
    });
  }

  const pool = Array.from({ length: 8 }, (_, i) =>
    candidate({ id: `p${i}`, userId: `a${i}`, trendingScore: 100 - i * 10, createdAt: new Date(NOW - (i + 1) * HOUR) }),
  );

  it('is deterministic for an authed viewer with nothing seen', () => {
    const a = pick(pool).picked.map((r) => r.candidate.id);
    const b = pick(pool, { jitterSeed: 'seed-2' }).picked.map((r) => r.candidate.id);
    expect(a).toEqual(b);
    expect(a).toHaveLength(4);
  });

  it('reshuffles anonymous viewers when the seed changes', () => {
    const orders = new Set(
      ['s1', 's2', 's3', 's4', 's5'].map((seed) => pick(pool, { isAnonymous: true, jitterSeed: seed }).ranked.map((r) => r.candidate.id).join(',')),
    );
    expect(orders.size).toBeGreaterThan(1);
  });

  it('puts followed-unseen posts at the top ahead of higher-scoring posts', () => {
    const followed = candidate({ id: 'followed', userId: 'friend', followingUnseen: true, trendingScore: 0, createdAt: new Date(NOW - 5 * HOUR) });
    const { picked } = pick([...pool, followed], { youFollow: new Set(['friend']) });
    expect(picked[0]!.candidate.id).toBe('followed');
  });

  it('prefers a fresher followed-unseen post over an older one regardless of trending score', () => {
    const older = candidate({ id: 'older', userId: 'f1', followingUnseen: true, trendingScore: 500, createdAt: new Date(NOW - 20 * HOUR) });
    const newer = candidate({ id: 'newer', userId: 'f2', followingUnseen: true, trendingScore: 0, createdAt: new Date(NOW - HOUR) });
    const { picked } = pick([older, newer], { youFollow: new Set(['f1', 'f2']) });
    expect(picked.map((r) => r.candidate.id)).toEqual(['newer', 'older']);
  });

  it('never returns more than the page limit', () => {
    expect(pick(pool, { limit: 2 }).picked).toHaveLength(2);
  });
});
