import type { Prisma, PrismaClient } from '@prisma/client';
import { NOT_DELETED } from '../../common/prisma/where';
import { NOT_BANNED_USER_WHERE } from '../../common/prisma-selects/user.where';

/** Prisma client or interactive-transaction client. */
type Db = PrismaClient | Prisma.TransactionClient;

/**
 * Crew membership lookups. The one place outside `modules/crew` allowed to touch `crewMember`;
 * plain functions (not DI) so services constructed positionally in tests need no new deps.
 */

/** Crew id the user belongs to (including a soft-deleted crew), or null. */
export async function findCrewIdForUser(db: Db, userId: string): Promise<string | null> {
  const m = await db.crewMember.findUnique({ where: { userId }, select: { crewId: true } });
  return m?.crewId ?? null;
}

/** Crew id of the user's non-deleted crew, or null. */
export async function findActiveCrewIdForUser(db: Db, userId: string): Promise<string | null> {
  const m = await db.crewMember.findFirst({ where: { userId, crew: NOT_DELETED }, select: { crewId: true } });
  return m?.crewId ?? null;
}

/** Other members of the user's crew (excludes the user). */
export async function listCrewmateUserIds(db: Db, userId: string): Promise<string[]> {
  const rows = await db.crewMember.findMany({
    where: { crew: { members: { some: { userId } } }, userId: { not: userId } },
    select: { userId: true },
  });
  return rows.map((r) => r.userId);
}

/**
 * Users in a non-deleted crew with more than one member. A solo crew member stays inviteable
 * because accepting another crew's invite auto-disbands their old crew.
 */
export async function findInviteBlockingCrewMemberIds(db: Db, userIds: string[]): Promise<Set<string>> {
  if (!userIds.length) return new Set();
  const rows = await db.crewMember.findMany({
    where: { userId: { in: userIds }, crew: NOT_DELETED },
    select: { userId: true, crew: { select: { memberCount: true } } },
  });
  return new Set(rows.filter((m) => m.crew.memberCount > 1).map((m) => m.userId));
}

/** Unbanned members of `crewId` other than `departingUserId`, oldest membership first. */
export async function listCrewSuccessorCandidateIds(db: Db, crewId: string, departingUserId: string): Promise<string[]> {
  const rows = await db.crewMember.findMany({
    where: { crewId, userId: { not: departingUserId }, user: NOT_BANNED_USER_WHERE },
    orderBy: { createdAt: 'asc' },
    select: { userId: true },
  });
  return rows.map((r) => r.userId);
}

/** Ids of every crew `userId` belongs to (including soft-deleted crews). */
export async function listCrewIdsForUser(db: Db, userId: string): Promise<string[]> {
  const rows = await db.crewMember.findMany({ where: { userId }, select: { crewId: true } });
  return rows.map((r) => r.crewId);
}
