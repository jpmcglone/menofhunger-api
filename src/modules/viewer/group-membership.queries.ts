import { ForbiddenException } from '@nestjs/common';
import { NOT_DELETED } from '../../common/prisma/where';
import { NOT_BANNED_USER_WHERE } from '../../common/prisma-selects/user.where';
import type { CommunityGroupMemberRole, CommunityGroupMemberStatus, GroupNotificationPreference, Prisma, PrismaClient } from '@prisma/client';

type Db = PrismaClient | Prisma.TransactionClient;

export type GroupMemberRow = { role: CommunityGroupMemberRole; status: CommunityGroupMemberStatus };

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
export function findGroupMemberStatus(db: Db, groupId: string, userId: string): Promise<{ status: CommunityGroupMemberStatus } | null> {
  return db.communityGroupMember.findUnique({ where: { groupId_userId: { groupId, userId } }, select: { status: true } });
}

/** Per-member notification preference or null when not a member. */
export function findGroupNotificationPreference(
  db: Db,
  groupId: string,
  userId: string,
): Promise<{ notificationPreference: GroupNotificationPreference } | null> {
  return db.communityGroupMember.findUnique({
    where: { groupId_userId: { groupId, userId } },
    select: { notificationPreference: true },
  });
}

/** Ids of groups where `userId` has an active membership. */
export async function listActiveGroupIdsForUser(db: Db, userId: string): Promise<string[]> {
  const rows = await db.communityGroupMember.findMany({ where: { userId, status: 'active' }, select: { groupId: true } });
  return rows.map((r) => r.groupId);
}

/** Subset of `groupIds` where `userId` has an active membership. */
export async function listActiveGroupIdsAmong(db: Db, userId: string, groupIds: string[]): Promise<Set<string>> {
  if (groupIds.length === 0) return new Set();
  const rows = await db.communityGroupMember.findMany({
    where: { userId, groupId: { in: groupIds }, status: 'active' },
    select: { groupId: true },
  });
  return new Set(rows.map((r) => r.groupId));
}

/** Ids of groups where `userId` is active or pending (i.e. already involved). */
export async function listActiveOrPendingGroupIdsForUser(db: Db, userId: string): Promise<string[]> {
  const rows = await db.communityGroupMember.findMany({
    where: { userId, status: { in: ['active', 'pending'] } },
    select: { groupId: true },
  });
  return rows.map((r) => r.groupId);
}

/** Viewer membership (any status) for each of `groupIds`. */
export function listGroupMembershipsForUser(
  db: Db,
  userId: string,
  groupIds: string[],
): Promise<Array<{ groupId: string; status: CommunityGroupMemberStatus; role: CommunityGroupMemberRole }>> {
  return db.communityGroupMember.findMany({
    where: { userId, groupId: { in: groupIds } },
    select: { groupId: true, status: true, role: true },
  });
}

/** Active members whose tier satisfies a `premiumOnly` / `verifiedOnly` post audience. */
export async function listTierEligibleGroupMemberIds(
  db: Db,
  groupId: string,
  visibility: 'premiumOnly' | 'verifiedOnly',
): Promise<string[]> {
  const members = await db.communityGroupMember.findMany({
    where: { groupId, status: 'active' },
    select: { userId: true, user: { select: { premium: true, premiumPlus: true, verifiedStatus: true } } },
  });
  return members
    .filter((m) => {
      if (visibility === 'premiumOnly') return m.user.premium || m.user.premiumPlus;
      return (m.user.verifiedStatus && m.user.verifiedStatus !== 'none') || m.user.premium || m.user.premiumPlus;
    })
    .map((m) => m.userId);
}

/** Active members among `userIds` with their notification preference. */
export function listActiveGroupMemberPreferences(db: Db, groupId: string, userIds: string[]) {
  return db.communityGroupMember.findMany({
    where: { groupId, userId: { in: userIds }, status: 'active' },
    select: { userId: true, notificationPreference: true },
  });
}

/** Active member user ids of a group, optionally excluding one user. */
export async function listActiveGroupMemberIds(db: Db, groupId: string, opts: { excludeUserId?: string } = {}): Promise<string[]> {
  const rows = await db.communityGroupMember.findMany({
    where: { groupId, status: 'active', ...(opts.excludeUserId ? { userId: { not: opts.excludeUserId } } : {}) },
    select: { userId: true },
  });
  return rows.map((r) => r.userId);
}

/** True when `userId` is an active member of a group that has not been deleted. */
export async function isActiveGroupMember(db: Db, groupId: string, userId: string): Promise<boolean> {
  const row = await db.communityGroupMember.findFirst({
    where: { groupId, userId, status: 'active', group: NOT_DELETED },
    select: { userId: true },
  });
  return row != null;
}

/**
 * Who should own `groupId` after `departingUserId` leaves: the most senior active, unbanned human member,
 * preferring a verified one (who keeps channel access) over any active member. Null leaves the group orphaned.
 */
export async function findGroupOwnershipSuccessor(db: Db, groupId: string, departingUserId: string): Promise<string | null> {
  const candidate = (verified: boolean) =>
    db.communityGroupMember.findFirst({
      where: {
        groupId,
        userId: { not: departingUserId },
        status: 'active',
        user: { ...NOT_BANNED_USER_WHERE, isBot: false, ...(verified ? { verifiedStatus: { not: 'none' as const } } : {}) },
      },
      orderBy: [{ role: 'asc' }, { createdAt: 'asc' }],
      select: { userId: true },
    });
  const row = (await candidate(true)) ?? (await candidate(false));
  return row?.userId ?? null;
}

/** Make an existing member the group's owner. */
export function promoteGroupOwner(db: Db, groupId: string, userId: string) {
  return db.communityGroupMember.update({ where: { groupId_userId: { groupId, userId } }, data: { role: 'owner' } });
}

/** Current approval identity for a queued email; a removed membership cannot send. */
export function findActiveGroupMembershipUpdatedAt(db: Db, groupId: string, userId: string): Promise<{ updatedAt: Date } | null> {
  return db.communityGroupMember.findFirst({
    where: { groupId, userId, status: 'active', group: NOT_DELETED },
    select: { updatedAt: true },
  });
}
