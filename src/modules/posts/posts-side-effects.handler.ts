import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { CommunityGroupJoinPolicy, PostVisibility } from '@prisma/client';
import { publicAssetUrl } from '../../common/assets/public-asset-url';
import { toPostDto } from '../../common/dto/post.dto';
import { toUserDto } from '../../common/dto/user.dto';
import { parseMentionsFromBody } from '../../common/mentions/mention-regex';
import { MENTION_USER_SELECT, USER_LIST_SELECT } from '../../common/prisma-selects/user.select';
import { AppConfigService } from '../app/app-config.service';
import { JOBS } from '../jobs/jobs.constants';
import { JobsService } from '../jobs/jobs.service';
import { LinkMetadataService } from '../link-metadata/link-metadata.service';
import { MarvinBotIdentityService } from '../marvin/services/marvin-bot-identity.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PresenceRealtimeService } from '../presence/presence-realtime.service';
import { PrismaService } from '../prisma/prisma.service';
import { chunk, FANOUT_CONCURRENCY, runInBatches } from '../side-effects/batch';
import {
  FANOUT_CHUNK_SIZE,
  FANOUT_CHUNK_THRESHOLD,
  type SideEffectPayloads,
} from '../side-effects/side-effects.constants';
import { SideEffectsRegistry } from '../side-effects/side-effects.registry';
import { SideEffectsService } from '../side-effects/side-effects.service';
import { resolveMentionUsernames } from './posts-mentions.helpers';
import { notDeletedWhere } from './posts-query-builders';

/** Thread participant role for reply notifications. */
const REPLY_TITLE = {
  root_author: 'replied to your post',
  reply_author: 'replied to your comment',
  mentioned_in_root: "replied to a post you're mentioned in",
  mentioned_in_reply: "replied to a comment you're mentioned in",
} as const;

type ReplyRole = keyof typeof REPLY_TITLE;

type ThreadPostForRoles = {
  id: string;
  parentId: string | null;
  userId: string;
  mentions: { userId: string }[];
};

type PostWithRelations = Prisma.PostGetPayload<{
  include: {
    user: { select: typeof USER_LIST_SELECT };
    media: true;
    mentions: { include: { user: { select: typeof MENTION_USER_SELECT } } };
    poll: { include: { options: true } };
  };
}>;

/**
 * Everything that happens *because* a post was created or deleted, run off the request path on
 * the side-effects queue: notification fan-out, follower feed emits, check-in social proof,
 * tier-scoped group emits, link pre-warm, and the Marv reply hand-off.
 *
 * Payloads carry only ids, so this handler re-reads the post and derives the rest. That costs a
 * few queries on the worker but it is what makes a retry correct — a job that runs a minute
 * later acts on current state (deleted post, edited body, changed membership) rather than a
 * stale snapshot captured at request time.
 */
@Injectable()
export class PostsSideEffectsHandler implements OnModuleInit {
  private readonly logger = new Logger(PostsSideEffectsHandler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly presenceRealtime: PresenceRealtimeService,
    private readonly appConfig: AppConfigService,
    private readonly jobs: JobsService,
    private readonly marvIdentity: MarvinBotIdentityService,
    private readonly linkMetadata: LinkMetadataService,
    private readonly registry: SideEffectsRegistry,
    private readonly sideEffects: SideEffectsService,
  ) {}

  onModuleInit(): void {
    this.registry.register('post.created', (payload) => this.onPostCreated(payload));
    this.registry.register('post.deleted', (payload) => this.onPostDeleted(payload));
    this.registry.register('post.engagement.changed', (payload) => this.onEngagementChanged(payload));
    this.registry.register('post.quote.changed', (payload) => this.onQuoteChanged(payload));
  }

  // ─── post.engagement.changed ──────────────────────────────────────────

  /**
   * Reconcile the author's boost/repost notification with the current engagement state.
   *
   * The un-boost / un-repost direction deletes rather than writes, which makes the pair
   * naturally idempotent: whichever job runs last wins, and a retry converges on the same
   * result as the first attempt.
   */
  private async onEngagementChanged(payload: SideEffectPayloads['post.engagement.changed']): Promise<void> {
    const { kind, active, postId, recipientUserId, actorUserId } = payload;
    if (!postId || !recipientUserId || !actorUserId) return;

    if (!active) {
      await (kind === 'boost'
        ? this.notifications.deleteBoostNotification(recipientUserId, actorUserId, postId)
        : this.notifications.deleteRepostNotification(recipientUserId, actorUserId, postId));
      return;
    }

    if (kind === 'repost') {
      await this.notifications.upsertRepostNotification({
        recipientUserId,
        actorUserId,
        subjectPostId: postId,
        actorPostId: payload.actorPostId ?? undefined,
      });
      return;
    }

    // Re-read the body so a retry carries the post's current text, not a request-time snapshot.
    const post = await this.prisma.post.findFirst({
      where: { id: postId, deletedAt: null },
      select: { body: true, kind: true },
    });
    if (!post) return;

    await this.notifications.upsertBoostNotification({
      recipientUserId,
      actorUserId,
      subjectPostId: postId,
      bodySnippet: (post.body ?? '').trim().slice(0, 150) || null,
      subjectPostKind: post.kind,
    });
  }

