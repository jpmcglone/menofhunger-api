import { Prisma } from '@prisma/client';
import { POST_MEDIA_FEED_INCLUDE, POST_WITH_POLL_INCLUDE } from '../../common/prisma-includes/post.include';

/** Shared row/result shapes for the posts feed-query and mutation services. */

export type PostCounts = {
  all: number;
  public: number;
  verifiedOnly: number;
  premiumOnly: number;
};

export const feedPostInclude = POST_WITH_POLL_INCLUDE;
export const mediaFeedPostInclude = POST_MEDIA_FEED_INCLUDE;
export type FeedPost = Prisma.PostGetPayload<{ include: typeof feedPostInclude }>;
export type FeedResult = { posts: FeedPost[]; nextCursor: string | null };
export type PopularFeedResult = FeedResult & { scoreByPostId: Map<string, number> };
