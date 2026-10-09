import { incrementPostViewCounts } from './post-transaction.commands';
import { ForbiddenException, Injectable } from '@nestjs/common';
import type { Prisma, PostVisibility } from '@prisma/client';
import { NOT_DELETED } from '../../common/prisma/where';
import { PrismaService } from '../prisma/prisma.service';

type CrosspostResult = { url?: string | null; error?: string | null };
type GroupPinTransaction = Pick<Prisma.TransactionClient, 'post'>;

/**
 * Fixed field commands for collaborating domains. Published content creation/edits/deletion
 * belong to posts mutation services; these metadata/mirror commands cannot accept arbitrary data.
 * Each owning surface retains its permission checks and realtime delivery after the commit.
 */
@Injectable()
export class PostsWriteService {
  constructor(private readonly prisma: PrismaService) {}

  recordCrosspostResult(id: string, platform: 'x' | 'pickax', result: CrosspostResult) {
    const data = platform === 'x'
      ? { ...(result.url !== undefined ? { xUrl: result.url } : {}), ...(result.error !== undefined ? { xError: result.error } : {}) }
      : { ...(result.url !== undefined ? { pickaxUrl: result.url } : {}), ...(result.error !== undefined ? { pickaxError: result.error } : {}) };
    return this.prisma.post.updateMany({ where: { id }, data });
  }

  async replaceGroupPin(tx: GroupPinTransaction, groupId: string, postId: string, pinnedAt: Date) {
    await tx.post.updateMany({ where: { communityGroupId: groupId, pinnedInGroupAt: { not: null } }, data: { pinnedInGroupAt: null } });
    await tx.post.update({ where: { id: postId, communityGroupId: groupId, ...NOT_DELETED }, data: { pinnedInGroupAt: pinnedAt } });
  }

  clearGroupPin(groupId: string) {
    return this.prisma.post.updateMany({ where: { communityGroupId: groupId, pinnedInGroupAt: { not: null } }, data: { pinnedInGroupAt: null } });
  }

  recordViewCounts(id: string, delta: { unique: number; weighted: number; total: number }) {
    return incrementPostViewCounts(this.prisma, id, {
      ...delta, weighted: delta.weighted > 0 ? delta.weighted : 0,
    });
  }

  /** Startup repair only: remove legacy excerpts copied into article-backed Board roots. */
  clearArticleMirrorBodies(ids: string[]) {
    return this.prisma.post.updateMany({ where: { id: { in: ids }, kind: 'board', articleId: { not: null }, parentId: null }, data: { body: '' } });
  }

  touchBoardThread(id: string) {
    return this.prisma.post.update({ where: { id, kind: 'board', parentId: null, ...NOT_DELETED }, data: { editedAt: new Date(), editCount: { increment: 1 } } });
  }

  deleteArticleBoardThreads(ids: string[], deletedAt: Date) {
    return this.prisma.post.updateMany({ where: { id: { in: ids }, kind: 'board', articleId: { not: null }, parentId: null }, data: { deletedAt } });
  }

  setArticleBoardVisibility(ids: string[], visibility: Exclude<PostVisibility, 'onlyMe'>) {
    return this.prisma.post.updateMany({ where: { id: { in: ids }, kind: 'board', articleId: { not: null }, parentId: null, ...NOT_DELETED }, data: { visibility } });
  }

  setBoardCommentCount(id: string, commentCount: number) {
    return this.prisma.post.update({ where: { id, kind: 'board', parentId: null }, data: { commentCount } });
  }

  /** Seeding is deliberately outside publication fanout; only the Marv bot may use it. */
  async seedMarvIntroduction(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { isBot: true, botType: true } });
    if (!user?.isBot || user.botType !== 'marvin') throw new ForbiddenException('Only Marv can receive the introductory seed post.');
    return this.prisma.post.create({ data: { userId, body: 'Hello, men!', visibility: 'verifiedOnly', kind: 'regular' } });
  }
}