  // ─── post.quote.changed ───────────────────────────────────────────────

  /**
   * When a post's quoted link changes, reconcile the 'repost' notification on both the old
   * and new quoted targets, then re-emit `posts:liveUpdated` so open viewers update quote info.
   *
   * Idempotent: deleteRepost + upsertRepost both converge on retries.
   */
  private async onQuoteChanged(payload: SideEffectPayloads['post.quote.changed']): Promise<void> {
    const { postId, actorUserId, prevQuotedPostId, nextQuotedPostId } = payload;
    if (!postId || !actorUserId) return;

    // Fetch the editing post body for the new-target notification snippet.
    const editingPost = await this.prisma.post.findFirst({
      where: { id: postId, deletedAt: null },
      select: { body: true },
    });

    // Delete the quote notification on the old target (if any and non-self).
    if (prevQuotedPostId) {
      const prevOwner = await this.prisma.post.findFirst({
        where: { id: prevQuotedPostId },
        select: { userId: true },
      });
      if (prevOwner && prevOwner.userId !== actorUserId) {
        // Uses the same notification row as a regular repost; keyed by
        // (recipientUserId, actorUserId, subjectPostId=quoted, kind='repost').
        await this.notifications.deleteRepostNotification(prevOwner.userId, actorUserId, prevQuotedPostId);
      }
    }

    // Upsert a new quote notification on the new target (if any and non-self).
    if (nextQuotedPostId && editingPost) {
      const nextTarget = await this.prisma.post.findFirst({
        where: { id: nextQuotedPostId, deletedAt: null },
        select: { userId: true },
      });
      if (nextTarget && nextTarget.userId !== actorUserId) {
        await this.notifications.upsertRepostNotification({
          recipientUserId: nextTarget.userId,
          actorUserId,
          subjectPostId: nextQuotedPostId,
          actorPostId: postId,
          title: 'quoted your post',
        });
      }
    }

    // Best-effort realtime emits so open viewers see the updated quote counts.
    const now = new Date().toISOString();
    for (const pid of [prevQuotedPostId, nextQuotedPostId].filter(Boolean) as string[]) {
      try {
        this.presenceRealtime.emitPostsLiveUpdated(pid, {
          postId: pid,
          version: now,
          reason: 'quote_count_changed',
          patch: {},
        });
      } catch { /* best-effort */ }
    }

    // Re-emit on the editing post so its viewers pick up the new body.
    if (editingPost) {
      try {
        this.presenceRealtime.emitPostsLiveUpdated(postId, {
          postId,
          version: now,
          reason: 'post_edited',
          patch: { body: editingPost.body ?? '' },
        });
      } catch { /* best-effort */ }
    }
  }

  // ─── post.deleted ─────────────────────────────────────────────────────

  /**
   * Drop every notification that pointed at this post. Deleting a post should never fail
   * because notification cleanup did, so this stays off the request path.
   */
  private async onPostDeleted(payload: SideEffectPayloads['post.deleted']): Promise<void> {
    const postId = (payload.postId ?? '').trim();
    if (!postId) return;
    await Promise.allSettled([
      this.notifications.deleteBySubjectPostId(postId),
      this.notifications.deleteByActorPostId(postId),
    ]);
  }

  // ─── post.created ─────────────────────────────────────────────────────

  private async onPostCreated(payload: SideEffectPayloads['post.created']): Promise<void> {
    const postId = (payload.postId ?? '').trim();
    const actorUserId = (payload.actorUserId ?? '').trim();
    if (!postId || !actorUserId) return;

    const post = (await this.prisma.post.findFirst({
      where: { id: postId, deletedAt: null },
      include: {
        user: { select: USER_LIST_SELECT },
        media: { orderBy: { position: 'asc' } },
        mentions: { include: { user: { select: MENTION_USER_SELECT } } },
        poll: { include: { options: { orderBy: { position: 'asc' } } } },
      },
    })) as PostWithRelations | null;

    // Deleted between the write and this job — there is nothing left to notify about.
    if (!post) {
      this.logger.debug(`[side-effects] post.created skipped: post ${postId} is gone.`);
      return;
    }

    const parentId = post.parentId ?? null;
    const visibility = post.visibility as PostVisibility;
    const bodySnippet = (post.body ?? '').trim().slice(0, 150);

    const [parentAuthorUserId, threadPostsForRoles, bodyMentionIds, quotedInfo] = await Promise.all([
      this.loadParentAuthorUserId(parentId),
      this.loadThreadPostsForRoles(post),
      this.loadBodyMentionIds(post.body ?? ''),
      this.loadQuotedInfo(post.quotedPostId ?? null),
    ]);

    await this.runPostCreateSideEffects({
      actorUserId,
      post,
      parentId,
      parentAuthorUserId,
      threadPostsForRoles,
      bodyMentionIds,
      bodyMentionSet: new Set(bodyMentionIds),
      bodySnippet,
      visibility,
      quotedInfo,
      didAwardStreak: Boolean(payload.didAwardStreak),
      requestedMarvMode: payload.requestedMarvMode ?? null,
    });

    await this.emitTierScopedGroupNewPost(post);
  }

