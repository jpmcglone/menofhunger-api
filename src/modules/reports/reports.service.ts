import type { Prisma, ReportReason, ReportStatus, ReportTargetType } from '@prisma/client';
import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { createdAtIdCursorWhere } from '../../common/pagination/created-at-id-cursor';

@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(input: {
    reporterUserId: string;
    targetType: ReportTargetType;
    subjectPostId?: string | null;
    subjectUserId?: string | null;
    reason: ReportReason;
    details: string | null;
  }) {
    if (input.targetType === 'post') {
      const postId = input.subjectPostId;
      if (!postId) throw new NotFoundException();

      const post = await this.prisma.post.findFirst({
        where: { id: postId, deletedAt: null },
        select: { id: true },
      });
      if (!post) throw new NotFoundException();

      return await this.prisma.report.create({
        data: {
          targetType: 'post',
          reason: input.reason,
          details: input.details,
          reporter: { connect: { id: input.reporterUserId } },
          subjectPost: { connect: { id: postId } },
        },
      });
    }

    const userId = input.subjectUserId;
    if (!userId) throw new NotFoundException();

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true },
    });
    if (!user) throw new NotFoundException();

    return await this.prisma.report.create({
      data: {
        targetType: 'user',
        reason: input.reason,
        details: input.details,
        reporter: { connect: { id: input.reporterUserId } },
        subjectUser: { connect: { id: userId } },
      },
    });
  }

  async listAdmin(params: {
    limit: number;
    cursor: string | null;
    status?: ReportStatus;
    targetType?: ReportTargetType;
    reason?: ReportReason;
    q?: string;
  }) {
    const cursorWhere = await createdAtIdCursorWhere({
      cursor: params.cursor,
      lookup: async (id) =>
        this.prisma.report.findUnique({
          where: { id },
          select: { id: true, createdAt: true },
        }),
    });

    const whereParts: Prisma.ReportWhereInput[] = [];
    if (cursorWhere) whereParts.push(cursorWhere);
    if (params.status) whereParts.push({ status: params.status });
    if (params.targetType) whereParts.push({ targetType: params.targetType });
    if (params.reason) whereParts.push({ reason: params.reason });

    const q = (params.q ?? '').trim();
    if (q) {
      whereParts.push({
        OR: [{ details: { contains: q, mode: 'insensitive' } }, { adminNote: { contains: q, mode: 'insensitive' } }],
      });
    }

    const where = whereParts.length ? { AND: whereParts } : undefined;

    const rows = await this.prisma.report.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: params.limit + 1,
      include: {
        reporter: { select: { id: true, username: true, name: true } },
        subjectUser: { select: { id: true, username: true, name: true } },
        subjectPost: {
          select: {
            id: true,
            createdAt: true,
            body: true,
            deletedAt: true,
            user: { select: { id: true, username: true, name: true } },
          },
        },
        resolvedByAdmin: { select: { id: true, username: true, name: true } },
      },
    });

    const slice = rows.slice(0, params.limit);
    const nextCursor = rows.length > params.limit ? slice[slice.length - 1]?.id ?? null : null;

    return { rows: slice, nextCursor };
  }

  async updateAdmin(id: string, input: { adminId: string; status?: ReportStatus; adminNote?: string | null }) {
    const setResolution =
      input.status === undefined
        ? {}
        : input.status === 'pending'
          ? { resolvedAt: null, resolvedByAdmin: { disconnect: true } }
          : { resolvedAt: new Date(), resolvedByAdmin: { connect: { id: input.adminId } } };

    return await this.prisma.report.update({
      where: { id },
      data: {
        ...(input.status ? { status: input.status } : {}),
        ...(input.adminNote !== undefined ? { adminNote: input.adminNote } : {}),
        ...setResolution,
      },
      include: {
        reporter: { select: { id: true, username: true, name: true } },
        subjectUser: { select: { id: true, username: true, name: true } },
        subjectPost: {
          select: {
            id: true,
            createdAt: true,
            body: true,
            deletedAt: true,
            user: { select: { id: true, username: true, name: true } },
          },
        },
        resolvedByAdmin: { select: { id: true, username: true, name: true } },
      },
    });
  }
}

