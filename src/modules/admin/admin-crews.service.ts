import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfigService } from '../app/app-config.service';
import { USER_LIST_SELECT } from '../../common/prisma-selects/user.select';
import { toCrewPublicDto, type CrewPublicDto } from '../../common/dto/crew.dto';
import { CrewTransferService } from '../crew/crew-transfer.service';

type AdminCrewListItem = CrewPublicDto & {
  deletedAt: string | null;
  wallConversationId: string;
  pendingInviteCount: number;
};

@Injectable()
export class AdminCrewsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly appConfig: AppConfigService,
    private readonly transfer: CrewTransferService,
  ) {}

  async list(parsed: { q?: string; limit?: number; offset?: number; includeDisbanded?: boolean }) {
    const limit = parsed.limit ?? 50;
    const offset = parsed.offset ?? 0;
    const q = parsed.q?.trim() ?? '';
    const includeDisbanded = Boolean(parsed.includeDisbanded);

    const where: Prisma.CrewWhereInput = {
      ...(includeDisbanded ? {} : { deletedAt: null }),
      ...(q
        ? {
            OR: [
              { name: { contains: q, mode: 'insensitive' } },
              { slug: { contains: q, mode: 'insensitive' } },
              {
                owner: {
                  OR: [
                    { username: { contains: q, mode: 'insensitive' } },
                    { name: { contains: q, mode: 'insensitive' } },
                  ],
                },
              },
            ],
          }
        : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.crew.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }],
        skip: offset,
        take: limit,
        include: {
          owner: { select: USER_LIST_SELECT },
          members: { include: { user: { select: USER_LIST_SELECT } } },
        },
      }),
      this.prisma.crew.count({ where }),
    ]);

    const publicBaseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;
    const pendingCounts = await this.prisma.crewInvite.groupBy({
      by: ['crewId'],
      where: { status: 'pending', crewId: { in: rows.map((r) => r.id) } },
      _count: true,
    });
    const pendingByCrew = new Map<string, number>(
      pendingCounts.map((p) => [p.crewId ?? '', p._count]),
    );

    const data: AdminCrewListItem[] = rows.map((r) => ({
      ...toCrewPublicDto({
        crew: r,
        ownerRow: r.owner,
        memberRows: r.members,
        publicBaseUrl,
      }),
      deletedAt: r.deletedAt?.toISOString() ?? null,
      wallConversationId: r.wallConversationId,
      pendingInviteCount: pendingByCrew.get(r.id) ?? 0,
    }));

    return {
      data,
      pagination: { total, offset, limit, nextOffset: offset + rows.length < total ? offset + rows.length : null },
    };
  }

  async detail(id: string) {
    const crew = await this.prisma.crew.findUnique({
      where: { id },
      include: {
        owner: { select: USER_LIST_SELECT },
        members: { include: { user: { select: USER_LIST_SELECT } } },
        invites: {
          orderBy: [{ createdAt: 'desc' }],
          take: 50,
          include: {
            invitedBy: { select: USER_LIST_SELECT },
            invitee: { select: USER_LIST_SELECT },
          },
        },
        transferVotes: {
          orderBy: [{ createdAt: 'desc' }],
          take: 10,
          include: { ballots: true },
        },
      },
    });
    if (!crew) {
      return { data: null };
    }
    const publicBaseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;
    const base = toCrewPublicDto({
      crew,
      ownerRow: crew.owner,
      memberRows: crew.members,
      publicBaseUrl,
    });
    return {
      data: {
        ...base,
        deletedAt: crew.deletedAt?.toISOString() ?? null,
        designatedSuccessorUserId: crew.designatedSuccessorUserId,
        wallConversationId: crew.wallConversationId,
        invites: crew.invites.map((i) => ({
          id: i.id,
          status: i.status,
          createdAt: i.createdAt.toISOString(),
          expiresAt: i.expiresAt.toISOString(),
          respondedAt: i.respondedAt?.toISOString() ?? null,
          invitedByUserId: i.invitedByUserId,
          inviteeUserId: i.inviteeUserId,
          message: i.message,
        })),
        transferVotes: crew.transferVotes.map((v) => ({
          id: v.id,
          status: v.status,
          proposerUserId: v.proposerUserId,
          targetUserId: v.targetUserId,
          expiresAt: v.expiresAt.toISOString(),
          resolvedAt: v.resolvedAt?.toISOString() ?? null,
          ballots: v.ballots.map((b) => ({ userId: b.userId, inFavor: b.inFavor })),
        })),
      },
    };
  }

  async transferOwnership(id: string, parsed: { newOwnerUserId: string }) {
    const crew = await this.prisma.crew.findUnique({
      where: { id },
      select: { id: true, deletedAt: true, ownerUserId: true },
    });
    if (!crew || crew.deletedAt) return { data: {} };
    await this.transfer.adminForceTransfer({
      crewId: crew.id,
      newOwnerUserId: parsed.newOwnerUserId,
    });
    return { data: {} };
  }
}
