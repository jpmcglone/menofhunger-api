import { Prisma } from '@prisma/client';
import { POST_MEDIA_FEED_INCLUDE, POST_LIST_INCLUDE } from '../../common/prisma-includes/post.include';

/** Shared row/result shapes for the posts feed-query and mutation services. */

/**
 * Author totals shown alongside a profile feed. `all` is the sum of the three
 * audience tiers — only-me posts are excluded, since they never appear in the
 * feed these counts label.
 */
export type PostCounts = {
  all: number;
  public: number;
  verifiedOnly: number;
  premiumOnly: number;
};

export const feedPostInclude = POST_LIST_INCLUDE;
export const mediaFeedPostInclude = POST_MEDIA_FEED_INCLUDE;
export type FeedPost = Prisma.PostGetPayload<{ include: typeof feedPostInclude }>;
export type FeedResult = { posts: FeedPost[]; nextCursor: string | null };
export type PopularFeedResult = FeedResult & { scoreByPostId: Map<string, number> };
