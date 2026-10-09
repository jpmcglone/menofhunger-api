import { Prisma } from '@prisma/client';
import { NOT_DELETED } from '../../common/prisma/where';

type PostTransaction = Pick<Prisma.TransactionClient, 'post'>;
export type PostViewDelta = { unique: number; weighted: number; total: number };

/** Transactional metadata commands use the caller's transaction without exposing a post delegate. */
export function incrementPostViewCounts(tx: PostTransaction, id: string, delta: PostViewDelta) {
  return tx.post.update({
    where: { id },
    data: {
      ...(delta.unique !== 0 ? { viewerCount: { increment: delta.unique } } : {}),
      ...(delta.weighted !== 0 ? { weightedViewCount: { increment: delta.weighted } } : {}),
      ...(delta.total !== 0 ? { totalViewCount: { increment: delta.total } } : {}),
    },
    select: { viewerCount: true, totalViewCount: true },
  });
}

export function incrementPostViewCountsBatch(tx: PostTransaction, ids: string[], delta: PostViewDelta) {
  return tx.post.updateMany({
    where: { id: { in: ids } },
    data: {
      ...(delta.unique !== 0 ? { viewerCount: { increment: delta.unique } } : {}),
      ...(delta.weighted !== 0 ? { weightedViewCount: { increment: delta.weighted } } : {}),
      ...(delta.total !== 0 ? { totalViewCount: { increment: delta.total } } : {}),
    },
  });
}

export function postViewCountsOn(tx: PostTransaction, id: string) {
  return tx.post.findUnique({ where: { id }, select: { viewerCount: true, totalViewCount: true } });
}

export function postViewCountsBatchOn(tx: PostTransaction, ids: string[]) {
  return tx.post.findMany({ where: { id: { in: ids } }, select: { id: true, viewerCount: true, totalViewCount: true } });
}

export function adjustPostBookmarkCount(tx: PostTransaction, id: string, delta: number) {
  return tx.post.update({ where: { id }, data: { bookmarkCount: delta > 0 ? { increment: delta } : { decrement: -delta } } });
}

/** Rebuild only derived hashtag fields; publication content and permissions are untouched. */
export function backfillPostHashtags(tx: PostTransaction, id: string, hashtags: string[], hashtagCasings: string[]) {
  return tx.post.update({ where: { id }, data: { hashtags, hashtagCasings } });
}

export function postBackfillCursorOn(tx: PostTransaction, id: string) {
  return tx.post.findUnique({ where: { id }, select: { id: true, createdAt: true } });
}

export function postHashtagBackfillBatchOn(tx: PostTransaction, cursorWhere: Prisma.PostWhereInput | null, take: number) {
  return tx.post.findMany({
    where: { AND: [NOT_DELETED, ...(cursorWhere ? [cursorWhere] : [])] },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take,
    select: { id: true, body: true, hashtags: true, hashtagCasings: true },
  });
}

/** Privacy erasure retains anonymous thread shells and the original account-erasure transaction. */
export async function eraseAccountPostContent(tx: Prisma.TransactionClient, userId: string, deletedAccountId: string, now: Date) {
  const posts = await tx.post.findMany({ where: { userId }, select: { id: true, rootId: true } });
  const postIds = posts.map(post => post.id);
  const rootIds = [...new Set(posts.flatMap(post => [post.id, ...(post.rootId ? [post.rootId] : [])]))];
  await tx.postMedia.deleteMany({ where: { postId: { in: postIds } } });
  await tx.postPoll.deleteMany({ where: { postId: { in: postIds } } });
  await tx.postMention.deleteMany({ where: { postId: { in: postIds } } });
  await tx.postLink.deleteMany({ where: { postId: { in: postIds } } });
  await tx.marvinThreadSummary.deleteMany({ where: { rootPostId: { in: rootIds } } });
  await tx.post.updateMany({
    where: { userId },
    data: {
      userId: deletedAccountId, body: '', deletedAt: now, topics: [], hashtags: [],
      hashtagCasings: [], cashtags: [], checkinPrompt: null, checkinDayKey: null,
      scheduledPollJson: Prisma.DbNull, scheduledError: null, scheduledAt: null,
      fitnessShareId: null,
    },
  });
  return postIds;
}
