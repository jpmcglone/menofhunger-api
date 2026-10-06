import { revokeAccountChannels } from '../group-channels/channel-lifecycle';
import { Prisma } from '@prisma/client';

// One anonymous structural owner for shared conversations and deleted thread shells.
// No mapping from this owner back to a person is retained.
export const DELETED_ACCOUNT_ID = 'system-deleted-account';

/** Runs inside the erasure transaction. Preserve other members' replies and shared spaces. */
export async function eraseAccountRecords(tx: Prisma.TransactionClient, userId: string): Promise<void> {
  const now = new Date();
  await revokeAccountChannels(tx, userId);
  await tx.user.upsert({
    where: { id: DELETED_ACCOUNT_ID }, update: {},
    create: { id: DELETED_ACCOUNT_ID, name: 'Deleted account', isBot: true, bannedAt: now, bannedReason: 'system_tombstone' },
  });

  const posts = await tx.post.findMany({ where: { userId }, select: { id: true, rootId: true } });
  const postIds = posts.map(p => p.id);
  const rootIds = [...new Set(posts.flatMap(p => [p.id, ...(p.rootId ? [p.rootId] : [])]))];
  // Remove content and derived summaries before reassigning structural thread shells.
  await tx.postMedia.deleteMany({ where: { postId: { in: postIds } } });
  await tx.postPoll.deleteMany({ where: { postId: { in: postIds } } });
  await tx.postMention.deleteMany({ where: { postId: { in: postIds } } });
  await tx.marvinThreadSummary.deleteMany({ where: { rootPostId: { in: rootIds } } });
  await tx.post.updateMany({
    where: { userId },
    data: {
      userId: DELETED_ACCOUNT_ID, body: '', deletedAt: now, topics: [], hashtags: [],
      hashtagCasings: [], cashtags: [], checkinPrompt: null, checkinDayKey: null,
      scheduledPollJson: Prisma.DbNull, scheduledError: null, scheduledAt: null,
      fitnessShareId: null,
    },
  });
  // Deleting an article/comment cascades into other people's comments. Retain empty shells.
  const articles = await tx.article.findMany({ where: { authorId: userId }, select: { id: true } });
  for (const article of articles) {
    await tx.article.update({ where: { id: article.id }, data: {
      authorId: DELETED_ACCOUNT_ID, title: 'Deleted article', slug: `deleted-${article.id}`,
      body: '{}', excerpt: null, thumbnailR2Key: null, deletedAt: now,
    } });
  }
  await tx.articleComment.updateMany({ where: { authorId: userId }, data: {
    authorId: DELETED_ACCOUNT_ID, body: '', deletedAt: now,
  } });

  // Channel roots are structural: retain anonymous deleted shells so other members' replies survive.
  const channelMessages = await tx.message.findMany({ where: { senderId: userId, conversation: { type: 'channel' } }, select: { id: true } });
  const channelMessageIds = channelMessages.map(message => message.id);
  await tx.report.deleteMany({ where: { OR: [{ subjectMessageId: { in: channelMessageIds } }, { subjectArticleId: { in: articles.map(article => article.id) } }] } });
  await tx.messageMedia.deleteMany({ where: { messageId: { in: channelMessageIds } } });
  await tx.messageReaction.deleteMany({ where: { messageId: { in: channelMessageIds } } });
  await tx.groupChannelPin.deleteMany({ where: { messageId: { in: channelMessageIds } } });
  await tx.groupChannelAttention.deleteMany({ where: { messageId: { in: channelMessageIds } } });
  await tx.marvinMemorySource.deleteMany({ where: { messageId: { in: channelMessageIds } } });
  await tx.message.updateMany({ where: { id: { in: channelMessageIds } }, data: { senderId: DELETED_ACCOUNT_ID, body: '', deletedForAll: true, deletedForAllAt: now, requestHash: null, clientRequestId: null } });

  // A creator FK must not cascade-delete messages written by other participants.
  await tx.messageConversation.updateMany({ where: { createdByUserId: userId }, data: { createdByUserId: DELETED_ACCOUNT_ID } });
  await tx.messageConversation.updateMany({ where: { directKey: { contains: userId } }, data: { directKey: null } });
  const groups = await tx.communityGroup.findMany({ where: { OR: [{ createdByUserId: userId }, { members: { some: { userId, role: 'owner' } } }] }, select: { id: true } });
  for (const group of groups) {
    // Prefer a verified successor, who keeps channel access; any active member beats an orphaned group.
    const candidate = (verified: boolean) => tx.communityGroupMember.findFirst({
      where: { groupId: group.id, userId: { not: userId }, status: 'active', user: { bannedAt: null, isBot: false, ...(verified ? { verifiedStatus: { not: 'none' as const } } : {}) } },
      orderBy: [{ role: 'asc' }, { createdAt: 'asc' }], select: { userId: true },
    });
    const successor = await candidate(true) ?? await candidate(false);
    await tx.communityGroup.update({ where: { id: group.id }, data: { createdByUserId: successor?.userId ?? DELETED_ACCOUNT_ID } });
    if (successor) await tx.communityGroupMember.update({ where: { groupId_userId: { groupId: group.id, userId: successor.userId } }, data: { role: 'owner' } });
  }
  const crews = await tx.crew.findMany({ where: { ownerUserId: userId }, select: { id: true, designatedSuccessorUserId: true, wallConversationId: true } });
  for (const crew of crews) {
    const members = await tx.crewMember.findMany({ where: { crewId: crew.id, userId: { not: userId }, user: { bannedAt: null } }, orderBy: { createdAt: 'asc' }, select: { userId: true } });
    const successor = members.find(m => m.userId === crew.designatedSuccessorUserId) ?? members[0];
    await tx.crew.update({ where: { id: crew.id }, data: { ownerUserId: successor?.userId ?? DELETED_ACCOUNT_ID, designatedSuccessorUserId: null, ...(!successor ? { deletedAt: now } : {}) } });
    if (successor) await tx.messageParticipant.updateMany({ where: { conversationId: crew.wallConversationId, userId: successor.userId }, data: { role: 'owner' } });
  }
  const groupMemberships = await tx.communityGroupMember.findMany({ where: { userId, status: 'active' }, select: { groupId: true } });
  for (const membership of groupMemberships) await tx.communityGroup.updateMany({ where: { id: membership.groupId, memberCount: { gt: 0 } }, data: { memberCount: { decrement: 1 } } });
  const crewMemberships = await tx.crewMember.findMany({ where: { userId }, select: { crewId: true } });
  for (const membership of crewMemberships) await tx.crew.updateMany({ where: { id: membership.crewId, memberCount: { gt: 0 } }, data: { memberCount: { decrement: 1 } } });
  // These are organization publications, not the departing admin's personal content.
  await tx.announcement.updateMany({ where: { createdByAdminId: userId }, data: { createdByAdminId: DELETED_ACCOUNT_ID } });
  await tx.newsletter.updateMany({ where: { createdByAdminId: userId }, data: { createdByAdminId: DELETED_ACCOUNT_ID } });
  await tx.coinTransfer.updateMany({ where: { senderId: userId }, data: { senderId: DELETED_ACCOUNT_ID, note: null } });
  await tx.coinTransfer.updateMany({ where: { recipientId: userId }, data: { recipientId: DELETED_ACCOUNT_ID, note: null } });
  await tx.feedback.deleteMany({ where: { userId } });
  // Notifications can contain cached snippets even when their subject FK is SetNull.
  await tx.notification.deleteMany({ where: { OR: [{ actorUserId: userId }, { subjectUserId: userId }, { subjectPostId: { in: postIds } }, { actorPostId: { in: postIds } }] } });
  // Includes health connections/tokens, activity, body metrics, private messages,
  // sessions, profile fields, verification records, AI state and per-user settings.
  await tx.user.delete({ where: { id: userId } });
}
