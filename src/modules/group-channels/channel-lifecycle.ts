import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { PresenceRealtimeService } from '../presence/presence-realtime.service';
import type { PrismaService } from '../prisma/prisma.service';

export async function lockChannelGroup(tx: Prisma.TransactionClient, groupId: string) {
  await tx.$queryRaw(Prisma.sql`SELECT id FROM "CommunityGroup" WHERE id = ${groupId} FOR UPDATE`);
}

/** Membership/role changes use the same lock as sends, invites and ownership transfer. */
export async function prepareChannelDeparture(tx: Prisma.TransactionClient, groupId: string, userId: string, options: { forced: boolean; demotion?: boolean }) {
  await lockChannelGroup(tx, groupId);
  const privateChannels = await tx.groupChannel.findMany({ where: { groupId, privacy: 'private', archivedAt: null, access: { some: { userId } } }, select: { id: true } });
  for (const channel of privateChannels) {
    const remainingLeaders = await tx.communityGroupMember.count({ where: {
      groupId, status: 'active', role: { in: ['owner', 'moderator'] }, userId: { not: userId },
      user: { bannedAt: null, isBot: false, verifiedStatus: { not: 'none' }, channelAccess: { some: { channelId: channel.id } } },
    } });
    if (remainingLeaders) continue;
    if (!options.forced) throw new BadRequestException('Add another group leader to your private channels before leaving or changing roles.');
    await tx.groupChannel.update({ where: { id: channel.id }, data: { archivedAt: new Date(), revision: { increment: 1 } } });
  }
  if (options.demotion) return;
  await tx.groupChannelAccess.deleteMany({ where: { userId, channel: { groupId } } });
  await tx.groupChannelViewerState.deleteMany({ where: { userId, channel: { groupId } } });
  await tx.groupChannelAttention.deleteMany({ where: { userId, channel: { groupId } } });
  await tx.groupChannelThreadState.deleteMany({ where: { userId, root: { conversation: { groupChannel: { groupId } } } } });
}

/** Ban and account deletion cannot be prevented by private-channel leadership. */
export async function revokeAccountChannels(tx: Prisma.TransactionClient, userId: string) {
  const memberships = await tx.communityGroupMember.findMany({ where: { userId }, select: { groupId: true }, orderBy: { groupId: 'asc' } });
  for (const { groupId } of memberships) await prepareChannelDeparture(tx, groupId, userId, { forced: true });
  return memberships.map(m => m.groupId);
}

export async function emitChannelAccessChange(prisma: PrismaService, realtime: PresenceRealtimeService, groupId: string, affectedUserId: string) {
  const members = await prisma.communityGroupMember.findMany({ where: { groupId, status: 'active' }, select: { userId: true } });
  for (const userId of new Set([affectedUserId, ...members.map(m => m.userId)])) {
    // Group-only invalidation does not disclose which private channel changed.
    realtime.emitGroupChannelChanged(userId, { groupId, reason: 'access' });
  }
}
