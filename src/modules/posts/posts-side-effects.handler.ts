import { NotificationEngagementWriterService } from "../notifications";
import { NotificationCreatorService } from "../notifications/notification-creator.service";
import { NotificationInviteWriterService } from "../notifications/notification-invite-writer.service";
import { POST_LIST_INCLUDE } from '../../common/prisma-includes/post.include';
import { EmbeddingsService } from '../embeddings/embeddings.service';
import { ContentScreenService } from '../moderation-screen/content-screen.service';
import { Inject, Injectable, Logger, Optional, type OnModuleInit } from '@nestjs/common';
import type { CommunityGroupJoinPolicy, PostVisibility } from '@prisma/client';
import { publicAssetUrl } from '../../common/assets/public-asset-url';
import { toPostDto } from '../../common/dto/post.dto';
import { toUserDto } from '../../common/dto/user.dto';
import { USER_BRIEF_SELECT } from '../../common/prisma-selects/user.select';
import { AppConfigService } from '../app/app-config.service';
import { JobsService } from '../jobs/jobs.service';
import { PostsTopicsClassifyService } from './posts-topics-classify.service';
import { LinkMetadataService } from '../link-metadata/link-metadata.service';
import { MarvinAddressingService } from '../marvin/services/marvin-addressing.service';
import { MarvinBotIdentityService } from '../marvin/services/marvin-bot-identity.service';
import { PresenceRealtimeService } from '../presence/presence-realtime.service';
import { PrismaService } from '../prisma/prisma.service';
import { FANOUT_CONCURRENCY, runInBatches } from '../side-effects/batch';
import { type SideEffectPayloads } from '../side-effects/side-effects.constants';
import { SideEffectsRegistry } from '../side-effects/side-effects.registry';
import { SideEffectsService } from '../side-effects/side-effects.service';
import { listCrewmateUserIds } from '../viewer/crew-membership.queries';
import { listActiveGroupMemberIds, listActiveGroupMemberPreferences } from '../viewer/group-membership.queries';
import { REPLY_TITLE, BOARD_REPLY_TITLE, type ReplyRole, type ThreadPostForRoles, type PostWithRelations } from './posts-side-effects.constants';
import { extractLinks } from '../link-metadata/link-metadata-extract';
import { PostsCreatedEffectsService } from './posts-created-effects.service';
import { PostsEngagementEffectsService } from './posts-engagement-effects.service';
import { NOT_DELETED } from '../../common/prisma/where';

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
  readonly logger = new Logger(PostsSideEffectsHandler.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(NotificationEngagementWriterService) private readonly notificationEngagementWriterService: Pick< NotificationEngagementWriterService, "upsertRepostNotification" >,
    @Inject(NotificationCreatorService) private readonly notificationCreatorService: Pick< NotificationCreatorService, "create" >,
    @Inject(NotificationInviteWriterService) private readonly notificationInviteWriterService: Pick< NotificationInviteWriterService, "createGroupPostBadgeNotifications" >,
    private readonly presenceRealtime: PresenceRealtimeService,
    private readonly appConfig: AppConfigService,
    private readonly jobs: JobsService,
    private readonly marvIdentity: MarvinBotIdentityService,
    private readonly linkMetadata: LinkMetadataService,
    private readonly registry: SideEffectsRegistry,
    private readonly sideEffects: SideEffectsService,
    private readonly topicsClassify: PostsTopicsClassifyService,
    private readonly engagementEffects: PostsEngagementEffectsService,
    private readonly createdEffects: PostsCreatedEffectsService,
    @Optional() private readonly marvAddressing?: MarvinAddressingService,
    @Optional() private readonly embeddings?: EmbeddingsService,
    @Optional() private readonly contentScreen?: ContentScreenService,
  ) {}

  onModuleInit(): void {
    this.registry.register('post.created', (payload) => this.onPostCreated(payload));
    this.registry.register('board.mentions.added', (payload) => this.onPostCreated({
      postId: payload.postId, actorUserId: payload.actorUserId, didAwardStreak: false,
      requestedMarvMode: null,
    }, payload.recipientIds));
    this.registry.register('post.deleted', (payload) => this.onPostDeleted(payload));
    this.registry.register('media.searchNote.recorded', (payload) => this.onSearchNoteRecorded(payload));
    this.registry.register('post.engagement.changed', (payload) => this.onEngagementChanged(payload));
    this.registry.register('post.quote.changed', (payload) => this.onQuoteChanged(payload));
  }

  private async screenPost(postId: string): Promise<void> {
    if (!this.contentScreen) return;
    try {
      await this.contentScreen.screenPost(postId, await this.marvIdentity.getMarvUserId());
    } catch (err) {
      this.logger.warn(`[content-screen] ${postId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ─── post.engagement.changed ──────────────────────────────────────────

  async onEngagementChanged(payload: SideEffectPayloads['post.engagement.changed']) : Promise<void> {
    return this.engagementEffects.onEngagementChanged(payload);
  }

  // ─── post.quote.changed ───────────────────────────────────────────────

  async onQuoteChanged(payload: SideEffectPayloads['post.quote.changed']) : Promise<void> {
    return this.engagementEffects.onQuoteChanged(payload);
  }

  // ─── post.deleted ─────────────────────────────────────────────────────

  async onPostDeleted(payload: SideEffectPayloads['post.deleted']) : Promise<void> {
    return this.engagementEffects.onPostDeleted(payload);
  }

  // ─── media.searchNote.recorded ────────────────────────────────────────

  async onSearchNoteRecorded(payload: SideEffectPayloads['media.searchNote.recorded']) : Promise<void> {
    return this.engagementEffects.onSearchNoteRecorded(payload);
  }

  // ─── post.created ─────────────────────────────────────────────────────

  private async onPostCreated(payload: SideEffectPayloads['post.created'], mentionRecipients?: string[]): Promise<void> {
    const postId = (payload.postId ?? '').trim();
    const actorUserId = (payload.actorUserId ?? '').trim();
    if (!postId || !actorUserId) return;

    const post = (await this.prisma.post.findFirst({
      where: { id: postId, ...NOT_DELETED },
      include: POST_LIST_INCLUDE,
    })) as PostWithRelations | null;

    // Deleted between the write and this job — there is nothing left to notify about.
    if (!post) {
      this.logger.debug(`[side-effects] post.created skipped: post ${postId} is gone.`);
      return;
    }

    void this.topicsClassify.enqueueIfNeeded(postId);
    this.sideEffects.dispatch('post.replyPrompt.classify', { postId });
    void this.embeddings?.indexPost(postId).catch(() => undefined);
    void this.screenPost(postId);

    const parentId = post.parentId ?? null;
    const visibility = post.visibility as PostVisibility;
    const bodySnippet = (post.body ?? '').trim().slice(0, 150);

    const [parentAuthorUserId, threadPostsForRoles, bodyMentionIds, quotedInfo] = await Promise.all([
      this.loadParentAuthorUserId(parentId),
      this.loadThreadPostsForRoles(post),
      this.loadBodyMentionIds(post.body ?? ''),
      this.loadQuotedInfo(post.quotedPostId ?? null),
    ]);

    const currentMentionIds = mentionRecipients ? bodyMentionIds.filter(id => mentionRecipients.includes(id)) : bodyMentionIds;
    await this.runPostCreateSideEffects({
      mentionsOnly: mentionRecipients !== undefined,
      actorUserId,
      post,
      parentId,
      parentAuthorUserId,
      threadPostsForRoles,
      bodyMentionIds: currentMentionIds,
      bodyMentionSet: new Set(currentMentionIds),
      bodySnippet,
      visibility,
      quotedInfo,
      didAwardStreak: Boolean(payload.didAwardStreak),
      requestedMarvMode: payload.requestedMarvMode ?? null,
    });

    if (!mentionRecipients) await this.emitTierScopedGroupNewPost(post);
  }

  async loadParentAuthorUserId(parentId: string | null) : Promise<string | null> {
    return this.createdEffects.loadParentAuthorUserId(parentId);
  }

  async loadThreadPostsForRoles(post: PostWithRelations) : Promise<ThreadPostForRoles[]> {
    return this.createdEffects.loadThreadPostsForRoles(post);
  }

  async loadBodyMentionIds(body: string) : Promise<string[]> {
    return this.createdEffects.loadBodyMentionIds(body);
  }

  async loadQuotedInfo(quotedPostId: string | null) : Promise<{ quotedAuthorId: string; quotedPostId: string } | null> {
    return this.createdEffects.loadQuotedInfo(quotedPostId);
  }

  async emitTierScopedGroupNewPost(post: PostWithRelations) : Promise<void> {
    return this.createdEffects.emitTierScopedGroupNewPost(post);
  }

  computeThreadRolesFromPosts(threadPosts: ThreadPostForRoles[], parentId: string) : Map<string, ReplyRole> {
    return this.createdEffects.computeThreadRolesFromPosts(threadPosts, parentId);
  }

  /**
   * Notification fan-out, follower scan, `feed:newPost` emit, check-in social proof, the
   * streak self-sync emit, and the Marv hand-off. Every step is wrapped so one failure never
   * stops the others — best-effort always.
   */
  private async runPostCreateSideEffects(args: {
    mentionsOnly?: boolean;
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
    const mutedGroupMemberIds = new Set<string>();
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
        const members = await listActiveGroupMemberPreferences(this.prisma, postCommunityGroupId, missingIds);
        for (const uid of missingIds) checkedGroupNotificationMemberIds.add(uid);
        for (const member of members) {
          activeGroupNotificationMemberIds.add(member.userId);
          if (member.notificationPreference === 'muted') mutedGroupMemberIds.add(member.userId);
        }
      } catch (err) {
        this.logger.warn(
          `[notifications] Failed to evaluate group membership for post notifications: ${err instanceof Error ? err.message : String(err)}`,
        );
        groupNotificationMembershipLookupFailed = true;
      }
    };

    const canNotifyForGroupPost = async (
      recipientUserId: string | null | undefined,
    ): Promise<boolean> => {
      if (!postCommunityGroupId) return true;
      const uid = (recipientUserId ?? '').trim();
      if (!uid) return false;

      await loadActiveGroupNotificationMembers([uid]);
      if (groupNotificationMembershipLookupFailed || mutedGroupMemberIds.has(uid)) return false;

      return activeGroupNotificationMemberIds.has(uid);
    };

    try {
      // Quote repost notification: notify the quoted post's author (skip self-quotes).
      if (!args.mentionsOnly && quotedInfo && quotedInfo.quotedAuthorId !== userId && (await canNotifyForGroupPost(quotedInfo.quotedAuthorId))) {
        await this.notificationEngagementWriterService.upsertRepostNotification({
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
      const replyTitles = post.kind === 'board' ? BOARD_REPLY_TITLE : REPLY_TITLE;
      if (!args.mentionsOnly && parentId && parentAuthorUserId !== userId) {
        threadRoles = this.computeThreadRolesFromPosts(threadPostsForRoles, parentId);
        const parentRole = threadRoles.get(parentAuthorUserId ?? '');
        const parentTitle =
          parentRole === 'reply_author'
            ? replyTitles.reply_author
            : parentRole === 'root_author'
              ? replyTitles.root_author
              : replyTitles.reply_author;

        if (parentAuthorUserId && !bodyMentionSet.has(parentAuthorUserId) && (await canNotifyForGroupPost(parentAuthorUserId))) {
          await this.notificationCreatorService.create({
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
          await this.notificationCreatorService.create({
              recipientUserId: uid,
              kind: 'comment',
              actorUserId: userId,
              actorPostId: post.id,
              subjectPostId: parentId,
              title: replyTitles[role],
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
      // Open groups allow explicit mentions of verified non-members. The notification
      // recipient must still meet the verified reading requirement.
      const canMentionNonMembersInOpenGroup =
        Boolean(postCommunityGroupId) &&
        bodyMentionIds.length > 0 &&
        (visibility === 'public' || visibility === 'verifiedOnly') &&
        (await loadPostGroupJoinPolicy()) === 'open';
      if (postCommunityGroupId && bodyMentionIds.length > 0) {
        await loadActiveGroupNotificationMembers(bodyMentionIds.filter((uid) => uid !== userId));
      }

      const mentionRecipients: string[] = [];
      for (const uid of bodyMentionIds) {
        if (uid === userId) continue;
        // Always check preferences, including muted members of open groups.
        const activeAndNotMuted = await canNotifyForGroupPost(uid);
        if (groupNotificationMembershipLookupFailed || mutedGroupMemberIds.has(uid)) continue;
        if (!canMentionNonMembersInOpenGroup && !activeAndNotMuted) continue;
        if (canMentionNonMembersInOpenGroup && !activeAndNotMuted) {
          const recipient = await this.prisma.user.findUnique({ where: { id: uid }, select: { verifiedStatus: true, siteAdmin: true } });
          if (!recipient?.siteAdmin && (!recipient?.verifiedStatus || recipient.verifiedStatus === 'none')) continue;
        }
        mentionRecipients.push(uid);
      }
      await runInBatches(mentionRecipients, FANOUT_CONCURRENCY, async (uid) => {
        let mentionTitle: string;
        if (post.kind === 'board') {
          mentionTitle = parentId ? 'mentioned you in a Board comment' : 'mentioned you in a Board post';
        } else if (!parentId) {
          mentionTitle = 'mentioned you in a post';
        } else if (uid === parentAuthorUserId) {
          mentionTitle = 'mentioned you in a reply to your post';
        } else {
          mentionTitle = 'mentioned you in a reply to a post';
        }
        await this.notificationCreatorService.create({
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

      if (args.mentionsOnly) {
        await this.maybeEnqueueMarvReply({ post, actorUserId, bodySnippet, visibility,
          requestedMarvMode, addedMentionIds: bodyMentionIds });
        return;
      }

      // Badge-only notifications for all active group members when a top-level post is created in a group.
      if (!parentId && postCommunityGroupId) {
        try {
          const [memberIds, groupRecord] = await Promise.all([
            listActiveGroupMemberIds(this.prisma, postCommunityGroupId, { excludeUserId: userId }),
            this.prisma.communityGroup.findUnique({
              where: { id: postCommunityGroupId },
              select: { name: true },
            }),
          ]);
          if (memberIds.length > 0) {
            await this.notificationInviteWriterService.createGroupPostBadgeNotifications({
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
      // Board-only rows (comments, threads not cross-posted) never reach follower feeds or bells.
      if (!postCommunityGroupId && visibility !== 'onlyMe' && !post.boardOnly) {
        try {
          const follows = await this.prisma.follow.findMany({
            where: { followingId: userId },
            select: {
              followerId: true,
              postNotificationsEnabled: true,
              notificationPreference: true,
              follower: {
                select: {
                  verifiedStatus: true,
                  premium: true,
                  premiumPlus: true,
                  accountKind: true,
                },
              },
            },
          });

          for (const f of follows) {
            const recipientUserId = f.followerId;
            if (!recipientUserId || recipientUserId === userId) continue;
            if (bodyMentionSet.has(recipientUserId)) continue;
            if (parentId && (recipientUserId === parentAuthorUserId || threadRoles?.has(recipientUserId))) continue;
            const preference = f.notificationPreference ?? (f.postNotificationsEnabled ? 'all' : 'posts');
            if (parentId && preference !== 'all') continue;
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
            // Following a page is an explicit subscription, including for its operators.
            // Scheduled/delegated publication need not have been performed by this follower.
            // Pages never receive checkin_post bells — person-only, both as actor and follower.
            if (
              preference !== 'off' &&
              post.kind !== 'status' &&
              !(post.kind === 'checkin' && f.follower?.accountKind === 'page')
            ) {
              followerNotificationIds.push(recipientUserId);
            }

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
        // Clear the evening check-in reminder for this user now that they've answered.
        await this.clearCheckinReminder(userId).catch((err) => {
          this.logger.warn(
            `[checkin-reminder] Failed to clear reminder for user ${userId}: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
      }
      if (postKind === 'checkin' && checkinDayKey && visibility !== 'onlyMe') {
        try {
          const [allFollowers, crewmateIds, totalToday, actor] = await Promise.all([
            this.prisma.follow.findMany({
              where: { followingId: userId },
              select: { followerId: true },
            }),
            listCrewmateUserIds(this.prisma, userId),
            this.prisma.post.count({
              where: {
                kind: 'checkin',
                checkinDayKey,
                ...NOT_DELETED,
                visibility: { not: 'onlyMe' },
              },
            }),
            this.prisma.user.findUnique({
              where: { id: userId },
              select: {
                ...USER_BRIEF_SELECT,
                avatarKey: true, avatarVideoKey: true, avatarVideoDurationMs: true,
                avatarUpdatedAt: true,
              },
            }),
          ]);

          if (actor) {
            const recipientIds = new Set<string>();
            for (const f of allFollowers) {
              if (f.followerId && f.followerId !== userId) recipientIds.add(f.followerId);
            }
            for (const id of crewmateIds) {
              if (id && id !== userId) recipientIds.add(id);
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

      await this.maybeEnqueueMarvReply({
        post,
        actorUserId,
        bodySnippet,
        visibility,
        requestedMarvMode,
      });
    } catch (err) {
      this.logger.warn(
        `[posts] Deferred post-create side effects failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Pre-warm link-metadata cache for any external URLs in the post body.
    // Runs outside the main try/catch so a scrape failure never affects the
    // side-effect pipeline. The 5-min backfill cron is the safety net.
    const bodyUrls = extractLinks(post.body ?? '');
    if (bodyUrls.length > 0) {
      await this.linkMetadata.backfillForUrls(bodyUrls).catch((err) => {
        this.logger.debug(`[link-metadata] pre-warm failed for post ${post.id}: ${(err as Error).message}`);
      });
    }
  }

  async fanOutFollowerPostNotifications(args: { recipientUserIds: string[]; kind: 'followed_post' | 'checkin_post'; actorUserId: string; postId: string; bodySnippet: string }) : Promise<void> {
    return this.createdEffects.fanOutFollowerPostNotifications(args);
  }

  async clearCheckinReminder(userId: string) : Promise<void> {
    return this.createdEffects.clearCheckinReminder(userId);
  }

  async maybeEnqueueMarvReply(args: { post: PostWithRelations; actorUserId: string; bodySnippet: string; visibility: PostVisibility; requestedMarvMode: 'fast' | 'regular' | 'smart' | null; addedMentionIds?: string[] }) : Promise<void> {
    return this.createdEffects.maybeEnqueueMarvReply(args);
  }

  async isUntaggedAddressToMarv(post: PostWithRelations, actorUserId: string, marvId: string | null) : Promise<boolean> {
    return this.createdEffects.isUntaggedAddressToMarv(post, actorUserId, marvId);
  }
}
