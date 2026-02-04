import type { FeedbackCategory, FeedbackStatus, Prisma } from '@prisma/client';
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { createdAtIdCursorWhere } from '../../common/pagination/created-at-id-cursor';

@Injectable()
export class FeedbackService {
  constructor(private readonly prisma: PrismaService) {}

  async create(input: {
    category: FeedbackCategory;
    email: string | null;
    subject: string;
    details: string;
    userId?: string | null;
  }) {
    return await this.prisma.feedback.create({
      data: {
        category: input.category,
        email: input.email,
        subject: input.subject,
        details: input.details,
        ...(input.userId ? { user: { connect: { id: input.userId } } } : {}),
      },
    });
  }

  async listAdmin(params: {
    limit: number;
    cursor: string | null;
    status?: FeedbackStatus;
    category?: FeedbackCategory;
    q?: string;
  }) {
    const cursorWhere = await createdAtIdCursorWhere({
      cursor: params.cursor,
      lookup: async (id) =>
        this.prisma.feedback.findUnique({
          where: { id },
          select: { id: true, createdAt: true },
        }),
    });

    const whereParts: Prisma.FeedbackWhereInput[] = [];
    if (cursorWhere) whereParts.push(cursorWhere);
    if (params.status) whereParts.push({ status: params.status });
    if (params.category) whereParts.push({ category: params.category });

    const q = (params.q ?? '').trim();
    if (q) {
      whereParts.push({
        OR: [
          { subject: { contains: q, mode: 'insensitive' } },
          { details: { contains: q, mode: 'insensitive' } },
          { email: { contains: q, mode: 'insensitive' } },
        ],
      });
    }

    const where = whereParts.length ? { AND: whereParts } : undefined;

    const rows = await this.prisma.feedback.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: params.limit + 1,
      include: {
        user: { select: { id: true, username: true, name: true } },
      },
    });

    const slice = rows.slice(0, params.limit);
    const nextCursor = rows.length > params.limit ? slice[slice.length - 1]?.id ?? null : null;

    return { rows: slice, nextCursor };
  }

  async updateAdmin(id: string, input: { status?: FeedbackStatus; adminNote?: string | null }) {
    return await this.prisma.feedback.update({
      where: { id },
      data: {
        ...(input.status ? { status: input.status } : {}),
        ...(input.adminNote !== undefined ? { adminNote: input.adminNote } : {}),
      },
      include: {
        user: { select: { id: true, username: true, name: true } },
      },
    });
  }
}
