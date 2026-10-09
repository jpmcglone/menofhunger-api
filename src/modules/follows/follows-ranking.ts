import * as crypto from 'node:crypto';
import { Prisma } from '@prisma/client';
import { RECOMMENDATION_FRESHNESS_DAYS, RECOMMENDATION_JITTER_MAX, RECOMMENDATION_MAX_POOL_SIZE, RECOMMENDATION_POOL_MULTIPLIER, RECOMMENDATION_SAME_STATE_WEIGHT, type RecommendationRow } from './follows.shared';

export function recommendationsCacheKey(
  viewerUserId: string,
  limit: number,
  interestKeys: string[] | null,
  seed: string,
): string {
  const interestsPart = interestKeys && interestKeys.length > 0
    ? crypto.createHash('sha1').update([...interestKeys].sort().join(',').toLowerCase()).digest('hex').slice(0, 12)
    : 'none';
  const seedPart = crypto.createHash('sha1').update(seed).digest('hex').slice(0, 12);
  return `follows:recs:v2:${viewerUserId}:${limit}:${interestsPart}:${seedPart}`;
}
export function blockExclusionSql(viewerUserId: string): Prisma.Sql {
  return Prisma.sql`
    AND NOT EXISTS (
      SELECT 1
      FROM "UserBlock" ub
      WHERE (ub."blockerId" = ${viewerUserId} AND ub."blockedId" = u."id")
         OR (ub."blockerId" = u."id" AND ub."blockedId" = ${viewerUserId})
    )
  `;
}
export function recommendationSeed(seed: string | undefined): string {
  const explicit = (seed ?? '').trim();
  if (explicit) return explicit.slice(0, 80);

  const day = new Date().toISOString().slice(0, 10);
  return `daily:${day}`;
}
export function recommendationPoolLimit(limit: number): number {
  return Math.max(limit, Math.min(RECOMMENDATION_MAX_POOL_SIZE, limit * RECOMMENDATION_POOL_MULTIPLIER));
}
export function recommendationJitter(input: string): number {
  const hex = crypto.createHash('sha256').update(input).digest('hex').slice(0, 8);
  return Number.parseInt(hex, 16) / 0xffffffff;
}
export function scoreRecommendationRow(row: RecommendationRow, params: { viewerUserId: string; seed: string }): number {
  const ageMs = Math.max(0, Date.now() - row.createdAt.getTime());
  const ageDays = ageMs / (24 * 60 * 60 * 1000);
  const freshness = Math.max(0, 1 - ageDays / RECOMMENDATION_FRESHNESS_DAYS) * 4;
  const trust = (row.verifiedStatus !== 'none' ? 8 : 0) + (row.premiumPlus ? 6 : row.premium ? 3 : 0);
  const profileQuality = (row.avatarKey ? 2 : 0) + (row.name?.trim() ? 1 : 0);
  const relevance =
    Math.min(Math.max(row.mutualCount, 0), 5) * 24 +
    Math.min(Math.max(row.overlapCount, 0), 4) * 16 +
    Math.min(Math.max(row.topicOverlapCount ?? 0, 0), 4) * 20 +
    Math.min(Math.max(row.groupOverlapCount ?? 0, 0), 3) * 22 +
    (row.searchedForCandidate ? 28 : 0) +
    (row.followsViewer ? 12 : 0) +
    (row.sameState ? RECOMMENDATION_SAME_STATE_WEIGHT : 0);
  const jitter = recommendationJitter(`${params.viewerUserId}:${row.id}:${params.seed}`) * RECOMMENDATION_JITTER_MAX;

  return relevance + trust + profileQuality + freshness + jitter;
}
export function rankRecommendationRows(
  rows: RecommendationRow[],
  params: { viewerUserId: string; seed: string; limit: number },
): RecommendationRow[] {
  return [...rows]
    .sort((a, b) => {
      const scoreDiff =
        scoreRecommendationRow(b, params) - scoreRecommendationRow(a, params);
      if (Math.abs(scoreDiff) > 0.000001) return scoreDiff;
      return b.createdAt.getTime() - a.createdAt.getTime() || a.id.localeCompare(b.id);
    })
    .slice(0, params.limit);
}