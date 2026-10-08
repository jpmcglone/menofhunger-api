import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export type PublicRecordPostRow = { author: string | null; createdAt: Date; body: string };
export type PublicRecordBoardRow = { author: string | null; createdAt: Date; title: string | null; body: string };

function publicRootWhere(): Prisma.PostWhereInput {
  return {
    deletedAt: null,
    isDraft: false,
    visibility: 'public',
    parentId: null,
    communityGroupId: null,
    user: { bannedAt: null },
  };
}

/** Reads of the public post record for other modules (for example Marv's briefing). */
@Injectable()
export class PostsPublicRecordService {
  constructor(private readonly prisma: PrismaService) {}

  async recentPublicPosts(take: number): Promise<PublicRecordPostRow[]> {
    const rows = await this.prisma.post.findMany({
      where: { ...publicRootWhere(), kind: { not: 'board' } },
      orderBy: { createdAt: 'desc' },
      take,
      select: { body: true, createdAt: true, user: { select: { username: true } } },
    });
    return rows.map((row) => ({ author: row.user.username, createdAt: row.createdAt, body: row.body }));
  }

  async recentBoardThreads(take: number): Promise<PublicRecordBoardRow[]> {
    const rows = await this.prisma.post.findMany({
      where: { ...publicRootWhere(), kind: 'board' },
      orderBy: { createdAt: 'desc' },
      take,
      select: {
        body: true,
        createdAt: true,
        user: { select: { username: true } },
        boardThread: { select: { title: true } },
      },
    });
    return rows.map((row) => ({
      author: row.user.username,
      createdAt: row.createdAt,
      title: row.boardThread?.title ?? null,
      body: row.body,
    }));
  }

  async recentGroupPosts(groupId: string, take: number): Promise<PublicRecordPostRow[]> {
    const rows = await this.prisma.post.findMany({
      where: {
        deletedAt: null,
        isDraft: false,
        communityGroupId: groupId,
        parentId: null,
        visibility: { not: 'onlyMe' },
        user: { bannedAt: null },
      },
      orderBy: { createdAt: 'desc' },
      take,
      select: { body: true, createdAt: true, user: { select: { username: true } } },
    });
    return rows.map((row) => ({ author: row.user.username, createdAt: row.createdAt, body: row.body }));
  }
}
