import { Prisma } from '@prisma/client';

/**
 * Shared Prisma where-clause builders for post queries. Centralized so every
 * feed/list/lookup applies the same guardrails.
 */

/**
 * Centralized guardrail: any query that *returns posts* should include this.
 * This prevents accidentally surfacing soft-deleted posts via new endpoints.
 */
export function notDeletedWhere(): Prisma.PostWhereInput {
  return { deletedAt: null };
}

/** Community-group posts must not appear on global/profile/trending feeds. */
export function excludeCommunityGroupPostsWhere(): Prisma.PostWhereInput {
  return { communityGroupId: null };
}

export function mediaOnlyWhere(): Prisma.PostWhereInput {
  return { media: { some: { deletedAt: null } } };
}

/**
 * Exclude posts by banned users from feeds and listings.
 * Banned users' posts may still appear in single-post/thread context but are redacted in toPostDto.
 */
export function userNotBannedWhere(): Prisma.PostWhereInput {
  return { user: { bannedAt: null } };
}
