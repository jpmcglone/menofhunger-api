import type { Prisma } from '@prisma/client';

/** Apply at query time too, so a new block/mute immediately hides older attention. */
export function personalChannelMessageWhere(userId: string): Prisma.MessageWhereInput {
  return {
    deletedForAll: false,
    sender: {
      blocksInitiated: { none: { blockedId: userId } },
      blocksReceived: { none: { blockerId: userId } },
      mutesReceived: { none: { muterId: userId } },
    },
  };
}
