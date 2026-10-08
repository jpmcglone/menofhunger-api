import { ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/** Single home for crew membership lookups used outside the crew module. */
@Injectable()
export class CrewAccessService {
  constructor(private readonly prisma: PrismaService) {}

  /** Crew id the user belongs to (any crew, including soft-deleted), or null. */
  async getCrewIdForUser(userId: string): Promise<string | null> {
    const m = await this.prisma.crewMember.findUnique({ where: { userId }, select: { crewId: true } });
    return m?.crewId ?? null;
  }

  /** Crew id of the user's non-deleted crew, or null. */
  async getActiveCrewIdForUser(userId: string): Promise<string | null> {
    const m = await this.prisma.crewMember.findFirst({
      where: { userId, crew: { deletedAt: null } },
      select: { crewId: true },
    });
    return m?.crewId ?? null;
  }

  async getMemberOrThrow(crewId: string, userId: string, message = 'You are not a member of this crew.'): Promise<{ role: string }> {
    const m = await this.prisma.crewMember.findUnique({ where: { crewId_userId: { crewId, userId } }, select: { role: true } });
    if (!m) throw new ForbiddenException(message);
    return m;
  }

  async assertOwner(crewId: string, userId: string): Promise<void> {
    const m = await this.getMemberOrThrow(crewId, userId);
    if (m.role !== 'owner') throw new ForbiddenException('Only the crew owner can do that.');
  }

  /** Active crew members' user ids for the given crew ids, grouped by crew. */
  async listMemberUserIds(crewIds: string[]): Promise<Array<{ crewId: string; userId: string }>> {
    if (crewIds.length === 0) return [];
    return this.prisma.crewMember.findMany({ where: { crewId: { in: crewIds } }, select: { crewId: true, userId: true } });
  }
}
