import { ForbiddenException } from '@nestjs/common';
import type { CommunityGroupMemberRole, CommunityGroupNotificationPreference, Prisma, PrismaClient } from '@prisma/client';

type Db = PrismaClient | Prisma.TransactionClient;

export type GroupMemberRow = { role: CommunityGroupMemberRole; status: string };

/**
 * Community-group membership + role checks. Plain functions so positional-constructed services
 * (and tests) need no extra dependencies; `GroupAccessService` is the DI facade.
 * Role matrix: owner > moderator > member. A pending/removed row never grants access.
 */
export function findGroupMember(db: Db, groupId: string, userId: string): Promise<GroupMemberRow | null> {
  return db.communityGroupMember.findUnique({
    where: { groupId_userId: { groupId, userId } },
    select: { role: true, status: true },
  });
}

/** Active membership or `ForbiddenException(message)`. */
export async function getGroupMemberOrThrow(
  db: Db,
  groupId: string,
  userId: string,
  message = 'You must be a member of this group.',
): Promise<GroupMemberRow> {
  const m = await findGroupMember(db, groupId, userId);
  if (!m || m.status !== 'active') throw new ForbiddenException(message);
  return m;
}

/** Active member with one of `roles`, else `ForbiddenException(message)`. Returns the role. */
export async function assertGroupRole(
  db: Db,
  groupId: string,
  userId: string,
  roles: readonly CommunityGroupMemberRole[],
  message = 'Not allowed.',
): Promise<CommunityGroupMemberRole> {
  const m = await findGroupMember(db, groupId, userId);
  if (!m || m.status !== 'active' || !roles.includes(m.role)) throw new ForbiddenException(message);
  return m.role;
}

export const GROUP_MANAGER_ROLES: readonly CommunityGroupMemberRole[] = ['owner', 'moderator'];

/** Membership status only (any status) or null. Drop-in for `findUnique({ select: { status: true } })`. */
export function findGroupMemberStatus(db: Db, groupId: string, userId: string): Promise<{ status: string } | null> {
  return db.communityGroupMember.findUnique({ where: { groupId_userId: { groupId, userId } }, select: { status: true } });
}

/** Per-member notification preference or null when not a member. */
export function findGroupNotificationPreference(
  db: Db,
  groupId: string,
  userId: string,
): Promise<{ notificationPreference: CommunityGroupNotificationPreference } | null> {
  return db.communityGroupMember.findUnique({
    where: { groupId_userId: { groupId, userId } },
    select: { notificationPreference: true },
  });
}
