import type { PrismaClient } from '@prisma/client';
import type { AdminNewMemberPostsDto } from '../../common/dto';

const SNIPPET_MAX = 160;

/**
 * Top-level posts by members who joined recently that nobody has answered yet.
 * `minAgeMinutes` leaves a grace period before a post counts as waiting.
 */
export async function readUnansweredNewMemberPosts(
  prisma: Pick<PrismaClient, 'post'>,
  opts: { newMemberDays: number; minAgeMinutes: number; limit: number },
  now: Date = new Date(),
): Promise<AdminNewMemberPostsDto> {
  const joinedAfter = new Date(now.getTime() - opts.newMemberDays * 24 * 60 * 60 * 1000);
  const postedBefore = new Date(now.getTime() - opts.minAgeMinutes * 60_000);
  const postedAfter = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
  const rows = await prisma.post.findMany({
    where: {
      parentId: null,
      deletedAt: null,
      isDraft: false,
      kind: 'regular',
      visibility: { not: 'onlyMe' },
      commentCount: 0,
      createdAt: { lt: postedBefore, gte: postedAfter },
      user: {
        createdAt: { gte: joinedAfter },
        bannedAt: null,
        isBot: false,
        isOrganization: false,
      },
    },
    orderBy: { createdAt: 'asc' },
    take: opts.limit,
    select: {
      id: true,
      createdAt: true,
      body: true,
      visibility: true,
      user: { select: { id: true, username: true, name: true, createdAt: true } },
    },
  });
  return {
    asOf: now.toISOString(),
    newMemberDays: opts.newMemberDays,
    minAgeMinutes: opts.minAgeMinutes,
    count: rows.length,
    posts: rows.map((r) => ({
      id: r.id,
      createdAt: r.createdAt.toISOString(),
      waitingMinutes: Math.floor((now.getTime() - r.createdAt.getTime()) / 60_000),
      visibility: r.visibility,
      snippet: r.body.replace(/\s+/g, ' ').trim().slice(0, SNIPPET_MAX),
      author: {
        id: r.user.id,
        username: r.user.username,
        name: r.user.name,
        joinedAt: r.user.createdAt.toISOString(),
      },
    })),
  };
}
