import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service';
import { AdminGuard } from './admin.guard';
import { createdAtIdCursorWhere } from '../../common/pagination/created-at-id-cursor';

const listSchema = z.object({
  q: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().optional(),
});

@UseGuards(AdminGuard)
@Controller('admin/searches')
export class AdminSearchController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async list(@Query() query: unknown) {
    const parsed = listSchema.parse(query);
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

    const where = cursorWhere
      ? q
        ? { AND: [cursorWhere, { query: { contains: q, mode: 'insensitive' as const } }] }
        : cursorWhere
      : q
        ? { query: { contains: q, mode: 'insensitive' as const } }
        : undefined;

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