  private async loadParentAuthorUserId(parentId: string | null): Promise<string | null> {
    if (!parentId) return null;
    const parent = await this.prisma.post.findFirst({
      where: { id: parentId },
      select: { userId: true },
    });
    return parent?.userId ?? null;
  }

  /**
   * The thread tree used to assign reply roles. Re-read here rather than snapshotted, so this
   * reflects any posts added or deleted since the reply was written.
   */
  private async loadThreadPostsForRoles(post: PostWithRelations): Promise<ThreadPostForRoles[]> {
    if (!post.parentId) return [];
    const rootId = post.rootId ?? post.parentId;
    return await this.prisma.post.findMany({
      where: { OR: [{ id: rootId }, { rootId }], ...notDeletedWhere() },
      select: { id: true, parentId: true, userId: true, mentions: { select: { userId: true } } },
    });
  }

  /**
   * Only @mentions written in the body earn a `mention` notification (and outrank a `comment`
   * notification for the same person). Mentions inherited from thread participants do not, so
   * we re-parse the body instead of reading the post's mention rows.
   */
  private async loadBodyMentionIds(body: string): Promise<string[]> {
    const usernames = parseMentionsFromBody(body);
    if (usernames.length === 0) return [];
    return await resolveMentionUsernames(this.prisma, usernames);
  }

  private async loadQuotedInfo(
    quotedPostId: string | null,
  ): Promise<{ quotedAuthorId: string; quotedPostId: string } | null> {
    if (!quotedPostId) return null;
    const quoted = await this.prisma.post.findFirst({
      where: { id: quotedPostId, deletedAt: null },
      select: { id: true, userId: true },
    });
    if (!quoted) return null;
    return { quotedAuthorId: quoted.userId, quotedPostId: quoted.id };
  }

