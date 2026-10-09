import { NOT_BANNED_USER_WHERE } from '../../../common/prisma-selects/user.where';
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import type { MarvinParticipationDto } from '../../../common/dto/marvin/marvin-personal.dto';

import { PostsReadService } from '../../posts-read/posts-read.service';
import { NOT_DELETED } from '../../../common/prisma/where';
@Injectable()
export class MarvinParticipationService {
  constructor(private readonly prisma: PrismaService, private readonly postsRead: PostsReadService) {}

  async suggestions(userId: string, excludePostId?: string): Promise<MarvinParticipationDto> {
    const now = new Date();
    const [viewer, follows, posts] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: userId }, select: { interests: true } }),
      this.prisma.follow.findMany({ where: { followerId: userId }, select: { followingId: true }, take: 1000 }),
      this.postsRead.findMany({ where: {
        id: excludePostId ? { not: excludePostId } : undefined,
        userId: { not: userId }, visibility: 'public', communityGroupId: null, parentId: null,
        kind: 'regular', isDraft: false, ...NOT_DELETED, createdAt: { gte: new Date(now.getTime() - 14 * 86400000) },
        user: { ...NOT_BANNED_USER_WHERE, isBot: false,
          blocksInitiated: { none: { blockedId: userId } }, blocksReceived: { none: { blockerId: userId } } },
        replies: { none: { userId, ...NOT_DELETED, isDraft: false } },
      }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 60,
      select: { id: true, body: true, userId: true, user: { select: { username: true, name: true, interests: true } },
        _count: { select: { replies: { where: { ...NOT_DELETED, isDraft: false, user: { isBot: false, ...NOT_BANNED_USER_WHERE } } } } } },
      }),
    ]);
    const following = new Set(follows.map(f => f.followingId));
    const interests = new Set((viewer?.interests ?? []).map(i => i.toLowerCase()));
    const ranked = posts.map(p => {
      const shared = p.user.interests.filter(i => interests.has(i.toLowerCase()));
      const followed = following.has(p.userId);
      const unanswered = p._count.replies === 0;
      return { p, score: (followed ? 4 : 0) + (shared.length ? 3 : 0) + (unanswered ? 2 : 0),
        reason: followed ? 'From someone you follow' : shared.length ? `Shared interest: ${shared.slice(0, 2).join(', ')}` : unanswered ? 'Be the first member to reply' : 'A recent conversation on Men of Hunger' };
    }).sort((a, b) => b.score - a.score);
    // Diverse authors keep one prolific poster from filling every suggestion.
    const authors = new Set<string>();
    const selected = ranked.filter(({ p }) => { if (authors.has(p.userId)) return false; authors.add(p.userId); return true; }).slice(0, 3);
    return { asOf: now.toISOString(), suggestions: selected.map(({ p, reason }) => ({ postId: p.id, username: p.user.username, name: p.user.name, body: p.body.slice(0, 220), reason })) };
  }
}
