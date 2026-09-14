import type { PrismaService } from '../prisma/prisma.service';

/** Re-read preferences at delivery: queued fan-out and push jobs may predate a mute/unfollow. */
export async function permitsFollowNotification(
  prisma: PrismaService,
  input: { recipientUserId: string; actorUserId?: string | null; kind: string; actorPostId?: string | null; subjectPostId?: string | null },
): Promise<boolean> {
  if (!['followed_post', 'checkin_post', 'followed_article'].includes(input.kind)) return true;
  if (!input.actorUserId) return false;
  const follow = await prisma.follow.findUnique({
    where: { followerId_followingId: { followerId: input.recipientUserId, followingId: input.actorUserId } },
    select: { notificationPreference: true, postNotificationsEnabled: true },
  });
  if (!follow) return false;
  const preference = follow.notificationPreference ?? (follow.postNotificationsEnabled ? 'all' : 'posts');
  if (preference === 'off') return false;
  const postId = input.actorPostId ?? input.subjectPostId;
  if (input.kind !== 'followed_article' && postId) {
    const post = await prisma.post.findUnique({ where: { id: postId }, select: { parentId: true, deletedAt: true } });
    if (!post || post.deletedAt) return false;
    if (post.parentId && preference !== 'all') return false;
  }
  return true;
}
