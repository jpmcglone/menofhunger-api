import { NOT_BANNED_USER_WHERE } from '../../common/prisma-selects/user.where';
import { Prisma } from '@prisma/client';
import { NOT_DELETED } from '../../common/prisma/where';

/**
 * Shared Prisma where-clause builders for post queries. Centralized so every
 * feed/list/lookup applies the same guardrails.
 */

/**
 * Centralized guardrail: any query that *returns posts* should include this.
 * This prevents accidentally surfacing soft-deleted posts via new endpoints.
 */
export function notDeletedWhere(): Prisma.PostWhereInput {
  return { ...NOT_DELETED };
}

/**
 * Global/profile/trending feed scope: excludes community-group posts and Board-only rows
 * (Board comments and threads not cross-posted to the feed).
 */
export function excludeCommunityGroupPostsWhere(): Prisma.PostWhereInput {
  return { communityGroupId: null, boardOnly: false };
}

/** Board-only rows never appear on global feeds; see `excludeCommunityGroupPostsWhere`. */
export function excludeBoardOnlyWhere(): Prisma.PostWhereInput {
  return { boardOnly: false };
}

export function mediaOnlyWhere(): Prisma.PostWhereInput {
  return { media: { some: NOT_DELETED } };
}

/**
 * Exclude posts by banned users from feeds and listings.
 * Banned users' posts may still appear in single-post/thread context but are redacted in toPostDto.
 */
export function userNotBannedWhere(): Prisma.PostWhereInput {
  return { user: NOT_BANNED_USER_WHERE };
}
