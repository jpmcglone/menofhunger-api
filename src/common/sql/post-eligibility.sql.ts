import { Prisma } from '@prisma/client';

/** Published, non-deleted post. Expects the `"Post"` table aliased as `p`. */
export const PUBLISHED_POST_SQL = Prisma.sql`p."deletedAt" IS NULL AND p."isDraft" = false`;

/** Author who counts toward public rankings: not banned, not a bot. Expects the `"User"` table aliased as `u`. */
export const RANKED_AUTHOR_SQL = Prisma.sql`u."bannedAt" IS NULL AND u."isBot" = false`;
