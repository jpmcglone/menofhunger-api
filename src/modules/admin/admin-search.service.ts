import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { createdAtIdCursorWhere } from '../../common/pagination/created-at-id-cursor';

@Injectable()
export class AdminSearchService {
  constructor(private readonly prisma: PrismaService) {}

  async list(parsed: { q?: string; limit?: number; cursor?: string }) {
    const limit = parsed.limit ?? 50;
    const cursor = parsed.cursor ?? null;
    const q = (parsed.q ?? '').trim();

    const cursorWhere = await createdAtIdCursorWhere({
      cursor,
      lookup: async (id) =>
        this.prisma.userSearch.findUnique({
          where: { id },
          select: { id: true, createdAt: true },
        }),
    });

    // Exclude profile/group taps — audit log is for typed queries only.
    const baseWhere = { targetUserId: null, targetGroupId: null };
    const where = cursorWhere
      ? q
        ? { AND: [baseWhere, cursorWhere, { query: { contains: q, mode: 'insensitive' as const } }] }
        : { AND: [baseWhere, cursorWhere] }
      : q
        ? { AND: [baseWhere, { query: { contains: q, mode: 'insensitive' as const } }] }
        : baseWhere;

    const rows = await this.prisma.userSearch.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      select: {
        id: true,
        query: true,
        createdAt: true,
        user: {
          select: { id: true, username: true, name: true },
        },
      },
    });

    const slice = rows.slice(0, limit);
    const nextCursor = rows.length > limit ? slice[slice.length - 1]?.id ?? null : null;

    const data = slice.map((r) => ({
      id: r.id,
      query: r.query,
      createdAt: r.createdAt.toISOString(),
      user: {
        id: r.user.id,
        username: r.user.username,
        name: r.user.name,
      },
    }));

    return {
      data,
      pagination: { nextCursor },
    };
  }
}
