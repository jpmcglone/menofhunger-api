import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import type { PrismaService } from '../prisma/prisma.service';
import { lockChannelGroup } from '../group-channels/channel-lifecycle';

/** The previous owner stays a moderator; private-channel grants never move with ownership. */
export async function transferGroupOwnership(prisma: PrismaService, groupId: string, actorUserId: string, targetUserId: string) {
  if (targetUserId === actorUserId) throw new BadRequestException('Choose another member.');
  await prisma.$transaction(async tx => {
    await lockChannelGroup(tx, groupId);
    const group = await tx.communityGroup.findFirst({ where: { id: groupId, deletedAt: null }, select: { id: true } });
    if (!group) throw new NotFoundException('Group not found.');
    const actor = await tx.communityGroupMember.findUnique({ where: { groupId_userId: { groupId, userId: actorUserId } }, select: { role: true, status: true } });
    if (actor?.status !== 'active' || actor.role !== 'owner') throw new ForbiddenException('Only the owner can transfer ownership.');
    const target = await tx.communityGroupMember.findFirst({
      where: { groupId, userId: targetUserId, status: 'active', user: { bannedAt: null, isBot: false, verifiedStatus: { not: 'none' } } },
      select: { userId: true },
    });
    if (!target) throw new NotFoundException('Member not found.');
    await tx.communityGroupMember.update({ where: { groupId_userId: { groupId, userId: actorUserId } }, data: { role: 'moderator' } });
    await tx.communityGroupMember.update({ where: { groupId_userId: { groupId, userId: targetUserId } }, data: { role: 'owner' } });
  });
}
