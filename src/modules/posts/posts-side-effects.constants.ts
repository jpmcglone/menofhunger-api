import type { Prisma } from '@prisma/client';
import { POST_LIST_INCLUDE } from '../../common/prisma-includes/post.include';

/** Thread participant role for reply notifications. */
export const REPLY_TITLE = {
  root_author: 'replied to your post',
  reply_author: 'replied to your comment',
  mentioned_in_root: "replied to a post you're mentioned in",
  mentioned_in_reply: "replied to a comment you're mentioned in",
} as const;

/** Same roles, worded for Board threads so the row and push name the Board. */
export const BOARD_REPLY_TITLE: Record<keyof typeof REPLY_TITLE, string> = {
  root_author: 'commented on your Board post',
  reply_author: 'replied to your Board comment',
  mentioned_in_root: "commented on a Board post you're mentioned in",
  mentioned_in_reply: "replied to a Board comment you're mentioned in",
};

export type ReplyRole = keyof typeof REPLY_TITLE;

export type ThreadPostForRoles = {
  id: string;
  parentId: string | null;
  userId: string;
  mentions: { userId: string }[];
};

export type PostWithRelations = Prisma.PostGetPayload<{ include: typeof POST_LIST_INCLUDE }>;
