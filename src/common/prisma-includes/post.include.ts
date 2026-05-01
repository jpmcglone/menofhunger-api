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

/** Minimal author fields needed for ArticleSharePreviewDto (a strict subset of articleAuthorInclude). */
export const ARTICLE_SHARE_AUTHOR_SELECT = {
  id: true,
  username: true,
  name: true,
  premium: true,
  premiumPlus: true,
  isOrganization: true,
  stewardBadgeEnabled: true,
  verifiedStatus: true,
  avatarKey: true,
  avatarUpdatedAt: true,
} as const;

/** Minimal article fields needed to build ArticleSharePreviewDto. */
export const ARTICLE_SHARE_INCLUDE = {
  select: {
    id: true,
    title: true,
    excerpt: true,
    thumbnailR2Key: true,
    visibility: true,
    publishedAt: true,
    author: { select: ARTICLE_SHARE_AUTHOR_SELECT },
  },
} as const;

export const POST_WITH_POLL_INCLUDE = {
  ...POST_BASE_INCLUDE,
  poll: { include: { options: { orderBy: { position: 'asc' as const } } } },
  article: ARTICLE_SHARE_INCLUDE,
} as const;

export const POST_MEDIA_FEED_INCLUDE = {
  user: { select: USER_LIST_SELECT },
  media: { orderBy: { position: 'asc' as const } },
} as const;

