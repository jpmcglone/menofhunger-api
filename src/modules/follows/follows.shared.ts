import type { VerifiedStatus } from '@prisma/client';

export const RECOMMENDATIONS_CACHE_TTL_SECONDS = 15 * 60;
/** Cosine distance under which a member profile counts as a match for an intent. */
export const MEANING_MAX_DISTANCE = 0.7;
export const RECOMMENDATION_POOL_MULTIPLIER = 8;
export const RECOMMENDATION_MAX_POOL_SIZE = 200;
export const RECOMMENDATION_JITTER_MAX = 7;
export const RECOMMENDATION_FRESHNESS_DAYS = 90;
export const RECOMMENDATION_SAME_STATE_WEIGHT = 10;

export type RecommendationRow = {
  id: string;
  username: string | null;
  name: string | null;
  premium: boolean;
  premiumPlus: boolean;
  isOrganization: boolean;
  verifiedStatus: VerifiedStatus;
  avatarKey: string | null; avatarVideoKey?: string | null; avatarVideoDurationMs?: number | null;
  avatarUpdatedAt: Date | null;
  createdAt: Date;
  mutualCount: number;
  overlapCount: number;
  topicOverlapCount: number;
  groupOverlapCount: number;
  searchedForCandidate: boolean;
  followsViewer: boolean;
  sameState: boolean;
};
