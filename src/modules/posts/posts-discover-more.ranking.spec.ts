import {
  discoverUnitNoise,
  mergeDiscoverCandidates,
  pageDiscoverIds,
  rankDiscoverCandidates,
  scoreDiscoverCandidate,
  type DiscoverCandidate,
  type DiscoverViewerSignals,
} from './posts-discover-more.ranking';

function cand(partial: Partial<DiscoverCandidate> & { id: string }): DiscoverCandidate {
  return {
    userId: partial.userId ?? 'author-a',
    topics: partial.topics ?? [],
    hashtags: partial.hashtags ?? [],
    trendingScore: partial.trendingScore ?? 0,
    createdAt: partial.createdAt ?? new Date('2026-08-01T00:00:00.000Z'),
    buckets: partial.buckets ?? ['topic'],
    id: partial.id,
  };
}

function viewer(partial?: Partial<DiscoverViewerSignals>): DiscoverViewerSignals {
  return {
    viewerUserId: partial?.viewerUserId ?? 'viewer',
    followedAuthorIds: partial?.followedAuthorIds ?? new Set(),
    followedTopics: partial?.followedTopics ?? new Set(),
    viewedPostIds: partial?.viewedPostIds ?? new Set(),
  };
}

describe('posts-discover-more.ranking', () => {
  const seed = {
    topics: ['faith', 'bible'],
    hashtags: ['prayer'],
    authorUserId: 'seed-author',
  };
  const nowMs = new Date('2026-08-10T00:00:00.000Z').getTime();

  it('scores hashtag overlap higher than topic overlap', () => {
    const hashtagHit = scoreDiscoverCandidate(
      cand({ id: '1', hashtags: ['prayer'], topics: [] }),
      seed,
      null,
      nowMs,
    );
    const topicHit = scoreDiscoverCandidate(
      cand({ id: '2', hashtags: [], topics: ['faith'] }),
      seed,
      null,
      nowMs,
    );
    expect(hashtagHit).toBeGreaterThan(topicHit);
  });

  it('boosts followed authors and topic follows for the viewer', () => {
    const base = scoreDiscoverCandidate(cand({ id: '1', topics: ['faith'], userId: 'u1' }), seed, null, nowMs);
    const boosted = scoreDiscoverCandidate(
      cand({ id: '1', topics: ['faith'], userId: 'u1' }),
      seed,
      viewer({
        followedAuthorIds: new Set(['u1']),
        followedTopics: new Set(['faith']),
      }),
      nowMs,
    );
    expect(boosted).toBeGreaterThan(base);
  });

  it('boosts unseen posts over already-viewed posts for the viewer', () => {
    const unseen = scoreDiscoverCandidate(
      cand({ id: 'unseen', topics: ['faith'] }),
      seed,
      viewer({ viewedPostIds: new Set() }),
      nowMs,
    );
    const seen = scoreDiscoverCandidate(
      cand({ id: 'seen', topics: ['faith'] }),
      seed,
      viewer({ viewedPostIds: new Set(['seen']) }),
      nowMs,
    );
    expect(unseen).toBeGreaterThan(seen);
  });

  it('soft-demotes the viewer own posts and the seed author', () => {
    const other = scoreDiscoverCandidate(
      cand({ id: '1', topics: ['faith'], userId: 'other' }),
      seed,
      viewer({ viewerUserId: 'viewer' }),
      nowMs,
    );
    const own = scoreDiscoverCandidate(
      cand({ id: '2', topics: ['faith'], userId: 'viewer' }),
      seed,
      viewer({ viewerUserId: 'viewer' }),
      nowMs,
    );
    const seedAuthor = scoreDiscoverCandidate(
      cand({ id: '3', topics: ['faith'], userId: 'seed-author' }),
      seed,
      viewer({ viewerUserId: 'viewer' }),
      nowMs,
    );
    expect(other).toBeGreaterThan(own);
    expect(other).toBeGreaterThan(seedAuthor);
  });

  it('merges bucket tags and dedupes by id', () => {
    const merged = mergeDiscoverCandidates([
      cand({ id: 'a', buckets: ['hashtag'], topics: ['faith'] }),
      cand({ id: 'a', buckets: ['topic'], topics: ['faith', 'bible'] }),
      cand({ id: 'b', buckets: ['trending'] }),
      cand({ id: 'c', buckets: ['following'] }),
    ]);
    expect(merged).toHaveLength(3);
    const a = merged.find((c) => c.id === 'a')!;
    expect(a.buckets.sort()).toEqual(['hashtag', 'topic']);
    expect(a.topics).toEqual(['faith', 'bible']);
  });

  it('applies per-author diversity when ranking', () => {
    const ids = rankDiscoverCandidates({
      candidates: [
        cand({ id: '1', userId: 'same', topics: ['faith', 'bible'], hashtags: ['prayer'], trendingScore: 100 }),
        cand({ id: '2', userId: 'same', topics: ['faith'], trendingScore: 90 }),
        cand({ id: '3', userId: 'same', topics: ['bible'], trendingScore: 80 }),
        cand({ id: '4', userId: 'other', topics: ['faith'], trendingScore: 10 }),
      ],
      seed,
      viewer: null,
      maxPerAuthor: 2,
      nowMs,
    });
    expect(ids.filter((id) => id === '1' || id === '2' || id === '3')).toHaveLength(2);
    expect(ids).toContain('4');
    expect(ids).not.toContain('3');
  });

  it('ranks unseen above equally related seen posts', () => {
    const ids = rankDiscoverCandidates({
      candidates: [
        cand({ id: 'seen', topics: ['faith'], trendingScore: 5 }),
        cand({ id: 'unseen', topics: ['faith'], trendingScore: 5 }),
      ],
      seed,
      viewer: viewer({ viewedPostIds: new Set(['seen']) }),
      nowMs,
    });
    expect(ids[0]).toBe('unseen');
    expect(ids).toContain('seen');
  });

  it('varies order with shuffle seed but stays stable for the same seed', () => {
    const candidates = [
      cand({ id: 'a', userId: 'u1', topics: ['faith'], trendingScore: 5 }),
      cand({ id: 'b', userId: 'u2', topics: ['faith'], trendingScore: 5 }),
      cand({ id: 'c', userId: 'u3', topics: ['faith'], trendingScore: 5 }),
      cand({ id: 'd', userId: 'u4', topics: ['bible'], trendingScore: 5 }),
    ];
    const seededA = rankDiscoverCandidates({
      candidates,
      seed,
      viewer: null,
      nowMs,
      shuffleSeed: 'session-1',
    });
    const seededAAgain = rankDiscoverCandidates({
      candidates,
      seed,
      viewer: null,
      nowMs,
      shuffleSeed: 'session-1',
    });
    const seededB = rankDiscoverCandidates({
      candidates,
      seed,
      viewer: null,
      nowMs,
      shuffleSeed: 'session-2',
    });
    expect(seededA).toEqual(seededAAgain);
    expect(seededA).toHaveLength(4);
    expect(new Set(seededA)).toEqual(new Set(['a', 'b', 'c', 'd']));
    // Different seeds should almost always reorder near-ties; assert at least noise differs.
    const noiseDiffers = ['a', 'b', 'c', 'd'].some(
      (id) => discoverUnitNoise('session-1', id) !== discoverUnitNoise('session-2', id),
    );
    expect(noiseDiffers).toBe(true);
    expect(seededA.join(',')).not.toBe(seededB.join(','));
  });

  it('paginates with last-id cursor', () => {
    const page1 = pageDiscoverIds({ orderedIds: ['a', 'b', 'c', 'd', 'e'], cursor: null, limit: 2 });
    expect(page1.ids).toEqual(['a', 'b']);
    expect(page1.nextCursor).toBe('b');
    const page2 = pageDiscoverIds({ orderedIds: ['a', 'b', 'c', 'd', 'e'], cursor: 'b', limit: 2 });
    expect(page2.ids).toEqual(['c', 'd']);
    expect(page2.nextCursor).toBe('d');
    const page3 = pageDiscoverIds({ orderedIds: ['a', 'b', 'c', 'd', 'e'], cursor: 'd', limit: 2 });
    expect(page3.ids).toEqual(['e']);
    expect(page3.nextCursor).toBeNull();
  });

  it('falls back to start when cursor id is unknown', () => {
    const page = pageDiscoverIds({ orderedIds: ['a', 'b'], cursor: 'missing', limit: 2 });
    expect(page.ids).toEqual(['a', 'b']);
  });
});