  /**
   * Tier-scoped `groups:newPost` emit for non-public group posts.
   *
   * The public case is emitted synchronously from `createPost` because it needs no extra query
   * and members should see the post appear immediately. This branch needs a full member+tier
   * scan to build the audience, which is exactly the kind of work that does not belong on a
   * request.
   */
  private async emitTierScopedGroupNewPost(post: PostWithRelations): Promise<void> {
    const groupId = post.communityGroupId ?? null;
    const visibility = post.visibility as string;
    if (post.parentId || !groupId || visibility === 'public') return;

    const tierScoped = visibility === 'premiumOnly' || visibility === 'verifiedOnly';
    if (!tierScoped) return;

    try {
      const members = await this.prisma.communityGroupMember.findMany({
        where: { groupId, status: 'active' },
        select: { userId: true, user: { select: { premium: true, premiumPlus: true, verifiedStatus: true } } },
      });
      const eligible = members
        .filter((m) => {
          if (visibility === 'premiumOnly') return m.user.premium || m.user.premiumPlus;
          return (m.user.verifiedStatus && m.user.verifiedStatus !== 'none') || m.user.premium || m.user.premiumPlus;
        })
        .map((m) => m.userId);
      if (eligible.length === 0) return;

      const groupPostDto = toPostDto(post, this.appConfig.r2()?.publicBaseUrl ?? null, {
        viewerHasBoosted: false,
        includeInternal: false,
      });
      this.presenceRealtime.emitGroupNewPost(
        groupId,
        { groupId, post: groupPostDto },
        { eligibleMemberUserIds: eligible },
      );
    } catch (err) {
      this.logger.warn(
        `[groups] Failed tier-scoped groups:newPost for post ${post.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Compute thread participant roles by walking the parent chain in memory.
   *
   * `threadPosts` is the full thread tree (root + descendants) fetched in one query. Walking in
   * memory avoids one DB round trip per ancestor, which dominated deep-thread latency.
   */
  private computeThreadRolesFromPosts(
    threadPosts: ThreadPostForRoles[],
    parentId: string,
  ): Map<string, ReplyRole> {
    const map = new Map<string, ReplyRole>();
    const byId = new Map(threadPosts.map((p) => [p.id, p]));
    let currentId: string | null = parentId;
    while (currentId) {
      const post = byId.get(currentId);
      if (!post) break;
      const isRoot = !post.parentId;
      const authorRole: ReplyRole = isRoot ? 'root_author' : 'reply_author';
      const mentionRole: ReplyRole = isRoot ? 'mentioned_in_root' : 'mentioned_in_reply';
      if (!map.has(post.userId)) map.set(post.userId, authorRole);
      for (const m of post.mentions) {
        if (!map.has(m.userId)) map.set(m.userId, mentionRole);
      }
      currentId = post.parentId;
    }
    return map;
  }

  /**
   * Notification fan-out, follower scan, `feed:newPost` emit, check-in social proof, the
   * streak self-sync emit, and the Marv hand-off. Every step is wrapped so one failure never
   * stops the others — best-effort always.
   */
  private async runPostCreateSideEffects(args: {
    actorUserId: string;
    post: PostWithRelations;
    parentId: string | null;
    parentAuthorUserId: string | null;
    threadPostsForRoles: ThreadPostForRoles[];
    bodyMentionIds: string[];
    bodyMentionSet: Set<string>;
    bodySnippet: string;
    visibility: PostVisibility;
    quotedInfo: { quotedAuthorId: string; quotedPostId: string } | null;
    didAwardStreak: boolean;
    requestedMarvMode: 'fast' | 'regular' | 'smart' | null;
  }): Promise<void> {
    const {
      actorUserId,
      post,
      parentId,
      parentAuthorUserId,
      threadPostsForRoles,
      bodyMentionIds,
      bodyMentionSet,
      bodySnippet,
      visibility,
      quotedInfo,
      didAwardStreak,
      requestedMarvMode,
    } = args;
    const userId = actorUserId;
    const postCommunityGroupId = post.communityGroupId ?? null;
    let postGroupJoinPolicy: CommunityGroupJoinPolicy | null | undefined = undefined;
    const checkedGroupNotificationMemberIds = new Set<string>();
    const activeGroupNotificationMemberIds = new Set<string>();
    let groupNotificationMembershipLookupFailed = false;

    const loadPostGroupJoinPolicy = async (): Promise<CommunityGroupJoinPolicy | null> => {
      if (!postCommunityGroupId) return null;
      if (postGroupJoinPolicy !== undefined) return postGroupJoinPolicy;
      try {
        const group = await this.prisma.communityGroup.findUnique({
          where: { id: postCommunityGroupId },
          select: { joinPolicy: true },
        });
        postGroupJoinPolicy = group?.joinPolicy ?? null;
        return postGroupJoinPolicy;
      } catch (err) {
        this.logger.warn(
          `[notifications] Failed to evaluate group policy for post notifications: ${err instanceof Error ? err.message : String(err)}`,
        );
        postGroupJoinPolicy = null;
        return null;
      }
    };

    const loadActiveGroupNotificationMembers = async (recipientUserIds: string[]): Promise<void> => {
      if (!postCommunityGroupId || groupNotificationMembershipLookupFailed) return;
      const missingIds = [...new Set(recipientUserIds.filter((id) => id && !checkedGroupNotificationMemberIds.has(id)))];
      if (missingIds.length === 0) return;

      try {
        const members = await this.prisma.communityGroupMember.findMany({
          where: {
            groupId: postCommunityGroupId,
            userId: { in: missingIds },
            status: 'active',
          },
          select: { userId: true },
        });
        for (const uid of missingIds) checkedGroupNotificationMemberIds.add(uid);
        for (const member of members) activeGroupNotificationMemberIds.add(member.userId);
      } catch (err) {
        this.logger.warn(
          `[notifications] Failed to evaluate group membership for post notifications: ${err instanceof Error ? err.message : String(err)}`,
        );
        groupNotificationMembershipLookupFailed = true;
      }
    };

    const canNotifyForGroupPost = async (
      recipientUserId: string | null | undefined,
      opts?: { allowPublicOpenGroupMention?: boolean },
    ): Promise<boolean> => {
      if (!postCommunityGroupId) return true;
      const uid = (recipientUserId ?? '').trim();
      if (!uid) return false;

      if (opts?.allowPublicOpenGroupMention && visibility === 'public') {
        const joinPolicy = await loadPostGroupJoinPolicy();
        if (joinPolicy === 'open') return true;
      }

      await loadActiveGroupNotificationMembers([uid]);
      if (groupNotificationMembershipLookupFailed) return false;
      return activeGroupNotificationMemberIds.has(uid);
    };

    try {
      // Quote repost notification: notify the quoted post's author (skip self-quotes).
      if (quotedInfo && quotedInfo.quotedAuthorId !== userId && (await canNotifyForGroupPost(quotedInfo.quotedAuthorId))) {
        await this.notifications
          .upsertRepostNotification({
            recipientUserId: quotedInfo.quotedAuthorId,
            actorUserId: userId,
            subjectPostId: quotedInfo.quotedPostId,
            actorPostId: post.id,
            title: 'quoted your post',
          })
          .catch((err) => {
            this.logger.warn(
              `[notifications] Failed to create quote repost notification: ${err instanceof Error ? err.message : String(err)}`,
            );
          });
      }

      // Notifications: parent author + thread participants get "comment" notifications.
      // Only explicit @mentions in body get "mention" notifications (and override "comment" for that user).
      let threadRoles: Map<string, ReplyRole> | null = null;
      if (parentId && parentAuthorUserId !== userId) {
        threadRoles = this.computeThreadRolesFromPosts(threadPostsForRoles, parentId);
        const parentRole = threadRoles.get(parentAuthorUserId ?? '');
        const parentTitle =
          parentRole === 'reply_author'
            ? REPLY_TITLE.reply_author
            : parentRole === 'root_author'
              ? REPLY_TITLE.root_author
              : REPLY_TITLE.reply_author;

        if (parentAuthorUserId && !bodyMentionSet.has(parentAuthorUserId) && (await canNotifyForGroupPost(parentAuthorUserId))) {
          await this.notifications
            .create({
              recipientUserId: parentAuthorUserId,
              kind: 'comment',
              actorUserId: userId,
              actorPostId: post.id,
              subjectPostId: parentId,
              title: parentTitle,
              body: bodySnippet || undefined,
            })
            .catch((err) => {
              this.logger.warn(
                `[notifications] Failed to create comment notification: ${err instanceof Error ? err.message : String(err)}`,
              );
            });
        }

        const threadRecipients: Array<{ uid: string; role: ReplyRole }> = [];
        for (const [uid, role] of threadRoles) {
          if (uid === userId || uid === parentAuthorUserId || bodyMentionSet.has(uid)) continue;
          if (!(await canNotifyForGroupPost(uid))) continue;
          threadRecipients.push({ uid, role });
        }
        await runInBatches(threadRecipients, FANOUT_CONCURRENCY, async ({ uid, role }) => {
          await this.notifications
            .create({
              recipientUserId: uid,
              kind: 'comment',
              actorUserId: userId,
              actorPostId: post.id,
              subjectPostId: parentId,
              title: REPLY_TITLE[role],
              body: bodySnippet || undefined,
            })
            .catch((err) => {
              this.logger.warn(
                `[notifications] Failed to create thread reply notification: ${err instanceof Error ? err.message : String(err)}`,
              );
            });
        });
      }

      // Explicit @mentions in body: one notification each (priority over comment notifications).
      // Group posts are members-only for notifications, except public posts in OPEN
      // groups where an explicit mention is allowed to reach a non-member.
      const canMentionNonMembersInPublicOpenGroup =
        Boolean(postCommunityGroupId) &&
        bodyMentionIds.length > 0 &&
        visibility === 'public' &&
        (await loadPostGroupJoinPolicy()) === 'open';
      if (postCommunityGroupId && bodyMentionIds.length > 0 && !canMentionNonMembersInPublicOpenGroup) {
        await loadActiveGroupNotificationMembers(bodyMentionIds.filter((uid) => uid !== userId));
      }

      const mentionRecipients: string[] = [];
      for (const uid of bodyMentionIds) {
        if (uid === userId) continue;
        if (!canMentionNonMembersInPublicOpenGroup && !(await canNotifyForGroupPost(uid))) continue;
        mentionRecipients.push(uid);
      }
      await runInBatches(mentionRecipients, FANOUT_CONCURRENCY, async (uid) => {
        let mentionTitle: string;
        if (!parentId) {
          mentionTitle = 'mentioned you in a post';
        } else if (uid === parentAuthorUserId) {
          mentionTitle = 'mentioned you in a reply to your post';
        } else {
          mentionTitle = 'mentioned you in a reply to a post';
        }
        await this.notifications
          .create({
            recipientUserId: uid,
            kind: 'mention',
            actorUserId: userId,
            actorPostId: post.id,
            subjectPostId: post.id,
            title: mentionTitle,
            body: bodySnippet || undefined,
          })
          .catch((err) => {
            this.logger.warn(
              `[notifications] Failed to create mention notification: ${err instanceof Error ? err.message : String(err)}`,
            );
          });
      });

      // Badge-only notifications for all active group members when a top-level post is created in a group.
      if (!parentId && postCommunityGroupId) {
        try {
          const [groupMembers, groupRecord] = await Promise.all([
            this.prisma.communityGroupMember.findMany({
              where: { groupId: postCommunityGroupId, status: 'active', userId: { not: userId } },
              select: { userId: true },
            }),
            this.prisma.communityGroup.findUnique({
              where: { id: postCommunityGroupId },
              select: { name: true },
            }),
          ]);
          const memberIds = groupMembers.map((m) => m.userId);
          if (memberIds.length > 0) {
            await this.notifications
              .createGroupPostBadgeNotifications({
                actorUserId: userId,
                postId: post.id,
                groupId: postCommunityGroupId,
                recipientUserIds: memberIds,
                actorName: post.user.name ?? post.user.username ?? 'Someone',
                groupName: groupRecord?.name ?? 'the group',
                bodySnippet: bodySnippet || undefined,
              })
              .catch((err) => {
                this.logger.warn(
                  `[notifications] Failed to create group-post badge notifications: ${err instanceof Error ? err.message : String(err)}`,
                );
              });
          }
        } catch (err) {
          this.logger.warn(
            `[notifications] Failed to fan out group-post badge notifications: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      // Follower notifications + feed:newPost realtime emit (top-level only).
      // Group posts are excluded from home feeds; the Groups badge (community_group_post
      // notification row) is the only signal for new group activity on followers' home surfaces.
      const feedFollowerIds: string[] = [];
      const followerNotificationIds: string[] = [];
      if (!postCommunityGroupId && visibility !== 'onlyMe') {
        try {
          const follows = await this.prisma.follow.findMany({
            where: { followingId: userId },
            select: {
              followerId: true,
              postNotificationsEnabled: true,
              follower: { select: { verifiedStatus: true, premium: true, premiumPlus: true } },
            },
          });

          for (const f of follows) {
            const recipientUserId = f.followerId;
            if (!recipientUserId || recipientUserId === userId) continue;
            if (bodyMentionSet.has(recipientUserId)) continue;
            if (parentId && (recipientUserId === parentAuthorUserId || threadRoles?.has(recipientUserId))) continue;
            if (parentId && !f.postNotificationsEnabled) continue;
            if (!(await canNotifyForGroupPost(recipientUserId))) continue;

            if (visibility === 'verifiedOnly') {
              const vs = f.follower?.verifiedStatus ?? 'none';
              if (!vs || vs === 'none') continue;
            }
            if (visibility === 'premiumOnly') {
              const isPremium = Boolean(f.follower?.premium || f.follower?.premiumPlus);
              if (!isPremium) continue;
            }

            // Status posts skip the followed_post notification — followers receive a
            // status_update notification instead (fired by the presence domain event).
            // Checkin posts use the checkin_post kind so followers can filter them separately.
            if (post.kind !== 'status') followerNotificationIds.push(recipientUserId);

            if (!parentId) feedFollowerIds.push(recipientUserId);
          }

          await this.fanOutFollowerPostNotifications({
            recipientUserIds: followerNotificationIds,
            kind: post.kind === 'checkin' ? 'checkin_post' : 'followed_post',
            actorUserId: userId,
            postId: post.id,
            bodySnippet,
          });
        } catch (err) {
          this.logger.warn(
            `[notifications] Failed to query followers for followed-post notifications: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      // Realtime: push new top-level post to home feeds of eligible followers (best-effort).
      if (!parentId && feedFollowerIds.length > 0) {
        try {
          const feedPostDto = toPostDto(post, this.appConfig.r2()?.publicBaseUrl ?? null, {
            viewerHasBoosted: false,
            includeInternal: false,
          });
          this.presenceRealtime.emitFeedNewPost(feedFollowerIds, { post: feedPostDto });
        } catch {
          // Best-effort
        }
      }

      // Check-in social proof: tell the actor's circle (followers + crew members) that
      // someone they care about answered today's question. The receiver UI uses this to
      // increment the daily total and prepend a face on the home hero, no refetch needed.
      // We emit only for non-private check-ins; onlyMe should never leak presence.
      const postKind = post.kind ?? null;
      const checkinDayKey = post.checkinDayKey ?? null;
      if (postKind === 'checkin' && checkinDayKey) {
        // Clear the 6pm check-in reminder for this user now that they've answered.
        await this.clearCheckinReminder(userId).catch((err) => {
          this.logger.warn(
            `[checkin-reminder] Failed to clear reminder for user ${userId}: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
      }
      if (postKind === 'checkin' && checkinDayKey && visibility !== 'onlyMe') {
        try {
          const [allFollowers, crewMembers, totalToday, actor] = await Promise.all([
            this.prisma.follow.findMany({
              where: { followingId: userId },
              select: { followerId: true },
            }),
            this.prisma.crewMember.findMany({
              where: {
                crew: { members: { some: { userId } } },
                userId: { not: userId },
              },
              select: { userId: true },
            }),
            this.prisma.post.count({
              where: {
                kind: 'checkin',
                checkinDayKey,
                deletedAt: null,
                visibility: { not: 'onlyMe' },
              },
            }),
            this.prisma.user.findUnique({
              where: { id: userId },
              select: {
                id: true,
                username: true,
                name: true,
                avatarKey: true,
                avatarUpdatedAt: true,
              },
            }),
          ]);

          if (actor) {
            const recipientIds = new Set<string>();
            for (const f of allFollowers) {
              if (f.followerId && f.followerId !== userId) recipientIds.add(f.followerId);
            }
            for (const m of crewMembers) {
              if (m.userId && m.userId !== userId) recipientIds.add(m.userId);
            }

            if (recipientIds.size > 0) {
              const avatarUrl = publicAssetUrl({
                publicBaseUrl: this.appConfig.r2()?.publicBaseUrl ?? null,
                key: actor.avatarKey,
                updatedAt: actor.avatarUpdatedAt,
              });
              this.presenceRealtime.emitCheckinAnsweredToday(recipientIds, {
                dayKey: checkinDayKey,
                totalToday,
                answerer: {
                  id: actor.id,
                  username: actor.username,
                  displayName: (actor.name ?? actor.username ?? '').trim() || null,
                  avatarUrl,
                },
              });
            }
          }
        } catch (err) {
          this.logger.warn(
            `[checkin] Failed to fan out checkin:answeredToday: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      // If we awarded streak/coins today, sync self snapshot across tabs/devices (best-effort).
      if (didAwardStreak) {
        try {
          const u = await this.prisma.user.findUnique({ where: { id: userId } });
          if (u) {
            this.presenceRealtime.emitUsersMeUpdated(userId, {
              user: toUserDto(u, this.appConfig.r2()?.publicBaseUrl ?? null),
              reason: 'streak_awarded',
            });
          }
        } catch {
          // Best-effort
        }
      }

      await this.maybeEnqueueMarvReply({ post, actorUserId, bodySnippet, visibility, requestedMarvMode });
    } catch (err) {
      this.logger.warn(
        `[posts] Deferred post-create side effects failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Pre-warm link-metadata cache for any external URLs in the post body.
    // Runs outside the main try/catch so a scrape failure never affects the
    // side-effect pipeline. The 5-min backfill cron is the safety net.
    const bodyUrls = this.linkMetadata.extractLinks(post.body ?? '');
    if (bodyUrls.length > 0) {
      await this.linkMetadata.backfillForUrls(bodyUrls).catch((err) => {
        this.logger.debug(`[link-metadata] pre-warm failed for post ${post.id}: ${(err as Error).message}`);
      });
    }
  }

  /**
   * Fan out `followed_post` / `checkin_post` notifications.
   *
   * Small sets are written here with bounded concurrency. Large ones are split into
   * `notification.fanout.chunk` child jobs — this is the piece that means an account with
   * 50,000 followers doesn't hold one worker (and a slice of the Prisma pool) for minutes,
   * and that a failure part-way through only retries the affected slice.
   */
  private async fanOutFollowerPostNotifications(args: {
    recipientUserIds: string[];
    kind: 'followed_post' | 'checkin_post';
    actorUserId: string;
    postId: string;
    bodySnippet: string;
  }): Promise<void> {
    const { recipientUserIds, kind, actorUserId, postId, bodySnippet } = args;
    if (recipientUserIds.length === 0) return;

    if (recipientUserIds.length > FANOUT_CHUNK_THRESHOLD) {
      for (const slice of chunk(recipientUserIds, FANOUT_CHUNK_SIZE)) {
        this.sideEffects.dispatch('notification.fanout.chunk', {
          kind,
          recipientUserIds: slice,
          actorUserId,
          actorPostId: postId,
          subjectPostId: postId,
          subjectUserId: actorUserId,
          subjectArticleId: null,
          subjectGroupId: null,
          title: null,
          body: bodySnippet || null,
        });
      }
      return;
    }

    await runInBatches(recipientUserIds, FANOUT_CONCURRENCY, async (recipientUserId) => {
      await this.notifications
        .create({
          recipientUserId,
          kind,
          actorUserId,
          actorPostId: postId,
          subjectPostId: postId,
          subjectUserId: actorUserId,
          body: bodySnippet || undefined,
        })
        .catch((err) => {
          this.logger.warn(
            `[notifications] Failed to create followed-post notification: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
    });
  }

  /**
   * Delete any pending checkin_reminder notification for the user now that they have checked in.
   * Decrements the undelivered badge count for any unread (not yet delivered) reminders removed.
   */
  private async clearCheckinReminder(userId: string): Promise<void> {
    const existing = await this.prisma.notification.findMany({
      where: { kind: 'checkin_reminder', recipientUserId: userId },
      select: { id: true, deliveredAt: true },
    });
    if (existing.length === 0) return;

    await this.prisma.notification.deleteMany({
      where: { kind: 'checkin_reminder', recipientUserId: userId },
    });

    const unreadCount = existing.filter((n) => n.deliveredAt === null).length;
    if (unreadCount > 0) {
      await this.prisma.user.update({
        where: { id: userId },
        data: { undeliveredNotificationCount: { decrement: unreadCount } },
      });
    }

    const undeliveredCount = await this.prisma.notification
      .count({ where: { recipientUserId: userId, deliveredAt: null } })
      .catch(() => 0);
    this.presenceRealtime.emitNotificationsUpdated(userId, { undeliveredCount });
    this.presenceRealtime.emitNotificationsDeleted(userId, { notificationIds: existing.map((n) => n.id) });
  }

  /**
   * Detect @marv in the post body and hand off to the Marv queue.
   *
   * Fully decoupled — posts don't know about MarvinModule. Detection runs against the
   * configured Marv username so the queueing surface stays dumb and the processor handles all
   * gating (premium, credits, rate limits, the AI call).
   *
   * Two triggers:
   *   1. Explicit — the body contains @marv (the configured username).
   *   2. Implicit — the post is a direct reply to a post authored by Marv. Replying to Marv
   *      directly implies the mention, so the user doesn't need to type it.
   */
  private async maybeEnqueueMarvReply(args: {
    post: PostWithRelations;
    actorUserId: string;
    bodySnippet: string;
    visibility: PostVisibility;
    requestedMarvMode: 'fast' | 'regular' | 'smart' | null;
  }): Promise<void> {
    const { post, actorUserId, bodySnippet, visibility, requestedMarvMode } = args;
    try {
      const marvCfg = this.appConfig.marvBot();
      if (!marvCfg.enabled) {
        this.logger.log(`[marv] mention-detect post=${post.id} skip reason=marv_disabled`);
        return;
      }

      const marvUsernameLower = marvCfg.username.trim().toLowerCase();
      const bodyMentions = parseMentionsFromBody(post.body ?? '').map((u) => u.trim().toLowerCase());
      const bodyMentionUsernamesLower = new Set(bodyMentions);
      const resolvedMarvId = this.marvIdentity.cachedMarvUserId() ?? marvCfg.userId ?? null;
      const actorIsMarv = Boolean(resolvedMarvId && actorUserId === resolvedMarvId);
      const mentionsMarv = bodyMentionUsernamesLower.has(marvUsernameLower);

      // Check for implied mention: direct reply to one of Marv's posts.
      let impliedMention = false;
      const parentPostId = post.parentId ?? null;
      if (!mentionsMarv && !actorIsMarv && parentPostId && resolvedMarvId) {
        const parentAuthor = await this.prisma.post.findFirst({
          where: { id: parentPostId, deletedAt: null },
          select: { userId: true },
        });
        impliedMention = parentAuthor?.userId === resolvedMarvId;
        if (impliedMention) {
          this.logger.log(
            `[marv] mention-detect post=${post.id} implied-mention via direct reply to parent=${parentPostId} (authored by marv)`,
          );
        }
      }

      if (!mentionsMarv && !impliedMention) {
        this.logger.log(
          `[marv] mention-detect post=${post.id} skip reason=no_mention mentions=[${bodyMentions.join(',') || '-'}] expected=@${marvUsernameLower}`,
        );
        return;
      }
      if (actorIsMarv) {
        this.logger.log(`[marv] mention-detect post=${post.id} skip reason=actor_is_marv`);
        return;
      }

      const rootPostId = post.rootId ?? post.id;
      const postGroupId = post.communityGroupId ?? null;

      // If this post is inside a community group, check whether Marv is an active member.
      // If he isn't, send a one-time informational notification instead of a reply.
      if (postGroupId) {
        const marvId = resolvedMarvId ?? (await this.marvIdentity.getMarvUserId());
        if (marvId) {
          const marvMembership = await this.prisma.communityGroupMember.findUnique({
            where: { groupId_userId: { groupId: postGroupId, userId: marvId } },
            select: { status: true },
          });
          if (marvMembership?.status !== 'active') {
            this.logger.log(`[marv] mention-detect post=${post.id} skip reason=marv_not_in_group groupId=${postGroupId}`);
            await this.notifications
              .upsertMarvNotInGroupNotification({
                recipientUserId: actorUserId,
                marvUserId: marvId,
                postId: post.id,
                groupId: postGroupId,
              })
              .catch(() => undefined);
            return;
          }
        }
      }

      this.logger.log(
        `[marv] mention-detect post=${post.id} HIT enqueueing root=${rootPostId} actor=${actorUserId} requestedMode=${requestedMarvMode ?? 'null'}`,
      );
      await this.jobs
        .enqueue(
          JOBS.marvinReplyPublic,
          {
            postId: post.id,
            rootPostId,
            requestingUserId: actorUserId,
            requestedMode: requestedMarvMode,
            bodySnippet,
            visibility,
          },
          {
            // Stable job id per post so a retried side-effect job doesn't enqueue Marv twice.
            jobId: `marv-public-${post.id}`,
            removeOnComplete: true,
            removeOnFail: false,
            attempts: 3,
            backoff: { type: 'exponential' as const, delay: 5000 },
          },
        )
        .then(() => {
          this.logger.log(`[marv] mention-detect post=${post.id} enqueued ok`);
        })
        .catch((err) => {
          this.logger.warn(
            `[marv] Failed to enqueue public reply job for post=${post.id}: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
    } catch (err) {
      this.logger.warn(
        `[marv] mention-detection during side-effects failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
