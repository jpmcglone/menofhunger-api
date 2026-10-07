import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { USER_LIST_SELECT } from '../../common/prisma-selects/user.select';

@Injectable()
export class RecentSearchesService {
  constructor(private readonly prisma: PrismaService) {}

  /** Up to 10 recent searches, newest first, deduped by target user, target group, or normalized text. */
  async listRecent(userId: string) {
    // Fetch more than we need so deduplication leaves us with 10 after filtering.
    const rows = await this.prisma.userSearch.findMany({
      where: { userId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 30,
      select: {
        id: true,
        query: true,
        createdAt: true,
        targetUserId: true,
        targetGroupId: true,
        targetUser: { select: USER_LIST_SELECT },
        targetGroup: {
          select: { id: true, slug: true, name: true, avatarImageUrl: true, memberCount: true },
        },
      },
    });

    const seen = new Set<string>();
    return rows.filter((r) => {
      const key = r.targetUserId
        ? `uid:${r.targetUserId}`
        : r.targetGroupId
          ? `gid:${r.targetGroupId}`
          : `q:${r.query.toLowerCase().replace(/\s+/g, ' ').trim()}`;
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, 10);
  }

  /** Display text for a recent search: the given query, else `@username`, else the group name. */
  async resolveDisplayQuery(params: {
    query: string;
    targetUserId: string | null;
    targetGroupId: string | null;
  }): Promise<string> {
    let resolvedQuery = params.query;
    if (params.targetUserId && !resolvedQuery) {
      const target = await this.prisma.user.findUnique({
        where: { id: params.targetUserId },
        select: { username: true },
      });
      resolvedQuery = target?.username ? `@${target.username}` : '';
    }
    if (params.targetGroupId && !resolvedQuery) {
      const target = await this.prisma.communityGroup.findUnique({
        where: { id: params.targetGroupId },
        select: { name: true },
      });
      resolvedQuery = target?.name ?? '';
    }
    return resolvedQuery;
  }

  async deleteRecent(userId: string, id: string): Promise<void> {
    await this.prisma.userSearch.deleteMany({ where: { id, userId } });
  }

  async clearRecent(userId: string): Promise<void> {
    await this.prisma.userSearch.deleteMany({ where: { userId } });
  }
}
