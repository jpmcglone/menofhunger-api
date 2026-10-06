import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../modules/prisma/prisma.service';
import { bellExcludedKindsForAccount } from '../../modules/notifications/notification-kinds';

export type IdentityBadgeSummary = { unreadBadgeCount: number; hasUnreadNotifications: boolean };

/** Shared by account switching, notification summaries and APNs; depends only on storage. */
@Injectable()
export class BadgeSummaryService {
  constructor(private readonly prisma: PrismaService) {}

  async notificationWhere(userId: string): Promise<Prisma.NotificationWhereInput> {
    const [user, blocks, mutes] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: userId }, select: { accountKind: true } }),
      this.prisma.userBlock.findMany({ where: { OR: [{ blockerId: userId }, { blockedId: userId }] }, select: { blockerId: true, blockedId: true } }),
      this.prisma.userMute.findMany({ where: { muterId: userId }, select: { mutedId: true } }),
    ]);
    const hidden = [...blocks.map(b => b.blockerId === userId ? b.blockedId : b.blockerId), ...mutes.map(m => m.mutedId)];
    return {
      recipientUserId: userId,
      kind: { notIn: bellExcludedKindsForAccount(user?.accountKind) },
      ...(hidden.length ? { NOT: { AND: [{ actorUserId: { not: null } }, { actorUserId: { in: hidden } }] } } : {}),
    };
  }

  async forIdentity(userId: string): Promise<IdentityBadgeSummary> {
    const where = await this.notificationWhere(userId);
    const [bell, unread, groups, invites, messages] = await Promise.all([
      this.prisma.notification.count({ where: { ...where, deliveredAt: null } }),
      this.prisma.notification.findFirst({ where: { ...where, readAt: null }, select: { id: true } }),
      this.prisma.user.findUnique({ where: { id: userId }, select: { undeliveredGroupPostCount: true } }),
      this.prisma.communityGroupInvite.count({ where: { inviteeUserId: userId, status: 'pending', expiresAt: { gt: new Date() }, group: { deletedAt: null } } }),
      this.prisma.$queryRaw<Array<{ count: number | bigint }>>(Prisma.sql`
        SELECT COUNT(m.id)::int AS count FROM "MessageParticipant" mp
        JOIN "Message" m ON m."conversationId" = mp."conversationId"
        WHERE mp."userId" = ${userId} AND m."senderId" <> ${userId}
          AND (mp."lastReadAt" IS NULL OR m."createdAt" > mp."lastReadAt")
          AND NOT EXISTS (
            SELECT 1 FROM "MessageParticipant" peer JOIN "UserBlock" b
              ON (b."blockerId" = ${userId} AND b."blockedId" = peer."userId")
              OR (b."blockedId" = ${userId} AND b."blockerId" = peer."userId")
            WHERE peer."conversationId" = mp."conversationId"
          )
      `),
    ]);
    return { unreadBadgeCount: bell + Math.max(0, groups?.undeliveredGroupPostCount ?? 0) + invites + Number(messages[0]?.count ?? 0), hasUnreadNotifications: unread != null };
  }

  async forIdentities(ids: string[]): Promise<Map<string, IdentityBadgeSummary>> {
    return new Map(await Promise.all([...new Set(ids)].map(async id => [id, await this.forIdentity(id)] as const)));
  }

  async appIconCount(ownerId: string): Promise<number> {
    const owner = await this.prisma.user.findUnique({ where: { id: ownerId }, select: { accountKind: true, bannedAt: true } });
    if (!owner || owner.bannedAt) return 0;
    const pages = owner.accountKind === 'page' ? [] : await this.prisma.userPageOperator.findMany({
      where: { operatorUserId: ownerId, page: { bannedAt: null } }, select: { pageUserId: true },
    });
    const summaries = await this.forIdentities([ownerId, ...pages.map(p => p.pageUserId)]);
    return [...summaries.values()].reduce((sum, s) => sum + s.unreadBadgeCount, 0);
  }
}
