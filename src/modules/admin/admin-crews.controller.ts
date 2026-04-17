import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { AdminGuard } from './admin.guard';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfigService } from '../app/app-config.service';
import { USER_LIST_SELECT } from '../../common/prisma-selects/user.select';
import {
  toCrewPublicDto,
  type CrewPublicDto,
} from '../../common/dto/crew.dto';
import { CrewService } from '../crew/crew.service';
import { CrewTransferService } from '../crew/crew-transfer.service';

const listSchema = z.object({
  q: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).max(10_000).optional(),
  includeDisbanded: z.coerce.boolean().optional(),
});

const transferSchema = z.object({
  newOwnerUserId: z.string().trim().min(1),
});

type AdminCrewListItem = CrewPublicDto & {
  deletedAt: string | null;
  wallConversationId: string;
  pendingInviteCount: number;
};

@UseGuards(AdminGuard)
@Controller('admin/crews')
export class AdminCrewsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly appConfig: AppConfigService,
    private readonly crew: CrewService,
    private readonly transfer: CrewTransferService,
  ) {}

  @Get()
  async list(@Query() query: unknown) {
    const parsed = listSchema.parse(query);
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

  @Get(':id')
  async detail(@Param('id') id: string) {
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

  /** Disband any crew (admin override). */
  @Delete(':id')
  async disband(@Param('id') id: string) {
    await this.crew.adminForceDisband(id);
    return { data: {} };
  }

  /** Force ownership transfer regardless of current owner consent. */
  @Post(':id/transfer')
  async transferOwnership(@Param('id') id: string, @Body() body: unknown) {
    const parsed = transferSchema.parse(body);
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
