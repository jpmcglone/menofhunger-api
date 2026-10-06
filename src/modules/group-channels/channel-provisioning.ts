import type { Prisma } from '@prisma/client';
import { DEFAULT_CHANNELS } from './channel-policy';

/** Call inside the group creation transaction, or with the group row locked for backfill. */
export async function provisionDefaultChannels(tx: Prisma.TransactionClient, groupId: string, createdByUserId: string) {
  for (const purpose of DEFAULT_CHANNELS) {
    const existing = await tx.groupChannel.findUnique({ where: { groupId_defaultPurpose: { groupId, defaultPurpose: purpose } } });
    if (existing) continue;
    await tx.groupChannel.create({
      data: {
        group: { connect: { id: groupId } }, name: purpose, defaultPurpose: purpose,
        topic: purpose === 'announcements' ? 'Updates from group leaders.' : purpose === 'general' ? 'Conversation about this group.' : 'Off-topic conversation.',
        conversation: { create: { type: 'channel', createdByUserId } },
      },
    });
  }
}
