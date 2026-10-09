import { Prisma } from '@prisma/client';
import { USER_LIST_SELECT } from '../../common/prisma-selects/user.select';

export const MAX_HIDDEN_PREVIEWS = 10;
export const MESSAGE_INCLUDE = {
  sender: { select: USER_LIST_SELECT },
  reactions: { include: { user: { select: USER_LIST_SELECT } }, orderBy: { createdAt: 'asc' as const } },
  media: { orderBy: [{ createdAt: 'asc' as const }, { id: 'asc' as const }] },
  channelPins: true,
  replyTo: {
    include: {
      sender: { select: { username: true } },
      media: { orderBy: [{ createdAt: 'asc' as const }, { id: 'asc' as const }] },
    },
  },
  threadReplies: {
    where: { deletedForAll: false },
    select: { createdAt: true },
    orderBy: { createdAt: 'desc' as const },
    take: 1,
  },
  _count: { select: { threadReplies: { where: { deletedForAll: false } } } },
} satisfies Prisma.MessageInclude;
export type MessageRow = Prisma.MessageGetPayload<{ include: typeof MESSAGE_INCLUDE }>;
/** A deleted message stays visible only as the placeholder root of replies that remain. */
export const VISIBLE_MESSAGE = {
  OR: [{ deletedForAll: false }, { threadRootId: null, threadReplies: { some: { deletedForAll: false } } }],
} satisfies Prisma.MessageWhereInput;
export const WELCOME_PREFIX = 'welcome:';
