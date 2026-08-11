/**
 * Pure ranking helpers for end-of-thread "Discover more".
 * Kept free of Nest/Prisma so unit tests can drive scoring without I/O.
 */

export type DiscoverCandidate = {
  id: string;
  userId: string;
  topics: string[];
  hashtags: string[];
  trendingScore: number;
  createdAt: Date;
  /** Which buckets contributed this row (for debugging / tests). */
  buckets: Array<'hashtag' | 'topic' | 'author' | 'trending'>;
};

export type DiscoverSeedSignals = {
  topics: string[];
  hashtags: string[];
  authorUserId: string;
};

export type DiscoverViewerSignals = {
  followedAuthorIds: Set<string>;
  followedTopics: Set<string>;
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function overlapCount(a: string[], b: Set<string>): number {
  if (!a.length || !b.size) return 0;
  let n = 0;
  for (const x of a) {
    if (b.has(x)) n += 1;
  }
  return n;
}

export function scoreDiscoverCandidate(
  c: DiscoverCandidate,
  seed: DiscoverSeedSignals,
  viewer: DiscoverViewerSignals | null,
  nowMs: number = Date.now(),
): number {
  const seedTopics = new Set(seed.topics);
  const seedHashtags = new Set(seed.hashtags.map((h) => h.toLowerCase()));
  const candHashtags = c.hashtags.map((h) => h.toLowerCase());

  const hashtagOverlap = overlapCount(candHashtags, seedHashtags);
  const topicOverlap = overlapCount(c.topics, seedTopics);
  const followsAuthor = viewer?.followedAuthorIds.has(c.userId) ? 1 : 0;
  const topicFollowOverlap = viewer ? overlapCount(c.topics, viewer.followedTopics) : 0;
  const ageDays = Math.max(0, (nowMs - c.createdAt.getTime()) / MS_PER_DAY);
  const recency = Math.exp(-ageDays / 14); // ~half-life 10 days

  return (
    3.0 * hashtagOverlap +
    2.0 * topicOverlap +
    1.5 * followsAuthor +
    1.0 * topicFollowOverlap +
    0.8 * Math.log1p(Math.max(0, c.trendingScore)) +
    0.5 * recency +
    (c.userId === seed.authorUserId ? 0.3 : 0)
  );
}

/** Merge bucket rows by id, unioning bucket tags. */
export function mergeDiscoverCandidates(rows: DiscoverCandidate[]): DiscoverCandidate[] {
  const byId = new Map<string, DiscoverCandidate>();
  for (const row of rows) {
    const prev = byId.get(row.id);
    if (!prev) {
      byId.set(row.id, { ...row, buckets: [...row.buckets] });
      continue;
    }
    const buckets = new Set([...prev.buckets, ...row.buckets]);
    byId.set(row.id, {
      ...prev,
      topics: prev.topics.length >= row.topics.length ? prev.topics : row.topics,
      hashtags: prev.hashtags.length >= row.hashtags.length ? prev.hashtags : row.hashtags,
      trendingScore: Math.max(prev.trendingScore, row.trendingScore),
      buckets: Array.from(buckets) as DiscoverCandidate['buckets'],
    });
  }
  return Array.from(byId.values());
}

/**
 * Sort by score desc, then apply per-author diversity (max N from same author).
 * Returns ordered ids.
 */
export function rankDiscoverCandidates(params: {
  candidates: DiscoverCandidate[];
  seed: DiscoverSeedSignals;
  viewer: DiscoverViewerSignals | null;
  maxPerAuthor?: number;
  nowMs?: number;
}): string[] {
  const maxPerAuthor = Math.max(1, params.maxPerAuthor ?? 2);
  const scored = params.candidates
    .map((c) => ({
      id: c.id,
      userId: c.userId,
      score: scoreDiscoverCandidate(c, params.seed, params.viewer, params.nowMs),
    }))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));

  const out: string[] = [];
  const perAuthor = new Map<string, number>();
  for (const row of scored) {
    const n = perAuthor.get(row.userId) ?? 0;
    if (n >= maxPerAuthor) continue;
    perAuthor.set(row.userId, n + 1);
    out.push(row.id);
  }
  return out;
}

/** Paginate an ordered id list using the last-seen id as cursor. */
export function pageDiscoverIds(params: {
  orderedIds: string[];
  cursor: string | null;
  limit: number;
}): { ids: string[]; nextCursor: string | null } {
  const limit = Math.max(1, Math.min(50, Math.floor(params.limit || 8)));
  let start = 0;
  const cursor = (params.cursor ?? '').trim();
  if (cursor) {
    const idx = params.orderedIds.indexOf(cursor);
    start = idx >= 0 ? idx + 1 : 0;
  }
  const slice = params.orderedIds.slice(start, start + limit + 1);
  const hasMore = slice.length > limit;
  const ids = hasMore ? slice.slice(0, limit) : slice;
  const nextCursor = hasMore && ids.length ? ids[ids.length - 1]! : null;
  return { ids, nextCursor };
}
