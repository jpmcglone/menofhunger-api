import type { PrismaService } from '../prisma/prisma.service';
import { NOT_DELETED } from '../../common/prisma/where';

/** Every verified person belongs to this group. Keep in sync with the membership backfill migration. */
export const OFFICIAL_GROUP_SLUG = 'men-of-hunger';

/** Idempotent. Missing group, banned, bot, or organization accounts are skipped. */
export async function joinOfficialGroup(prisma: Pick<PrismaService, '$transaction'>, userId: string): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const group = await tx.communityGroup.findFirst({ where: { slug: OFFICIAL_GROUP_SLUG, ...NOT_DELETED }, select: { id: true } });
    const user = await tx.user.findUnique({ where: { id: userId }, select: { bannedAt: true, isBot: true, isOrganization: true, verifiedStatus: true } });
    if (!group || !user || user.bannedAt || user.isBot || user.isOrganization || user.verifiedStatus === 'none') return false;
    const key = { groupId_userId: { groupId: group.id, userId } };
    const existing = await tx.communityGroupMember.findUnique({ where: key, select: { status: true } });
    if (existing?.status === 'active') return false;
    if (existing) await tx.communityGroupMember.update({ where: key, data: { status: 'active' } });
    else await tx.communityGroupMember.create({ data: { groupId: group.id, userId, role: 'member', status: 'active', notificationPreference: 'repliesAndMentions' } });
    await tx.communityGroup.update({ where: { id: group.id }, data: { memberCount: { increment: 1 } } });
    return true;
  });
}
