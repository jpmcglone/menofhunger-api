import { MENTION_USER_SELECT, USER_LIST_SELECT } from '../prisma-selects/user.select';

/**
 * Centralized Prisma include shapes for Post queries that return posts to clients.
 * Keeping these in one place makes it much harder to regress into overfetch or inconsistent ordering.
 */

export const POST_BASE_INCLUDE = {
  user: { select: USER_LIST_SELECT },
  media: { orderBy: { position: 'asc' as const } },
  mentions: { include: { user: { select: MENTION_USER_SELECT } } },
} as const;

export const POST_WITH_POLL_INCLUDE = {
  ...POST_BASE_INCLUDE,
  poll: { include: { options: { orderBy: { position: 'asc' as const } } } },
} as const;

