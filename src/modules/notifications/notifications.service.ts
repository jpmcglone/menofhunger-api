import { Injectable, Logger } from '@nestjs/common';
import { Prisma, type NotificationKind } from '@prisma/client';
import * as webpush from 'web-push';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfigService } from '../app/app-config.service';
import { publicAssetUrl } from '../../common/assets/public-asset-url';
import { createdAtIdCursorWhere } from '../../common/pagination/created-at-id-cursor';
import { PresenceRealtimeService } from '../presence/presence-realtime.service';
import { JobsService } from '../jobs/jobs.service';
import { JOBS } from '../jobs/jobs.constants';
import { ViewerContextService } from '../viewer/viewer-context.service';
import type { NotificationActorDto, NotificationDto, SubjectPostPreviewDto, SubjectArticlePreviewDto, SubjectPostVisibility, SubjectTier } from './notification.dto';
import type {
  FollowedPostsRollupDto,
  NotificationFeedItemDto,
  NotificationGroupDto,
  NotificationGroupKind,
} from '../../common/dto/notification-feed.dto';
import type { NotificationPreferencesDto } from '../../common/dto';
import { PosthogService } from '../../common/posthog/posthog.service';
import { POST_WITH_POLL_INCLUDE } from '../../common/prisma-includes/post.include';
import { buildAttachParentChain } from '../posts/posts.utils';
import { toPostDto } from '../../common/dto/post.dto';
import { toCommunityGroupPreviewDto, type CommunityGroupPreviewDto } from '../../common/dto/community-group.dto';
import { collapseFeedByRoot, type FeedCollapseMode, type FeedCollapsePrefer } from '../../common/feed-collapse/collapse-by-root';

export type NotificationUnreadByKind = Partial<Record<NotificationKind | 'all', number>>;

export type CreateNotificationParams = {
  recipientUserId: string;
  kind: NotificationKind;
  actorUserId?: string | null;
  actorPostId?: string | null;
  subjectPostId?: string | null;
  subjectUserId?: string | null;
  subjectArticleId?: string | null;
  subjectArticleCommentId?: string | null;
  subjectGroupId?: string | null;
  subjectCrewId?: string | null;
  subjectCrewInviteId?: string | null;
  subjectCommunityGroupInviteId?: string | null;
  subjectConversationId?: string | null;
  title?: string | null;
  body?: string | null;
};

type PushActorContext = {
  id: string;
  username: string | null;
  name: string | null;
  avatarKey: string | null;
  avatarUpdatedAt: Date | null;
};

/** Coalesce window (ms) per push kind to reduce fatigue. */
const PUSH_COALESCE_MS: Partial<Record<string, number>> = {
  nudge: 15 * 60 * 1000,
  followed_post: 5 * 60 * 1000,
  repost: 2 * 60 * 1000,
  message: 30 * 1000,
};
const DEFAULT_COALESCE_MS = 60 * 1000;

/** Render a small list of names as natural English: "A", "A and B", "A, B, and C". */
function formatNameList(names: string[]): string {
  const list = names.filter((n) => n && n.trim().length > 0);
  if (list.length === 0) return '';
  if (list.length === 1) return list[0];
  if (list.length === 2) return `${list[0]} and ${list[1]}`;
  const head = list.slice(0, -1).join(', ');
  return `${head}, and ${list[list.length - 1]}`;
}

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);
  private vapidConfigured = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly appConfig: AppConfigService,
    private readonly presenceRealtime: PresenceRealtimeService,
    private readonly jobs: JobsService,
    private readonly posthog: PosthogService,
    private readonly viewerContextService: ViewerContextService,
  ) {}

  private async getVisiblePostsByIds(params: {
    viewerUserId: string;
    ids: string[];
    includeDeleted?: boolean;
    excludeBannedAuthors?: boolean;
  }) {
    const { viewerUserId, ids, includeDeleted = false, excludeBannedAuthors = false } = params;
    const uniqueIds = [...new Set((ids ?? []).map((id) => (id ?? '').trim()).filter(Boolean))];
    if (!uniqueIds.length) return [] as Prisma.PostGetPayload<{ include: typeof POST_WITH_POLL_INCLUDE }>[];

    const viewer = await this.viewerContextService.getViewer(viewerUserId);
    const allowed = this.viewerContextService.allowedPostVisibilities(viewer);

    const fetched = await this.prisma.post.findMany({
      where: {
        id: { in: uniqueIds },
        ...(includeDeleted ? {} : { deletedAt: null }),
        ...(excludeBannedAuthors ? { user: { bannedAt: null } } : {}),
      },
      include: POST_WITH_POLL_INCLUDE,
    });

    const visibleFetched = fetched.filter((post) => {
      const isSelf = Boolean(viewer && viewer.id === post.userId);
      if (isSelf) return true;
      if (post.visibility === 'onlyMe') return Boolean(viewer?.siteAdmin);
      return allowed.includes(post.visibility);
    });

    const byId = new Map(visibleFetched.map((p) => [p.id, p] as const));
    return uniqueIds.map((id) => byId.get(id)).filter((p): p is (typeof visibleFetched)[number] => Boolean(p));
  }

  private async collectParentMapForViewer(viewerUserId: string, seedParentIds: Array<string | null | undefined>) {
    const parentMap = new Map<string, Prisma.PostGetPayload<{ include: typeof POST_WITH_POLL_INCLUDE }>>();
    let toFetch = new Set<string>((seedParentIds ?? []).filter((id): id is string => Boolean(id)));
    while (toFetch.size > 0) {
      const batch = [...toFetch].filter((id) => !parentMap.has(id));
      if (batch.length === 0) break;
      const rows = await this.getVisiblePostsByIds({
        viewerUserId,
        ids: batch,
        includeDeleted: true,
        excludeBannedAuthors: false,
      });
      const byId = new Map(rows.map((p) => [p.id, p] as const));
      const next = new Set<string>();
      for (const id of batch) {
        const post = byId.get(id);
        if (!post) continue;
        parentMap.set(id, post);
        if (post.parentId) next.add(post.parentId);
      }
      toFetch = next;
    }
    return parentMap;
  }

  private async collectRepostedMapForViewer(viewerUserId: string, repostedPostIds: string[]) {
    const ids = [...new Set((repostedPostIds ?? []).map((id) => (id ?? '').trim()).filter(Boolean))];
    if (!ids.length) return new Map<string, Prisma.PostGetPayload<{ include: typeof POST_WITH_POLL_INCLUDE }>>();
    const rows = await this.getVisiblePostsByIds({
      viewerUserId,
      ids,
      includeDeleted: true,
      excludeBannedAuthors: false,
    });
    return new Map(rows.map((p) => [p.id, p] as const));
  }

  private async getUndeliveredCountInternal(recipientUserId: string): Promise<number> {
    return this.prisma.notification.count({
      where: this.undeliveredBellWhere(recipientUserId),
    });
  }

  private undeliveredBellWhere(recipientUserId: string): Prisma.NotificationWhereInput {
    return {
      recipientUserId,
      deliveredAt: null,
      kind: { not: 'message' },
    };
  }

  async getUnreadCountsByKind(recipientUserId: string): Promise<NotificationUnreadByKind> {
    const rows = await this.prisma.notification.groupBy({
      by: ['kind'],
      where: {
        recipientUserId,
        readAt: null,
        kind: { not: 'message' },
      },
      _count: { _all: true },
    });

    const counts: NotificationUnreadByKind = { all: 0 };
    for (const row of rows) {
      const count = row._count._all;
      counts[row.kind] = count;
      counts.all = (counts.all ?? 0) + count;
    }
    return counts;
  }

  /**
   * Count of unread `comment` notifications for a user — drives the "waiting on you" dot
   * on the Home tab. Cheap to compute (kind+readAt are part of the notifications recipient index).
   */
  async getUnreadCommentCount(recipientUserId: string): Promise<number> {
    return this.prisma.notification.count({
      where: { recipientUserId, kind: 'comment', readAt: null },
    });
  }

  /**
   * Recompute the unread-comment count and emit a `notifications:waitingCountChanged` event.
   * Best-effort: never throws; safe to call after any mutation that could affect the count.
   */
  private async emitWaitingCountForUser(recipientUserId: string): Promise<void> {
    try {
      const unreadCommentCount = await this.getUnreadCommentCount(recipientUserId);
      this.presenceRealtime.emitNotificationsWaitingChanged(recipientUserId, { unreadCommentCount });
    } catch (err) {
      this.logger.debug(`[notifications] Failed to emit waiting count: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** True if recipient already has a follow notification from actor within the last withinMs. Use to avoid spam when someone unfollows then follows again. */
  async hasRecentFollowNotification(
    recipientUserId: string,
    actorUserId: string,
    withinMs: number,
  ): Promise<boolean> {
    const since = new Date(Date.now() - withinMs);
    const existing = await this.prisma.notification.findFirst({
      where: {
        recipientUserId,
        actorUserId,
        kind: 'follow',
        createdAt: { gte: since },
      },
      select: { id: true },
    });
    return Boolean(existing);
  }

  async create(params: CreateNotificationParams) {
    const {
      recipientUserId,
      kind,
      actorUserId,
      actorPostId,
      subjectPostId,
      subjectUserId,
      subjectArticleId,
      subjectArticleCommentId,
      subjectGroupId,
      subjectCrewId,
      subjectCrewInviteId,
      subjectCommunityGroupInviteId,
      subjectConversationId,
      title,
      body,
    } = params;

    // Never notify a user about their own actions — regardless of which call-site triggered this.
    if (actorUserId && actorUserId === recipientUserId) return;

    const fallbackTitle =
      title ??
      ({
        follow: 'followed you',
        boost: 'boosted your post',
        followed_post: 'posted',
        followed_article: 'published an article',
        mention: 'mentioned you',
        comment: 'replied to you',
        poll_results_ready: 'Poll results are ready',
        coin_transfer: 'sent you coins',
        message: 'sent you a message',
        group_join_request: 'requests to join your group',
        community_group_member_joined: 'joined the group',
        community_group_join_approved: 'Your join request was approved',
        community_group_join_rejected: 'Your join request was not accepted',
        community_group_member_removed: 'You were removed from a group',
        community_group_disbanded: 'A group you were in was disbanded',
        crew_invite_received: 'invited you to their crew',
        crew_invite_accepted: 'accepted your crew invite',
        crew_invite_declined: 'declined your crew invite',
        crew_invite_cancelled: 'cancelled their crew invite',
        crew_member_joined: 'joined your crew',
        crew_member_left: 'left your crew',
        crew_member_kicked: 'was removed from your crew',
        crew_owner_transferred: 'Crew ownership transferred',
        crew_owner_transfer_vote: 'started a vote to transfer ownership',
        crew_wall_mention: 'mentioned you on the crew wall',
        crew_disbanded: 'Your crew was disbanded',
        community_group_invite_received: 'invited you to their group',
        community_group_invite_accepted: 'accepted your group invite',
        community_group_invite_declined: 'declined your group invite',
        community_group_invite_cancelled: 'cancelled their group invite',
      } as Partial<Record<NotificationKind, string>>)[kind] ??
      null;

    const { notification, undeliveredCount } = await this.prisma.$transaction(async (tx) => {
      const notification = await tx.notification.create({
        data: {
          recipientUserId,
          kind,
          actorUserId: actorUserId ?? undefined,
          actorPostId: actorPostId ?? undefined,
          subjectPostId: subjectPostId ?? undefined,
          subjectUserId: subjectUserId ?? undefined,
          subjectArticleId: subjectArticleId ?? undefined,
          subjectArticleCommentId: subjectArticleCommentId ?? undefined,
          subjectGroupId: subjectGroupId ?? undefined,
          subjectCrewId: subjectCrewId ?? undefined,
          subjectCrewInviteId: subjectCrewInviteId ?? undefined,
          subjectCommunityGroupInviteId: subjectCommunityGroupInviteId ?? undefined,
          subjectConversationId: subjectConversationId ?? undefined,
          title: fallbackTitle ?? undefined,
          body: body ?? undefined,
        },
      });
      // Increment the denormalized counter for bookkeeping, but compute the real undelivered
      // count from actual rows to emit an accurate realtime badge (counter can drift over time).
      await tx.user.update({
        where: { id: recipientUserId },
        data: { undeliveredNotificationCount: { increment: 1 } },
      });
      const undeliveredCount = await tx.notification.count({
        where: { recipientUserId, deliveredAt: null },
      });
      return { notification, undeliveredCount };
    });

    this.presenceRealtime.emitNotificationsUpdated(recipientUserId, {
      undeliveredCount,
    });

    // "Waiting on you" dot: a new reply just landed for this user — recompute the count.
    if (kind === 'comment') {
      void this.emitWaitingCountForUser(recipientUserId);
    }

    // Also emit the full notification payload so clients can update in-place without refetch.
    try {
      const dto = await this.buildNotificationDtoForRecipient({
        recipientUserId,
        notificationId: notification.id,
      });
      if (dto) {
        this.presenceRealtime.emitNotificationNew(recipientUserId, { notification: dto });
      }
    } catch (err) {
      // Best-effort: never fail notification creation on realtime emission.
      this.logger.debug(`[notifications] Failed to emit notifications:new: ${err}`);
    }

    // Web push is optional (VAPID + user preference).
    try {
      const prefs = await this.getPreferencesInternal(recipientUserId);
      if (this.shouldSendPushForKind(prefs, kind)) {
        const actor = actorUserId
          ? await this.prisma.user.findUnique({
              where: { id: actorUserId },
              select: {
                id: true,
                username: true,
                name: true,
                avatarKey: true,
                avatarUpdatedAt: true,
              },
            })
          : null;
        const pushCopy = this.buildPushCopy({
          kind,
          actor,
          fallbackTitle,
          body,
          subjectArticleId,
        });
        const commentHash = subjectArticleCommentId ? `#comment-${subjectArticleCommentId}` : '';
        // Route to the article page for all article-related notification kinds.
        const pushUrl = subjectArticleId && (
          kind === 'comment' || kind === 'mention' || kind === 'followed_article' || kind === 'boost'
        )
          ? `/a/${subjectArticleId}${commentHash}`
          : kind === 'comment' && actorPostId
            ? `/p/${actorPostId}`
            : kind === 'mention' && actorPostId
              ? `/p/${actorPostId}`
              : kind === 'boost' && subjectPostId
                ? `/p/${subjectPostId}`
                : kind === 'coin_transfer'
                  ? '/coins'
                  : null;
        const pushTag = this.buildPushTag({
          recipientUserId,
          kind,
          actorUserId: actorUserId ?? null,
          subjectPostId: subjectPostId ?? null,
          subjectUserId: subjectUserId ?? null,
        });
        const publicBaseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;
        const icon = actor
          ? publicAssetUrl({
              publicBaseUrl,
              key: actor.avatarKey,
              updatedAt: actor.avatarUpdatedAt,
            })
          : null;
        this.sendWebPushToRecipient(recipientUserId, {
          title: pushCopy.title,
          body: pushCopy.body,
          notificationId: notification.id,
          subjectPostId: subjectPostId ?? null,
          subjectUserId: subjectUserId ?? null,
          url: pushUrl,
          tag: pushTag,
          icon,
          badge: '/android-chrome-192x192.png',
          renotify: true,
          kind,
          // Intentionally omit sourceLabel for actor-driven pushes: the actor's words
          // (snippet) are the most valuable byte budget. sourceLabel is reserved for
          // system-originated pushes (streak reminders, daily prompt, message channel).
        }).catch((err) => {
          this.logger.warn(`[push] Failed to send web push: ${err instanceof Error ? err.message : String(err)}`);
        });
      }
    } catch (err) {
      // Best-effort: never fail notification creation on push preference issues.
      this.logger.debug(`[push] Failed to evaluate push preferences: ${err}`);
    }

    // Optional: enqueue instant email for high-signal events (mentions + replies).
    if (kind === 'mention' || kind === 'comment') {
      try {
        await this.jobs.enqueueCron(
          JOBS.notificationsInstantHighSignalEmail,
          { userId: recipientUserId },
          `notifications:instantHighSignalEmail:${recipientUserId}`,
          {
            delay: 2 * 60_000,
            attempts: 2,
            backoff: { type: 'exponential', delay: 60_000 },
          },
        );
      } catch {
        // likely duplicate jobId; treat as no-op (batching).
      }
    }

    return notification;
  }

  private async getPreferencesInternal(userId: string) {
    return await this.prisma.notificationPreferences.upsert({
      where: { userId },
      create: { userId },
      update: {},
    });
  }

  private shouldSendPushForKind(
    prefs: Pick<
      NotificationPreferencesDto,
      | 'pushComment'
      | 'pushBoost'
      | 'pushFollow'
      | 'pushMention'
      | 'pushRepost'
      | 'pushNudge'
      | 'pushFollowedPost'
      | 'pushMessage'
      | 'pushGroupActivity'
    >,
    kind: NotificationKind,
  ): boolean {
    if (kind === 'comment') return Boolean(prefs.pushComment);
    if (kind === 'boost') return Boolean(prefs.pushBoost);
    if (kind === 'follow') return Boolean(prefs.pushFollow);
    if (kind === 'mention') return Boolean(prefs.pushMention);
    if (kind === 'repost') return Boolean(prefs.pushRepost);
    if (kind === 'nudge') return Boolean(prefs.pushNudge);
    if (kind === 'followed_post') return Boolean(prefs.pushFollowedPost);
    if (kind === 'followed_article') return Boolean(prefs.pushFollowedPost);
    if (kind === 'message') return Boolean(prefs.pushMessage);
    if (
      kind === 'community_group_member_joined' ||
      kind === 'community_group_join_approved' ||
      kind === 'community_group_join_rejected' ||
      kind === 'community_group_member_removed' ||
      kind === 'community_group_disbanded' ||
      kind === 'group_join_request' ||
      kind === 'community_group_invite_received' ||
      kind === 'community_group_invite_accepted' ||
      kind === 'community_group_invite_declined' ||
      kind === 'community_group_invite_cancelled'
    ) return Boolean(prefs.pushGroupActivity);
    // Non-mapped kinds pass through default (allow).
    return true;
  }

  private actorDisplayName(actor?: PushActorContext | null): string {
    const name = (actor?.name ?? '').trim();
    if (name) return name;
    const username = (actor?.username ?? '').trim();
    if (username) return `@${username}`;
    return 'Someone';
  }

  private trimPushBody(body?: string | null, max = 140): string | null {
    const text = (body ?? '').trim().replace(/\s+/g, ' ');
    if (!text) return null;
    if (text.length <= max) return text;
    return `${text.slice(0, Math.max(0, max - 1))}…`;
  }

  private buildPushTag(params: {
    recipientUserId: string;
    kind: NotificationKind;
    actorUserId?: string | null;
    subjectPostId?: string | null;
    subjectUserId?: string | null;
  }): string {
    const { recipientUserId, kind, actorUserId, subjectPostId, subjectUserId } = params;
    if (subjectPostId) return `notif-${kind}-post-${subjectPostId}`;
    if (subjectUserId) return `notif-${kind}-user-${subjectUserId}`;
    if (actorUserId) return `notif-${kind}-actor-${actorUserId}`;
    return `notif-${kind}-${recipientUserId}`;
  }

  private buildPushCopy(params: {
    kind: NotificationKind;
    actor?: PushActorContext | null;
    fallbackTitle?: string | null;
    body?: string | null;
    subjectArticleId?: string | null;
  }): { title: string; body?: string } {
    const { kind, actor, fallbackTitle, body, subjectArticleId } = params;
    const actorName = this.actorDisplayName(actor);
    const snippet = this.trimPushBody(body);
    // Prefer the role-specific DB title (already encodes "post" vs "comment" / article variants)
    // when it's set, just prefixed with the actor name. This keeps push wording in lockstep
    // with what the in-app row shows.
    const titleFromFallback = (fallbackTitle ?? '').trim();
    if (kind === 'comment') {
      if (titleFromFallback) {
        return {
          title: `${actorName} ${titleFromFallback}`,
          body: snippet ?? (subjectArticleId ? 'Open to view the comment.' : 'Open to view the reply.'),
        };
      }
      if (subjectArticleId) {
        return {
          title: `${actorName} commented on your article`,
          body: snippet ?? 'Open to view the comment.',
        };
      }
      return {
        title: `${actorName} replied to your post`,
        body: snippet ?? 'Open to view the reply.',
      };
    }
    if (kind === 'mention') {
      if (titleFromFallback) {
        return {
          title: `${actorName} ${titleFromFallback}`,
          body: snippet ?? 'Open to view the mention.',
        };
      }
      if (subjectArticleId) {
        return {
          title: `${actorName} mentioned you in an article comment`,
          body: snippet ?? 'Open to view the mention.',
        };
      }
      return {
        title: `${actorName} mentioned you`,
        body: snippet ?? 'Open to view the mention.',
      };
    }
    if (kind === 'follow') {
      return {
        title: `${actorName} followed you`,
        body: snippet ?? 'Open their profile.',
      };
    }
    if (kind === 'boost') {
      if (subjectArticleId) {
        return {
          title: `${actorName} boosted your article`,
          body: snippet ?? 'Your article is getting traction.',
        };
      }
      return {
        title: `${actorName} boosted your post`,
        body: snippet ?? 'Your post is getting traction.',
      };
    }
    if (kind === 'repost') {
      return {
        title: `${actorName} reposted your post`,
        body: snippet ?? 'Open to view the repost.',
      };
    }
    if (kind === 'followed_post') {
      return {
        title: `${actorName} shared a new post`,
        body: snippet ?? 'Open to read it.',
      };
    }
    if (kind === 'followed_article') {
      return {
        title: `${actorName} published an article`,
        body: snippet ?? 'Open to read it.',
      };
    }
    if (kind === 'nudge') {
      return {
        title: `${actorName} nudged you`,
        body: snippet ?? 'Open notifications to respond.',
      };
    }
    if (kind === 'poll_results_ready') {
      return {
        title: 'Poll results are ready',
        body: snippet ?? 'Open to see the results.',
      };
    }
    if (kind === 'coin_transfer') {
      return {
        title: `${actorName} sent you coins`,
        body: snippet ?? 'Open to view your coin activity.',
      };
    }
    if (kind === 'crew_invite_received') {
      return {
        title: `${actorName} invited you to their crew`,
        body: snippet ?? 'Open to see the invite.',
      };
    }
    if (kind === 'crew_invite_accepted') {
      return {
        title: `${actorName} accepted your crew invite`,
        body: snippet ?? 'Welcome them to the crew.',
      };
    }
    if (kind === 'crew_invite_declined') {
      return {
        title: `${actorName} declined your crew invite`,
        body: snippet ?? 'No worries — invite someone else.',
      };
    }
    if (kind === 'crew_member_joined') {
      return {
        title: `${actorName} joined your crew`,
        body: snippet ?? 'Say hello on the wall.',
      };
    }
    if (kind === 'crew_member_left') {
      return {
        title: `${actorName} left your crew`,
        body: snippet ?? 'Your crew roster changed.',
      };
    }
    if (kind === 'crew_member_kicked') {
      return {
        title: 'Crew roster changed',
        body: snippet ?? 'A member was removed from your crew.',
      };
    }
    if (kind === 'crew_owner_transferred') {
      return {
        title: 'Crew ownership transferred',
        body: snippet ?? 'Your crew has a new owner.',
      };
    }
    if (kind === 'crew_owner_transfer_vote') {
      return {
        title: `${actorName} started a vote in your crew`,
        body: snippet ?? 'Open to cast your vote.',
      };
    }
    if (kind === 'crew_wall_mention') {
      return {
        title: `${actorName} mentioned you on the wall`,
        body: snippet ?? 'Open the crew wall to reply.',
      };
    }
    if (kind === 'crew_disbanded') {
      return {
        title: 'Your crew was disbanded',
        body: snippet ?? 'Start a new crew when you\u2019re ready.',
      };
    }
    if (kind === 'crew_invite_cancelled') {
      return {
        title: 'Crew invite cancelled',
        body: snippet ?? 'The invite is no longer active.',
      };
    }
    if (kind === 'community_group_invite_received') {
      return {
        title: `${actorName} invited you to a group`,
        body: snippet ?? 'Open to see the invite.',
      };
    }
    if (kind === 'community_group_invite_accepted') {
      return {
        title: `${actorName} accepted your group invite`,
        body: snippet ?? 'Welcome them to the group.',
      };
    }
    if (kind === 'community_group_invite_declined') {
      return {
        title: `${actorName} declined your group invite`,
        body: snippet ?? 'No worries — invite someone else.',
      };
    }
    if (kind === 'community_group_invite_cancelled') {
      return {
        title: 'Group invite cancelled',
        body: snippet ?? 'The invite is no longer active.',
      };
    }
    if (kind === 'community_group_member_joined') {
      return {
        title: `${actorName} joined the group`,
        body: snippet ?? 'Open to see the new member.',
      };
    }
    if (kind === 'community_group_join_approved') {
      return {
        title: 'Your join request was approved',
        body: snippet ?? 'You\u2019re now a member.',
      };
    }
    if (kind === 'community_group_join_rejected') {
      return {
        title: 'Your join request was not accepted',
        body: snippet ?? 'You can request to join another group.',
      };
    }
    if (kind === 'community_group_member_removed') {
      return {
        title: 'You were removed from a group',
        body: snippet ?? 'Open to see your groups.',
      };
    }
    if (kind === 'community_group_disbanded') {
      return {
        title: 'A group you were in was disbanded',
        body: snippet ?? 'Open to find another group.',
      };
    }
    if (kind === 'message') {
      return {
        title: `${actorName} sent you a message`,
        body: snippet ?? 'Open to read it.',
      };
    }
    // Generic kind is used for one-off actor-driven events that don't have their own kind
    // (e.g. article emoji reactions). Prefix the DB title with the actor name when both
    // are present so the push reads like "Jane reacted to your article" with body=emoji.
    if (kind === 'generic' && titleFromFallback && actor) {
      return {
        title: `${actorName} ${titleFromFallback}`,
        ...(snippet ? { body: snippet } : { body: 'Open to view it.' }),
      };
    }
    return {
      title: titleFromFallback || 'New notification',
      ...(snippet ? { body: snippet } : { body: 'You have a new notification.' }),
    };
  }

  async getPreferences(userId: string): Promise<NotificationPreferencesDto> {
    const prefs = await this.getPreferencesInternal(userId);
    return {
      pushComment: Boolean(prefs.pushComment),
      pushBoost: Boolean(prefs.pushBoost),
      pushFollow: Boolean(prefs.pushFollow),
      pushMention: Boolean(prefs.pushMention),
      pushMessage: Boolean(prefs.pushMessage),
      pushRepost: Boolean(prefs.pushRepost),
      pushNudge: Boolean(prefs.pushNudge),
      pushFollowedPost: Boolean(prefs.pushFollowedPost),
      pushReplyNudge: Boolean(prefs.pushReplyNudge),
      pushCrewStreak: Boolean(prefs.pushCrewStreak),
      pushGroupActivity: Boolean(prefs.pushGroupActivity),
      emailDigestDaily: Boolean(prefs.emailDigestDaily),
      emailDigestWeekly: Boolean(prefs.emailDigestWeekly),
      emailNewNotifications: Boolean(prefs.emailNewNotifications),
      emailInstantHighSignal: Boolean(prefs.emailInstantHighSignal),
      emailFollowedArticle: Boolean(prefs.emailFollowedArticle),
    };
  }

  async updatePreferences(userId: string, patch: Partial<NotificationPreferencesDto>): Promise<NotificationPreferencesDto> {
    // Email prefs are only meaningful for verified emails. Keep the stored settings,
    // but prevent toggling them until the user verifies their email.
    const wantsEmailPatch =
      patch.emailDigestDaily !== undefined ||
      patch.emailDigestWeekly !== undefined ||
      patch.emailNewNotifications !== undefined ||
      patch.emailInstantHighSignal !== undefined ||
      patch.emailFollowedArticle !== undefined;

    let effectivePatch = patch;
    if (wantsEmailPatch) {
      const u = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { email: true, emailVerifiedAt: true },
      });
      const canUseEmail = Boolean((u?.email ?? '').trim()) && Boolean(u?.emailVerifiedAt);
      if (!canUseEmail) {
        effectivePatch = { ...patch };
        delete effectivePatch.emailDigestDaily;
        delete effectivePatch.emailDigestWeekly;
        delete effectivePatch.emailNewNotifications;
        delete effectivePatch.emailInstantHighSignal;
        delete effectivePatch.emailFollowedArticle;
      }
    }

    const updated = await this.prisma.notificationPreferences.upsert({
      where: { userId },
      create: { userId, ...(effectivePatch as any) },
      update: effectivePatch as any,
    });
    return {
      pushComment: Boolean(updated.pushComment),
      pushBoost: Boolean(updated.pushBoost),
      pushFollow: Boolean(updated.pushFollow),
      pushMention: Boolean(updated.pushMention),
      pushMessage: Boolean(updated.pushMessage),
      pushRepost: Boolean(updated.pushRepost),
      pushNudge: Boolean(updated.pushNudge),
      pushFollowedPost: Boolean(updated.pushFollowedPost),
      pushReplyNudge: Boolean(updated.pushReplyNudge),
      pushCrewStreak: Boolean(updated.pushCrewStreak),
      pushGroupActivity: Boolean(updated.pushGroupActivity),
      emailDigestDaily: Boolean(updated.emailDigestDaily),
      emailDigestWeekly: Boolean(updated.emailDigestWeekly),
      emailNewNotifications: Boolean(updated.emailNewNotifications),
      emailInstantHighSignal: Boolean(updated.emailInstantHighSignal),
      emailFollowedArticle: Boolean(updated.emailFollowedArticle),
    };
  }

  /** Upsert push subscription for a user (idempotent). */
  async pushSubscribe(
    userId: string,
    params: { endpoint: string; keys: { p256dh: string; auth: string }; userAgent?: string | null },
  ): Promise<void> {
    const { endpoint, keys, userAgent } = params;
    const endpointTrim = (endpoint ?? '').trim();
    const p256dh = (keys?.p256dh ?? '').trim();
    const auth = (keys?.auth ?? '').trim();
    if (!endpointTrim || !p256dh || !auth) return;

    // If another user previously registered this endpoint (e.g. user switched without a clean logout),
    // remove their stale binding so they stop receiving this device's push notifications.
    await this.prisma.pushSubscription.deleteMany({
      where: { endpoint: endpointTrim, NOT: { userId } },
    });

    await this.prisma.pushSubscription.upsert({
      where: {
        userId_endpoint: { userId, endpoint: endpointTrim },
      },
      create: {
        userId,
        endpoint: endpointTrim,
        p256dh,
        auth,
        userAgent: userAgent?.trim() || undefined,
      },
      update: {
        p256dh,
        auth,
        userAgent: userAgent?.trim() || undefined,
      },
    });
  }

  /** Remove push subscription by endpoint (current user only). */
  async pushUnsubscribe(userId: string, endpoint: string): Promise<void> {
    const endpointTrim = (endpoint ?? '').trim();
    if (!endpointTrim) return;

    await this.prisma.pushSubscription.deleteMany({
      where: { userId, endpoint: endpointTrim },
    });
  }

  /** Send a single test Web Push to the user (for "Send test notification" in settings). */
  async sendTestPush(userId: string): Promise<{ sent: boolean; message?: string }> {
    if (!this.appConfig.vapidConfigured()) {
      return { sent: false, message: 'Browser push (Web Push) is not configured (VAPID).' };
    }
    const subs = await this.prisma.pushSubscription.findMany({
      where: { userId },
      select: { id: true, endpoint: true, p256dh: true, auth: true },
    });
    if (subs.length === 0) {
      return { sent: false, message: 'No push subscription for this account. Enable browser notifications first.' };
    }
    await this.sendWebPushToRecipient(userId, {
      title: 'Test notification',
      body: 'If you see this, push is working.',
      subjectPostId: null,
      test: true,
    });
    return { sent: true };
  }

  /** Coalesce window (ms) for this kind. Returns false if within window (skip send). */
  private async isPushCoalesced(recipientUserId: string, kind: string): Promise<boolean> {
    const windowMs = PUSH_COALESCE_MS[kind] ?? DEFAULT_COALESCE_MS;
    const since = new Date(Date.now() - windowMs);
    const row = await this.prisma.pushCoalesce.findUnique({
      where: { userId_kind: { userId: recipientUserId, kind } },
      select: { sentAt: true },
    });
    return row ? row.sentAt >= since : false;
  }

  private async recordPushSent(recipientUserId: string, kind: string): Promise<void> {
    await this.prisma.pushCoalesce.upsert({
      where: { userId_kind: { userId: recipientUserId, kind } },
      create: { userId: recipientUserId, kind, sentAt: new Date() },
      update: { sentAt: new Date() },
    });
  }

  /** Send Web Push to all of a user's subscriptions; prune expired (410/404). */
  private async sendWebPushToRecipient(
    recipientUserId: string,
    params: {
      title: string;
      body?: string;
      notificationId?: string | null;
      subjectPostId?: string | null;
      subjectUserId?: string | null;
      test?: boolean;
      url?: string | null;
      tag?: string | null;
      icon?: string | null;
      badge?: string | null;
      renotify?: boolean;
      kind?: string;
      sourceLabel?: string;
    },
  ): Promise<void> {
    if (!this.appConfig.vapidConfigured()) return;
    const kind = params.kind ?? 'generic';
    if (!params.test && (await this.isPushCoalesced(recipientUserId, kind))) {
      this.logger.debug(`[push] Coalesced ${kind} for user ${recipientUserId}`);
      return;
    }
    if (!this.vapidConfigured) {
      const publicKey = this.appConfig.vapidPublicKey();
      const privateKey = this.appConfig.vapidPrivateKey();
      if (publicKey && privateKey) {
        webpush.setVapidDetails('mailto:support@menofhunger.com', publicKey, privateKey);
        this.vapidConfigured = true;
      } else return;
    }

    const baseUrl =
      this.appConfig.pushFrontendBaseUrl() ??
      this.appConfig.allowedOrigins()[0]?.trim() ??
      'https://menofhunger.com';
    const safeBase = baseUrl.replace(/\/$/, '');
    let url = params.url?.trim() || `${safeBase}/notifications`;
    if (!params.url && params.subjectPostId) {
      url = `${safeBase}/p/${params.subjectPostId}`;
    } else if (!params.url && params.subjectUserId) {
      const subjectUser = await this.prisma.user.findUnique({
        where: { id: params.subjectUserId },
        select: { username: true },
      });
      const username = (subjectUser?.username ?? '').trim();
      if (username) {
        url = `${safeBase}/u/${encodeURIComponent(username)}`;
      }
    }

    const defaultTag = params.test ? `notification-test-${Date.now()}` : `notification-${recipientUserId}`;
    const tag = params.tag?.trim() || defaultTag;
    // Distinguish "explicit empty body" (e.g. reply-nudge that's title-only) from "no body provided"
    // (legacy callers that want the friendly fallback).
    let body = params.body === undefined ? 'You have a new notification.' : params.body;
    if (params.sourceLabel) {
      body = body ? `${body} · ${params.sourceLabel}` : params.sourceLabel;
    }
    const payload = JSON.stringify({
      title: params.title,
      body,
      notificationId: params.notificationId ?? undefined,
      url,
      tag,
      kind,
      icon: params.icon ?? undefined,
      badge: params.badge ?? '/android-chrome-192x192.png',
      renotify: Boolean(params.renotify),
      test: params.test === true,
    });

    const subs = await this.prisma.pushSubscription.findMany({
      where: { userId: recipientUserId },
      select: { id: true, endpoint: true, p256dh: true, auth: true },
    });

    if (subs.length === 0) {
      this.logger.debug(`[push] No subscriptions for user ${recipientUserId}; skipping web push.`);
      return;
    }

    const expiredIds: string[] = [];
    for (const sub of subs) {
      try {
        await webpush.sendNotification(
          {
            endpoint: sub.endpoint,
            keys: { p256dh: sub.p256dh, auth: sub.auth },
          },
          payload,
          { TTL: 60 * 60 * 24 },
        );
      } catch (err: unknown) {
        const statusCode = (err as { statusCode?: number })?.statusCode;
        if (statusCode === 410 || statusCode === 404) {
          expiredIds.push(sub.id);
        }
      }
    }
    if (expiredIds.length > 0) {
      await this.prisma.pushSubscription.deleteMany({ where: { id: { in: expiredIds } } }).catch(() => {});
    }
    if (!params.test) {
      await this.recordPushSent(recipientUserId, kind).catch(() => {});
    }
  }

  /**
   * Send a single "still waiting on you" push for an unread reply notification.
   * The cron is responsible for selecting eligible notifications and stamping `nudgedBackAt`
   * so this method never re-fires for the same notification.
   *
   * Spare on purpose: title carries the actor's name, no body. The whole point is "John still cares."
   */
  async sendReplyNudgePush(params: {
    recipientUserId: string;
    actorUserId: string;
    notificationId: string;
    actorPostId: string | null;
    /** Optional snippet of the original reply, stored on Notification.body. */
    bodySnippet?: string | null;
  }): Promise<void> {
    if (!this.appConfig.vapidConfigured()) return;
    try {
      const prefs = await this.getPreferencesInternal(params.recipientUserId);
      if (!prefs.pushReplyNudge) return;
    } catch {
      // Best-effort: if prefs read fails, default to sending.
    }
    const actor = await this.prisma.user.findUnique({
      where: { id: params.actorUserId },
      select: {
        id: true,
        username: true,
        name: true,
        avatarKey: true,
        avatarUpdatedAt: true,
      },
    });
    if (!actor) return;
    const actorName = this.actorDisplayName(actor);
    const publicBaseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;
    const icon = publicAssetUrl({
      publicBaseUrl,
      key: actor.avatarKey,
      updatedAt: actor.avatarUpdatedAt,
    });
    const url = params.actorPostId ? `/p/${params.actorPostId}` : '/notifications';
    const snippet = this.trimPushBody(params.bodySnippet, 120);
    await this.sendWebPushToRecipient(params.recipientUserId, {
      title: `${actorName} is still waiting to hear back`,
      // Replay the original reply text if we have it; otherwise the title carries the whole signal.
      body: snippet ?? '',
      url,
      tag: `reply-nudge-${params.notificationId}`,
      icon,
      badge: '/android-chrome-192x192.png',
      renotify: false,
      kind: 'reply_nudge',
    });
  }

  /**
   * Send a streak-at-risk push notification to a single user.
   * Called by the nightly streak-reminder push cron (9 PM ET).
   * Only fires if the user has push subscriptions; silently skips if not.
   */
  async sendStreakReminderPush(params: {
    recipientUserId: string;
    streakDays: number;
    url: string;
  }): Promise<void> {
    if (!this.appConfig.vapidConfigured()) return;
    const { streakDays } = params;
    const title = `${streakDays}-day streak at risk`;
    const body = `Post today before midnight ET — or your streak resets.`;
    await this.sendWebPushToRecipient(params.recipientUserId, {
      title,
      body,
      url: params.url,
      tag: `streak-reminder-${params.recipientUserId}`,
      kind: 'streak_reminder',
    });
  }

  /**
   * Push every member of a crew when the strict crew streak advances. This is the
   * positive-feedback half of the crew-streak push pair. Per the design simplicity
   * skill we do not also send a "you posted today" confirmation — only the streak
   * milestone itself is a withdrawal worth making.
   */
  async sendCrewStreakAdvancedPush(params: {
    recipientUserIds: string[];
    crewId: string;
    crewSlug: string | null;
    crewName: string | null;
    currentStreakDays: number;
    memberCount: number;
  }): Promise<void> {
    if (!this.appConfig.vapidConfigured()) return;
    const { currentStreakDays, memberCount } = params;
    if (currentStreakDays <= 0 || params.recipientUserIds.length === 0) return;

    const url = params.crewSlug ? `/c/${encodeURIComponent(params.crewSlug)}` : '/crew';
    const crewLabel = (params.crewName ?? '').trim() || 'Your crew';
    const allClause = memberCount > 0 ? ` All ${memberCount} of you locked it in.` : '';
    const title = `${crewLabel}: ${currentStreakDays}-day streak`;
    const body = `${currentStreakDays === 1 ? 'Day 1 on the board.' : `Day ${currentStreakDays} in a row.`}${allClause}`;
    const tag = `crew-streak-advanced-${params.crewId}-${currentStreakDays}`;

    for (const recipientUserId of params.recipientUserIds) {
      try {
        const prefs = await this.getPreferencesInternal(recipientUserId);
        if (!prefs.pushCrewStreak) continue;
      } catch {
        // Best effort: if prefs read fails, default to sending.
      }
      try {
        await this.sendWebPushToRecipient(recipientUserId, {
          title,
          body,
          url,
          tag,
          renotify: false,
          kind: 'crew_streak_advanced',
          // System event — sourceLabel is allowed (and helpful) here.
          sourceLabel: 'Crew streak',
        });
      } catch (err) {
        this.logger.warn(`[push] Failed to send crew-streak-advanced push: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /**
   * Push every member of a crew the morning after a streak breaks. This is the
   * single most behaviorally potent push in the product — it names who didn't
   * check in, which converts to "I won't be the one who broke it next time."
   */
  async sendCrewStreakBrokenPush(params: {
    recipientUserIds: string[];
    crewId: string;
    crewSlug: string | null;
    crewName: string | null;
    missedMembers: Array<{ id: string; displayName: string | null; username: string | null }>;
  }): Promise<void> {
    if (!this.appConfig.vapidConfigured()) return;
    if (params.recipientUserIds.length === 0) return;

    const url = params.crewSlug ? `/c/${encodeURIComponent(params.crewSlug)}` : '/crew';
    const crewLabel = (params.crewName ?? '').trim() || 'Your crew';
    const title = 'You lost the streak.';
    const tag = `crew-streak-broken-${params.crewId}`;

    const missedNames = params.missedMembers
      .map((m) => (m.displayName ?? m.username ?? '').trim())
      .filter((n) => n.length > 0);

    for (const recipientUserId of params.recipientUserIds) {
      try {
        const prefs = await this.getPreferencesInternal(recipientUserId);
        if (!prefs.pushCrewStreak) continue;
      } catch {
        // Best effort: default to sending if prefs read fails.
      }

      // Personalize body so the recipient knows whether *they* missed.
      const recipientMissed = params.missedMembers.some((m) => m.id === recipientUserId);
      const others = missedNames
        .filter((_, idx) => params.missedMembers[idx]?.id !== recipientUserId);

      let body: string;
      if (recipientMissed && others.length === 0) {
        body = `${crewLabel} broke the streak yesterday. You didn't check in.`;
      } else if (recipientMissed && others.length > 0) {
        body = `${crewLabel} broke the streak yesterday. You and ${formatNameList(others)} didn't check in.`;
      } else if (others.length === 0) {
        body = `${crewLabel} broke the streak yesterday.`;
      } else if (others.length === 1) {
        body = `${others[0]} didn't check in yesterday. ${crewLabel} lost the streak.`;
      } else {
        body = `${formatNameList(others)} didn't check in yesterday. ${crewLabel} lost the streak.`;
      }

      try {
        await this.sendWebPushToRecipient(recipientUserId, {
          title,
          body,
          url,
          tag,
          renotify: false,
          kind: 'crew_streak_broken',
          sourceLabel: 'Crew streak',
        });
      } catch (err) {
        this.logger.warn(`[push] Failed to send crew-streak-broken push: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  async sendMessagePush(params: {
    recipientUserId: string;
    senderUserId: string;
    senderName: string;
    body?: string | null;
    conversationId: string;
  }): Promise<void> {
    try {
      const prefs = await this.getPreferencesInternal(params.recipientUserId);
      if (!prefs.pushMessage) return;
    } catch {
      // Best-effort: if prefs read fails, still attempt push (default behavior).
    }
    const sender = (params.senderName ?? '').trim();
    const title = sender ? `New message from ${sender}` : 'New message';
    const body = this.trimPushBody(params.body, 150) ?? 'Open chat to read the message.';
    const url = `/chat?c=${encodeURIComponent(params.conversationId)}`;
    const tag = `message-conversation-${params.conversationId}`;
    const senderUser = await this.prisma.user.findUnique({
      where: { id: params.senderUserId },
      select: { avatarKey: true, avatarUpdatedAt: true },
    });
    const publicBaseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;
    const icon = senderUser
      ? publicAssetUrl({
          publicBaseUrl,
          key: senderUser.avatarKey,
          updatedAt: senderUser.avatarUpdatedAt,
        })
      : null;
    try {
      await this.sendWebPushToRecipient(params.recipientUserId, {
        title,
        body,
        url,
        tag,
        icon,
        badge: '/android-chrome-192x192.png',
        renotify: true,
        kind: 'message',
        sourceLabel: 'From chat',
      });
    } catch (err) {
      this.logger.warn(`[push] Failed to send DM web push: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Find existing boost notification for (recipient, actor, subject post). */
  async findExistingBoostNotification(
    recipientUserId: string,
    actorUserId: string,
    subjectPostId: string,
  ) {
    return this.prisma.notification.findFirst({
      where: {
        recipientUserId,
        actorUserId,
        subjectPostId,
        kind: 'boost',
      },
      select: { id: true, deliveredAt: true, readAt: true },
    });
  }

  /**
   * Create or overwrite boost notification: if one exists, update createdAt and body only
   * (surfaces to top; does not change delivered/read). Otherwise create.
   */
  async upsertBoostNotification(params: {
    recipientUserId: string;
    actorUserId: string;
    subjectPostId: string;
    bodySnippet?: string | null;
  }) {
    const { recipientUserId, actorUserId, subjectPostId, bodySnippet } = params;
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const res = await this.prisma.$transaction(
          async (tx) => {
            const existing = await tx.notification.findFirst({
              where: {
                recipientUserId,
                actorUserId,
                subjectPostId,
                kind: 'boost',
              },
              select: { id: true, deliveredAt: true, readAt: true },
            });

            if (existing) {
              await tx.notification.update({
                where: { id: existing.id },
                data: { createdAt: new Date(), body: bodySnippet ?? undefined },
              });
              return { kind: 'updated' as const, notificationId: existing.id, undeliveredCount: null as number | null };
            }

            const notification = await tx.notification.create({
              data: {
                recipientUserId,
                kind: 'boost',
                actorUserId,
                subjectPostId,
                title: 'boosted your post',
                body: bodySnippet ?? undefined,
              },
              select: { id: true },
            });
            await tx.user.update({
              where: { id: recipientUserId },
              data: { undeliveredNotificationCount: { increment: 1 } },
            });
            const undeliveredCount = await tx.notification.count({
              where: { recipientUserId, deliveredAt: null },
            });
            return {
              kind: 'created' as const,
              notificationId: notification.id,
              undeliveredCount,
            };
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );

        if (res.kind === 'created' && typeof res.undeliveredCount === 'number') {
          this.presenceRealtime.emitNotificationsUpdated(recipientUserId, { undeliveredCount: res.undeliveredCount });
        }

        // Treat as a new notification row for UI ordering (without changing delivered/read).
        try {
          const dto = await this.buildNotificationDtoForRecipient({
            recipientUserId,
            notificationId: res.notificationId,
          });
          if (dto) {
            this.presenceRealtime.emitNotificationNew(recipientUserId, { notification: dto });
          }
        } catch {
          // Best-effort
        }

        // Web push is optional (VAPID + user preference). (Boosts are high-signal.)
        if (res.kind === 'created') {
          try {
            const prefs = await this.getPreferencesInternal(recipientUserId);
            if (this.shouldSendPushForKind(prefs, 'boost')) {
              const actor = await this.prisma.user.findUnique({
                where: { id: actorUserId },
                select: {
                  id: true,
                  username: true,
                  name: true,
                  avatarKey: true,
                  avatarUpdatedAt: true,
                },
              });
              const pushCopy = this.buildPushCopy({
                kind: 'boost',
                actor,
                fallbackTitle: 'boosted your post',
                body: bodySnippet ?? null,
              });
              const publicBaseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;
              const icon = actor
                ? publicAssetUrl({
                    publicBaseUrl,
                    key: actor.avatarKey,
                    updatedAt: actor.avatarUpdatedAt,
                  })
                : null;
              this.sendWebPushToRecipient(recipientUserId, {
                title: pushCopy.title,
                body: pushCopy.body,
                subjectPostId: subjectPostId ?? null,
                subjectUserId: null,
                tag: this.buildPushTag({
                  recipientUserId,
                  kind: 'boost',
                  actorUserId,
                  subjectPostId,
                  subjectUserId: null,
                }),
                icon,
                badge: '/android-chrome-192x192.png',
                renotify: true,
                kind: 'boost',
              }).catch((err) => {
                this.logger.warn(`[push] Failed to send web push: ${err instanceof Error ? err.message : String(err)}`);
              });
            }
          } catch (err) {
            this.logger.debug(`[push] Failed to evaluate push preferences: ${err}`);
          }
        }

        return;
      } catch (err: unknown) {
        const code = (err as any)?.code as string | undefined;
        const isRetryable = code === 'P2034' || /could not serialize access/i.test(String((err as any)?.message ?? err));
        if (attempt < maxAttempts && isRetryable) continue;
        throw err;
      }
    }
  }

  /** Remove boost notification when user unboosts; emit updated count if the removed one was undelivered. */
  async deleteBoostNotification(
    recipientUserId: string,
    actorUserId: string,
    subjectPostId: string,
  ): Promise<void> {
    const existing = await this.findExistingBoostNotification(recipientUserId, actorUserId, subjectPostId);
    if (!existing) return;
    const wasUndelivered = existing.deliveredAt == null;
    const undeliveredCount = await this.prisma.$transaction(async (tx) => {
      await tx.notification.delete({ where: { id: existing.id } });
      if (!wasUndelivered) {
        const row = await tx.user.findUnique({
          where: { id: recipientUserId },
          select: { undeliveredNotificationCount: true },
        });
        return row?.undeliveredNotificationCount ?? 0;
      }
      const user = await tx.user.update({
        where: { id: recipientUserId },
        data: { undeliveredNotificationCount: { decrement: 1 } },
        select: { undeliveredNotificationCount: true },
      });
      return user.undeliveredNotificationCount;
    });
    this.presenceRealtime.emitNotificationsDeleted(recipientUserId, { notificationIds: [existing.id] });
    if (wasUndelivered) this.presenceRealtime.emitNotificationsUpdated(recipientUserId, { undeliveredCount });
  }

  /**
   * Create or overwrite repost notification for the original post author.
   * Grouped per (recipient, subject post): if a notification already exists
   * for this actor+post, update its timestamp to bubble it up without double-counting.
   */
  async upsertRepostNotification(params: {
    recipientUserId: string;
    actorUserId: string;
    subjectPostId: string;
    /** The repost/quote post itself — lets the recipient tap through to it. */
    actorPostId?: string;
    /** Defaults to 'reposted your post'. Pass 'quoted your post' for quote reposts. */
    title?: string;
  }) {
    const { recipientUserId, actorUserId, subjectPostId, actorPostId, title = 'reposted your post' } = params;
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const res = await this.prisma.$transaction(
          async (tx) => {
            const existing = await tx.notification.findFirst({
              where: { recipientUserId, actorUserId, subjectPostId, kind: 'repost' },
              select: { id: true, deliveredAt: true },
            });

            if (existing) {
              await tx.notification.update({
                where: { id: existing.id },
                data: { createdAt: new Date(), title, ...(actorPostId ? { actorPostId } : {}) },
              });
              return { kind: 'updated' as const, notificationId: existing.id, undeliveredCount: null as number | null };
            }

            const notification = await tx.notification.create({
              data: {
                recipientUserId,
                kind: 'repost',
                actorUserId,
                subjectPostId,
                ...(actorPostId ? { actorPostId } : {}),
                title,
              },
              select: { id: true },
            });
            await tx.user.update({
              where: { id: recipientUserId },
              data: { undeliveredNotificationCount: { increment: 1 } },
            });
            const undeliveredCount = await tx.notification.count({
              where: { recipientUserId, deliveredAt: null },
            });
            return { kind: 'created' as const, notificationId: notification.id, undeliveredCount };
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );

        if (res.kind === 'created' && typeof res.undeliveredCount === 'number') {
          this.presenceRealtime.emitNotificationsUpdated(recipientUserId, { undeliveredCount: res.undeliveredCount });
        }

        try {
          const dto = await this.buildNotificationDtoForRecipient({ recipientUserId, notificationId: res.notificationId });
          if (dto) this.presenceRealtime.emitNotificationNew(recipientUserId, { notification: dto });
        } catch { /* best-effort */ }

        // Web push for newly-created reposts (gated by pushRepost pref).
        // Updates (re-reposts of the same post) skip push to avoid re-notifying.
        if (res.kind === 'created') {
          try {
            const prefs = await this.getPreferencesInternal(recipientUserId);
            if (this.shouldSendPushForKind(prefs, 'repost')) {
              const actor = await this.prisma.user.findUnique({
                where: { id: actorUserId },
                select: {
                  id: true,
                  username: true,
                  name: true,
                  avatarKey: true,
                  avatarUpdatedAt: true,
                },
              });
              const pushCopy = this.buildPushCopy({
                kind: 'repost',
                actor,
                fallbackTitle: title,
                body: null,
              });
              const publicBaseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;
              const icon = actor
                ? publicAssetUrl({
                    publicBaseUrl,
                    key: actor.avatarKey,
                    updatedAt: actor.avatarUpdatedAt,
                  })
                : null;
              this.sendWebPushToRecipient(recipientUserId, {
                title: pushCopy.title,
                body: pushCopy.body,
                subjectPostId: subjectPostId ?? null,
                subjectUserId: null,
                url: actorPostId ? `/p/${actorPostId}` : `/p/${subjectPostId}`,
                tag: this.buildPushTag({
                  recipientUserId,
                  kind: 'repost',
                  actorUserId,
                  subjectPostId,
                  subjectUserId: null,
                }),
                icon,
                badge: '/android-chrome-192x192.png',
                renotify: true,
                kind: 'repost',
              }).catch((err) => {
                this.logger.warn(`[push] Failed to send repost web push: ${err instanceof Error ? err.message : String(err)}`);
              });
            }
          } catch (err) {
            this.logger.debug(`[push] Failed to evaluate repost push prefs: ${err}`);
          }
        }

        return;
      } catch (err: unknown) {
        const code = (err as any)?.code as string | undefined;
        const isRetryable = code === 'P2034' || /could not serialize access/i.test(String((err as any)?.message ?? err));
        if (attempt < maxAttempts && isRetryable) continue;
        throw err;
      }
    }
  }

  /** Remove repost notification when user un-reposts. */
  async deleteRepostNotification(
    recipientUserId: string,
    actorUserId: string,
    subjectPostId: string,
  ): Promise<void> {
    const existing = await this.prisma.notification.findFirst({
      where: { recipientUserId, actorUserId, subjectPostId, kind: 'repost' },
      select: { id: true, deliveredAt: true },
    });
    if (!existing) return;
    const wasUndelivered = existing.deliveredAt == null;
    const undeliveredCount = await this.prisma.$transaction(async (tx) => {
      await tx.notification.delete({ where: { id: existing.id } });
      if (!wasUndelivered) {
        const row = await tx.user.findUnique({ where: { id: recipientUserId }, select: { undeliveredNotificationCount: true } });
        return row?.undeliveredNotificationCount ?? 0;
      }
      const user = await tx.user.update({
        where: { id: recipientUserId },
        data: { undeliveredNotificationCount: { decrement: 1 } },
        select: { undeliveredNotificationCount: true },
      });
      return user.undeliveredNotificationCount;
    });
    this.presenceRealtime.emitNotificationsDeleted(recipientUserId, { notificationIds: [existing.id] });
    if (wasUndelivered) this.presenceRealtime.emitNotificationsUpdated(recipientUserId, { undeliveredCount });
  }

  private async deleteNotificationRowsAndEmit(
    rows: Array<{ id: string; recipientUserId: string; deliveredAt: Date | null }>,
  ): Promise<number> {
    const ids = rows.map((r) => r.id).filter(Boolean);
    if (ids.length === 0) return 0;

    const undeliveredDeletedByRecipient = new Map<string, number>();
    for (const r of rows) {
      const uid = (r.recipientUserId ?? '').trim();
      if (!uid) continue;
      if (r.deliveredAt != null) continue;
      undeliveredDeletedByRecipient.set(uid, (undeliveredDeletedByRecipient.get(uid) ?? 0) + 1);
    }

    const updatedCountByRecipient = await this.prisma.$transaction(async (tx) => {
      await tx.notification.deleteMany({ where: { id: { in: ids } } });

      const updates = new Map<string, number>();
      for (const [uid, delta] of undeliveredDeletedByRecipient) {
        if (delta <= 0) continue;
        const user = await tx.user.update({
          where: { id: uid },
          data: { undeliveredNotificationCount: { decrement: delta } },
          select: { undeliveredNotificationCount: true },
        });
        updates.set(uid, user.undeliveredNotificationCount);
      }
      return updates;
    });

    const idsByRecipient = new Map<string, string[]>();
    for (const r of rows) {
      const uid = (r.recipientUserId ?? '').trim();
      if (!uid) continue;
      const list = idsByRecipient.get(uid) ?? [];
      list.push(r.id);
      idsByRecipient.set(uid, list);
    }

    for (const [uid, notifIds] of idsByRecipient) {
      this.presenceRealtime.emitNotificationsDeleted(uid, { notificationIds: notifIds });
    }

    for (const [uid, undeliveredCount] of updatedCountByRecipient) {
      this.presenceRealtime.emitNotificationsUpdated(uid, { undeliveredCount });
    }

    // Bulk deletes can drop comment notifications (e.g. when the parent post is removed).
    // Recompute the waiting-on-you dot for each affected recipient.
    for (const uid of idsByRecipient.keys()) {
      void this.emitWaitingCountForUser(uid);
    }

    return ids.length;
  }

  /** Delete all notifications that reference this post as the subject (post is gone). */
  async deleteBySubjectPostId(subjectPostId: string): Promise<number> {
    const id = (subjectPostId ?? '').trim();
    if (!id) return 0;
    const rows = await this.prisma.notification.findMany({
      where: { subjectPostId: id },
      select: { id: true, recipientUserId: true, deliveredAt: true },
    });
    return await this.deleteNotificationRowsAndEmit(rows);
  }

  /** Delete all notifications caused by this post (e.g. replies or mentions) using actorPostId. */
  async deleteByActorPostId(actorPostId: string): Promise<number> {
    const id = (actorPostId ?? '').trim();
    if (!id) return 0;
    const rows = await this.prisma.notification.findMany({
      where: { actorPostId: id },
      select: { id: true, recipientUserId: true, deliveredAt: true },
    });
    return await this.deleteNotificationRowsAndEmit(rows);
  }

  /**
   * Tidy up stale "X joined your crew" / "X accepted your crew invite" notifications
   * when X leaves (or is kicked from) the crew. The fact that X joined is no longer
   * meaningful — recipients will get a fresh `crew_member_left` / `crew_member_kicked`
   * notification instead. Idempotent.
   */
  async deleteCrewJoinedNotificationsForActor(params: {
    crewId: string;
    actorUserId: string;
  }): Promise<number> {
    const crewId = (params.crewId ?? '').trim();
    const actorUserId = (params.actorUserId ?? '').trim();
    if (!crewId || !actorUserId) return 0;
    const rows = await this.prisma.notification.findMany({
      where: {
        subjectCrewId: crewId,
        actorUserId,
        kind: { in: ['crew_member_joined', 'crew_invite_accepted'] },
      },
      select: { id: true, recipientUserId: true, deliveredAt: true },
    });
    return await this.deleteNotificationRowsAndEmit(rows);
  }

  /** Delete follow notifications for a relationship (used on unfollow). */
  async deleteFollowNotification(recipientUserId: string, actorUserId: string): Promise<number> {
    const recipient = (recipientUserId ?? '').trim();
    const actor = (actorUserId ?? '').trim();
    if (!recipient || !actor) return 0;
    const rows = await this.prisma.notification.findMany({
      where: { recipientUserId: recipient, actorUserId: actor, kind: 'follow' },
      select: { id: true, recipientUserId: true, deliveredAt: true },
    });
    return await this.deleteNotificationRowsAndEmit(rows);
  }

  async list(params: {
    recipientUserId: string;
    limit: number;
    cursor: string | null;
    kind?: NotificationKind;
  }) {
    const { recipientUserId, limit, cursor, kind } = params;
    const desiredItemLimit = Math.max(1, Math.min(limit, 50));
    const maxGroupNotifications = 50;
    const rawFetchLimit = Math.min(desiredItemLimit * 6, 250);
    if (kind === 'message') {
      const [undeliveredCount, unreadByKind] = await Promise.all([
        this.getUndeliveredCount(recipientUserId),
        this.getUnreadCountsByKind(recipientUserId),
      ]);
      return {
        items: [] as NotificationFeedItemDto[],
        nextCursor: null,
        undeliveredCount,
        unreadByKind,
      };
    }

    const cursorWhere = await createdAtIdCursorWhere({
      cursor,
      lookup: async (id) =>
        this.prisma.notification
          .findUnique({
            where: { id, recipientUserId },
            select: { id: true, createdAt: true },
          })
          .then((r) => (r ? { id: r.id, createdAt: r.createdAt } : null)),
    });

    // Exclude notifications from blocked users (either direction).
    const blockRows = await this.prisma.userBlock.findMany({
      where: { OR: [{ blockerId: recipientUserId }, { blockedId: recipientUserId }] },
      select: { blockerId: true, blockedId: true },
    });
    const blockedActorIds = blockRows.map((r) =>
      r.blockerId === recipientUserId ? r.blockedId : r.blockerId,
    );

    const notifications = await this.prisma.notification.findMany({
      where: {
        recipientUserId,
        ...(kind ? { kind } : { kind: { not: 'message' as const } }),
        ...(blockedActorIds.length > 0 ? { NOT: { actorUserId: { in: blockedActorIds } } } : {}),
        ...(cursorWhere ? { AND: [cursorWhere] } : {}),
      },
      include: {
        actor: {
          select: {
            id: true,
            username: true,
            name: true,
            avatarKey: true,
            avatarUpdatedAt: true,
            premium: true,
            isOrganization: true,
            verifiedStatus: true,
            bannedAt: true,
          },
        },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: rawFetchLimit + 1,
    });

    const raw = notifications.slice(0, rawFetchLimit);
    const hasMoreRaw = notifications.length > rawFetchLimit;
    const [undeliveredCount, unreadByKind] = await Promise.all([
      this.getUndeliveredCount(recipientUserId),
      this.getUnreadCountsByKind(recipientUserId),
    ]);

    const publicBaseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;
    const previewPostIds = [
      ...new Set(
        raw
          .flatMap((n) => (
            n.kind === 'repost' && n.actorPostId
              ? [n.actorPostId, n.subjectPostId]
              : [n.subjectPostId]
          ))
          .filter(Boolean),
      ),
    ] as string[];
    const subjectPosts =
      previewPostIds.length > 0
        ? await this.prisma.post.findMany({
            where: { id: { in: previewPostIds } },
            select: {
              id: true,
              body: true,
              visibility: true,
              media: { where: { deletedAt: null }, orderBy: { position: 'asc' }, select: { kind: true, r2Key: true, thumbnailR2Key: true, url: true } },
            },
          })
        : [];
    const subjectPreviewByPostId = new Map<string, SubjectPostPreviewDto>();
    const subjectTierByPostId = new Map<string, SubjectTier>();
    const subjectVisibilityByPostId = new Map<string, SubjectPostVisibility>();
    for (const p of subjectPosts) {
      const bodySnippet = (p.body ?? '').trim().slice(0, 150) || null;
      const media = (p.media ?? [])
        .map((m) => {
          const url =
            (m as { url?: string }).url?.trim() ||
            (publicAssetUrl({ publicBaseUrl, key: (m as { r2Key?: string }).r2Key ?? null }) ?? '');
          const thumbnailUrl =
            (publicAssetUrl({
              publicBaseUrl,
              key: (m as { thumbnailR2Key?: string }).thumbnailR2Key ?? null,
            }) ?? null) || null;
          return { url: url || '', thumbnailUrl, kind: (m as { kind: string }).kind };
        })
        .filter((m) => m.url);
      subjectPreviewByPostId.set(p.id, { bodySnippet, media });
      const vis = (p as { visibility?: string }).visibility;
      subjectTierByPostId.set(p.id, vis === 'premiumOnly' ? 'premium' : vis === 'verifiedOnly' ? 'verified' : null);
      if (vis === 'public' || vis === 'verifiedOnly' || vis === 'premiumOnly' || vis === 'onlyMe') {
        subjectVisibilityByPostId.set(p.id, vis);
      }
    }

    const subjectUserIds = [...new Set(raw.map((n) => n.subjectUserId).filter(Boolean))] as string[];
    const subjectUsers =
      subjectUserIds.length > 0
        ? await this.prisma.user.findMany({
            where: { id: { in: subjectUserIds } },
            select: { id: true, premium: true, verifiedStatus: true },
          })
        : [];
    const subjectTierByUserId = new Map<string, SubjectTier>();
    for (const u of subjectUsers) {
      const tier: SubjectTier = u.premium ? 'premium' : u.verifiedStatus !== 'none' ? 'verified' : null;
      subjectTierByUserId.set(u.id, tier);
    }

    const subjectArticleIds = [
      ...new Set(
        raw
          .filter((n) => n.kind === 'followed_article' && n.subjectArticleId)
          .map((n) => n.subjectArticleId as string),
      ),
    ];
    const subjectArticles =
      subjectArticleIds.length > 0
        ? await this.prisma.article.findMany({
            where: { id: { in: subjectArticleIds } },
            select: { id: true, title: true, excerpt: true, thumbnailR2Key: true, visibility: true },
          })
        : [];
    const subjectArticlePreviewById = new Map<string, SubjectArticlePreviewDto>();
    for (const a of subjectArticles) {
      const thumbnailUrl = a.thumbnailR2Key
        ? (publicAssetUrl({ publicBaseUrl, key: a.thumbnailR2Key }) ?? null)
        : null;
      subjectArticlePreviewById.set(a.id, {
        title: a.title ?? null,
        excerpt: a.excerpt ?? null,
        thumbnailUrl,
        visibility: a.visibility ?? null,
      });
    }

    // Batch-lookup groups for any notification that carries a subjectGroupId
    // (group_join_request and community_group_invite_* both use it for routing).
    const subjectGroupIds = [
      ...new Set(
        raw
          .filter((n) => Boolean(n.subjectGroupId))
          .map((n) => n.subjectGroupId as string),
      ),
    ];
    const subjectGroups =
      subjectGroupIds.length > 0
        ? await this.prisma.communityGroup.findMany({
            where: { id: { in: subjectGroupIds } },
            select: { id: true, slug: true, name: true },
          })
        : [];
    const subjectGroupById = new Map(subjectGroups.map((g) => [g.id, g] as const));

    // Batch-lookup invite statuses for crew_invite_* notifications so the row can
    // render the correct terminal state on first load (no extra FE round-trip).
    // We grab the linked crew name (or the founding `crewNameOnAccept`) at the
    // same time so the row can say "invited you to The Iron Brotherhood".
    const subjectCrewInviteIds = [
      ...new Set(raw.map((n) => n.subjectCrewInviteId).filter(Boolean) as string[]),
    ];
    const subjectCrewInvites =
      subjectCrewInviteIds.length > 0
        ? await this.prisma.crewInvite.findMany({
            where: { id: { in: subjectCrewInviteIds } },
            select: {
              id: true,
              status: true,
              crewNameOnAccept: true,
              crew: { select: { name: true } },
            },
          })
        : [];
    const subjectCrewInviteStatusById = new Map(
      subjectCrewInvites.map((inv) => [inv.id, inv.status] as const),
    );
    const subjectCrewNameByInviteId = new Map(
      subjectCrewInvites.map(
        (inv) =>
          [inv.id, ((inv.crew?.name ?? inv.crewNameOnAccept ?? '') as string).trim() || null] as const,
      ),
    );

    // For non-invite crew notifications (member joined/left, owner transferred,
    // wall mention, etc.) the crew name lives on the Crew row directly.
    const subjectCrewIds = [
      ...new Set(
        raw
          .filter((n) => n.subjectCrewId && !n.subjectCrewInviteId)
          .map((n) => n.subjectCrewId as string),
      ),
    ];
    const subjectCrews =
      subjectCrewIds.length > 0
        ? await this.prisma.crew.findMany({
            where: { id: { in: subjectCrewIds } },
            select: { id: true, name: true },
          })
        : [];
    const subjectCrewNameByCrewId = new Map(
      subjectCrews.map((c) => [c.id, (c.name ?? '').trim() || null] as const),
    );

    // Same idea for community group invites: hydrate status so the row can
    // render Joined / Declined / No longer available without a refetch.
    const subjectCommunityGroupInviteIds = [
      ...new Set(raw.map((n) => n.subjectCommunityGroupInviteId).filter(Boolean) as string[]),
    ];
    const subjectCommunityGroupInvites =
      subjectCommunityGroupInviteIds.length > 0
        ? await this.prisma.communityGroupInvite.findMany({
            where: { id: { in: subjectCommunityGroupInviteIds } },
            select: { id: true, status: true },
          })
        : [];
    const subjectCommunityGroupInviteStatusById = new Map(
      subjectCommunityGroupInvites.map((inv) => [inv.id, inv.status] as const),
    );

    const dtos: NotificationDto[] = raw.map((n) => {
      const actorPreview = n.kind === 'repost' && n.actorPostId ? subjectPreviewByPostId.get(n.actorPostId) ?? null : null;
      const hasActorPreview = Boolean(actorPreview?.bodySnippet || actorPreview?.media?.length);
      const previewPostId = hasActorPreview ? n.actorPostId : n.subjectPostId;
      const preview = previewPostId ? subjectPreviewByPostId.get(previewPostId) ?? null : null;
      const articlePreview = n.subjectArticleId ? subjectArticlePreviewById.get(n.subjectArticleId) ?? null : null;
      const subjectPostVisibility = previewPostId ? subjectVisibilityByPostId.get(previewPostId) ?? null : null;
      let subjectTier: SubjectTier = null;
      if (previewPostId) subjectTier = subjectTierByPostId.get(previewPostId) ?? null;
      else if (n.subjectUserId) subjectTier = subjectTierByUserId.get(n.subjectUserId) ?? null;
      const subjectGroup = n.subjectGroupId ? subjectGroupById.get(n.subjectGroupId) ?? null : null;
      const subjectCrewInviteStatus = n.subjectCrewInviteId
        ? subjectCrewInviteStatusById.get(n.subjectCrewInviteId) ?? null
        : null;
      // Prefer the live crew name; fall back to the founding invite's
      // `crewNameOnAccept` so even pre-accept invites show the chosen name.
      const subjectCrewName = n.subjectCrewId
        ? subjectCrewNameByCrewId.get(n.subjectCrewId) ?? null
        : n.subjectCrewInviteId
          ? subjectCrewNameByInviteId.get(n.subjectCrewInviteId) ?? null
          : null;
      const subjectCommunityGroupInviteStatus = n.subjectCommunityGroupInviteId
        ? subjectCommunityGroupInviteStatusById.get(n.subjectCommunityGroupInviteId) ?? null
        : null;
      return this.toNotificationDto(
        n,
        publicBaseUrl,
        preview,
        subjectPostVisibility,
        subjectTier,
        articlePreview,
        subjectGroup?.slug ?? null,
        subjectGroup?.name ?? null,
        subjectCrewInviteStatus,
        subjectCrewName,
        subjectCommunityGroupInviteStatus,
      );
    });

    // Follow bell settings: which followed_post actors have “every post” enabled.
    const followedPostActorUserIds = [
      ...new Set(raw.filter((n) => n.kind === 'followed_post' && n.actorUserId).map((n) => n.actorUserId as string)),
    ];
    const bellEnabledActorIds = new Set<string>();
    if (followedPostActorUserIds.length > 0) {
      const rows = await this.prisma.follow.findMany({
        where: {
          followerId: recipientUserId,
          followingId: { in: followedPostActorUserIds },
          postNotificationsEnabled: true,
        },
        select: { followingId: true },
      });
      for (const r of rows) bellEnabledActorIds.add(r.followingId);
    }

    function isBellEnabledFollowedPost(n: NotificationDto): boolean {
      if (n.kind !== 'followed_post') return false;
      const actorId = n.actor?.id ?? null;
      if (!actorId) return false;
      return bellEnabledActorIds.has(actorId);
    }

    function groupKey(n: NotificationDto): string | null {
      if (n.kind === 'boost' && n.subjectPostId) return `boost:post:${n.subjectPostId}`;
      if (n.kind === 'comment' && n.subjectPostId) return `comment:post:${n.subjectPostId}`;
      if (n.kind === 'community_group_member_joined' && n.subjectGroupId) return `community_group_member_joined:group:${n.subjectGroupId}`;
      if (n.kind === 'crew_member_joined' && n.subjectCrewId) return `crew_member_joined:crew:${n.subjectCrewId}`;
      if (n.kind === 'crew_member_left' && n.subjectCrewId) return `crew_member_left:crew:${n.subjectCrewId}`;
      if (n.kind === 'follow') return 'follow';
      if (n.kind === 'followed_post' && n.actor?.id) return `followed_post:actor:${n.actor.id}`;
      if (n.kind === 'nudge' && n.actor?.id) return `nudge:actor:${n.actor.id}`;
      return null;
    }

    function groupKindFromKey(key: string): NotificationGroupKind | null {
      if (key.startsWith('boost:')) return 'boost';
      if (key.startsWith('repost:')) return 'repost';
      if (key.startsWith('comment:')) return 'comment';
      if (key === 'follow') return 'follow';
      if (key.startsWith('followed_post:')) return 'followed_post';
      if (key.startsWith('nudge:')) return 'nudge';
      return null;
    }

    function buildGroup(members: NotificationDto[], key: string): NotificationGroupDto {
      const newest = members[0]!;
      const kind = groupKindFromKey(key) ?? (newest.kind as NotificationGroupKind);
      const anyUndelivered = members.some((m) => m.deliveredAt == null);
      const anyUnread = members.some((m) => m.readAt == null);

      const actors: NotificationActorDto[] = [];
      const actorIds = new Set<string>();
      for (const m of members) {
        const a = m.actor;
        if (!a?.id) continue;
        if (actorIds.has(a.id)) continue;
        actorIds.add(a.id);
        actors.push(a);
      }

      const latestBody =
        kind === 'comment' ? (members.find((m) => (m.body ?? '').trim())?.body ?? null) : null;

      const subjectPostId = (kind === 'boost' || kind === 'repost' || kind === 'comment') ? (newest.subjectPostId ?? null) : null;
      const subjectUserId =
        kind === 'follow'
          ? (newest.actor?.id ?? newest.subjectUserId ?? null)
          : kind === 'nudge'
            ? (newest.actor?.id ?? newest.subjectUserId ?? null)
          : kind === 'followed_post'
            ? (newest.actor?.id ?? null)
            : null;

      return {
        id: newest.id,
        kind,
        createdAt: newest.createdAt,
        deliveredAt: anyUndelivered ? null : newest.deliveredAt,
        readAt: anyUnread ? null : newest.readAt,
        subjectPostId,
        subjectUserId,
        actors,
        actorCount: actors.length,
        count: members.length,
        latestBody,
        latestSubjectPostPreview: newest.subjectPostPreview ?? null,
        subjectPostVisibility: newest.subjectPostVisibility ?? null,
        subjectTier: newest.subjectTier ?? null,
      };
    }

    // When filtering by a specific kind, skip all grouping and return individual items.
    // The user opted in to see this kind explicitly — collapsing defeats the purpose.
    if (kind) {
      const page = dtos.slice(0, desiredItemLimit);
      const lastItem = page.at(-1);
      const hasMore = dtos.length > desiredItemLimit || hasMoreRaw;
      return {
        items: page.map((n) => ({ type: 'single' as const, notification: n })),
        nextCursor: hasMore ? (lastItem?.id ?? null) : null,
        undeliveredCount,
        unreadByKind,
      };
    }

    const items: NotificationFeedItemDto[] = [];
    let rollupInsertIndex: number | null = null;
    let rollupNewest: NotificationDto | null = null;
    let rollupCount = 0;
    let rollupAnyUndelivered = false;
    let rollupAnyUnread = false;
    const rollupActors: NotificationActorDto[] = [];
    const rollupActorIds = new Set<string>();

    function ingestRollup(n: NotificationDto) {
      if (!rollupNewest) rollupNewest = n;
      rollupCount += 1;
      if (n.deliveredAt == null) rollupAnyUndelivered = true;
      if (n.readAt == null) rollupAnyUnread = true;
      const a = n.actor;
      if (a?.id && !rollupActorIds.has(a.id)) {
        rollupActorIds.add(a.id);
        rollupActors.push(a);
      }
    }

    let i = 0;
    while (
      i < dtos.length &&
      items.length + (rollupInsertIndex !== null ? 1 : 0) < desiredItemLimit
    ) {
      const n = dtos[i]!;

      // Collapse followed_post notifications when bell is not enabled.
      if (n.kind === 'followed_post' && !isBellEnabledFollowedPost(n)) {
        if (rollupInsertIndex === null) rollupInsertIndex = items.length;
        ingestRollup(n);
        i += 1;
        continue;
      }
      // Bell-enabled followed_post notifications should always be standalone.
      // This guarantees "every post" delivery semantics in the feed UI.
      if (n.kind === 'followed_post' && isBellEnabledFollowedPost(n)) {
        items.push({ type: 'single', notification: n });
        i += 1;
        continue;
      }

      const key = groupKey(n);
      if (!key) {
        items.push({ type: 'single', notification: n });
        i += 1;
        continue;
      }

      const members: NotificationDto[] = [n];
      let j = i + 1;
      while (j < dtos.length && groupKey(dtos[j]!) === key && members.length < maxGroupNotifications) {
        members.push(dtos[j]!);
        j += 1;
      }

      if (members.length === 1) {
        items.push({ type: 'single', notification: n });
        i += 1;
        continue;
      }

      items.push({ type: 'group', group: buildGroup(members, key) });
      i = j;
    }

    if (rollupInsertIndex !== null && rollupNewest && rollupCount > 0) {
      const newest = rollupNewest as NotificationDto;
      const rollup: FollowedPostsRollupDto = {
        id: newest.id,
        createdAt: newest.createdAt,
        deliveredAt: rollupAnyUndelivered ? null : newest.deliveredAt,
        readAt: rollupAnyUnread ? null : newest.readAt,
        actors: rollupActors,
        actorCount: rollupActors.length,
        count: rollupCount,
      };
      items.splice(rollupInsertIndex, 0, { type: 'followed_posts_rollup', rollup });
    }

    const lastConsumedId = i > 0 ? dtos[i - 1]?.id ?? null : null;
    const hasMore = i < dtos.length || hasMoreRaw;
    const nextCursor = hasMore ? lastConsumedId : null;

    return {
      items,
      nextCursor,
      undeliveredCount,
      unreadByKind,
    };
  }

  async listNewPostsFeed(params: {
    recipientUserId: string;
    limit: number;
    cursor: string | null;
    collapseByRoot?: boolean;
    collapseMode?: FeedCollapseMode;
    prefer?: FeedCollapsePrefer;
  }) {
    const { recipientUserId, limit, cursor } = params;
    const desiredPostLimit = Math.max(1, Math.min(limit, 50));
    const rawFetchLimit = Math.min(desiredPostLimit * 8, 300);

    const cursorWhere = await createdAtIdCursorWhere({
      cursor,
      lookup: async (id) =>
        this.prisma.notification
          .findUnique({
            where: { id, recipientUserId },
            select: { id: true, createdAt: true },
          })
          .then((r) => (r ? { id: r.id, createdAt: r.createdAt } : null)),
    });

    // Keep notification and feed behavior consistent: hide items from blocked users.
    const blockRows = await this.prisma.userBlock.findMany({
      where: { OR: [{ blockerId: recipientUserId }, { blockedId: recipientUserId }] },
      select: { blockerId: true, blockedId: true },
    });
    const blockedActorIds = blockRows.map((r) =>
      r.blockerId === recipientUserId ? r.blockedId : r.blockerId,
    );

    // New-posts should include followed users' reply events even when they were
    // emitted as comment/mention notifications (higher-priority in notifications UI).
    const followedRows = await this.prisma.follow.findMany({
      where: { followerId: recipientUserId },
      select: { followingId: true },
    });
    const followedActorIds = followedRows
      .map((r) => (r.followingId ?? '').trim())
      .filter(Boolean);

    const notifications = await this.prisma.notification.findMany({
      where: {
        recipientUserId,
        OR: [
          // Canonical "new post from someone you follow".
          { kind: 'followed_post', subjectPostId: { not: null } },
          // Replies can show up as comment/mention notifications for the same action.
          // Include them when the actor is someone the viewer follows so /new-posts
          // remains "posts from followed users", regardless of notification kind.
          ...(followedActorIds.length > 0
            ? [
                {
                  kind: 'comment' as const,
                  actorPostId: { not: null },
                  actorUserId: { in: followedActorIds },
                },
                {
                  kind: 'mention' as const,
                  actorPostId: { not: null },
                  actorUserId: { in: followedActorIds },
                },
              ]
            : []),
        ],
        ...(blockedActorIds.length > 0 ? { NOT: { actorUserId: { in: blockedActorIds } } } : {}),
        ...(cursorWhere ? { AND: [cursorWhere] } : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: rawFetchLimit + 1,
      select: { id: true, kind: true, subjectPostId: true, actorPostId: true },
    });

    const raw = notifications.slice(0, rawFetchLimit);
    const hasMoreRaw = notifications.length > rawFetchLimit;

    const orderedSubjectPostIds: string[] = [];
    const seenSubjectPostIds = new Set<string>();
    for (const n of raw) {
      const postId = (n.kind === 'followed_post'
        ? (n.subjectPostId ?? '')
        : (n.actorPostId ?? '')).trim();
      if (!postId || seenSubjectPostIds.has(postId)) continue;
      seenSubjectPostIds.add(postId);
      orderedSubjectPostIds.push(postId);
    }

    const visiblePosts = await this.getVisiblePostsByIds({
      viewerUserId: recipientUserId,
      ids: orderedSubjectPostIds,
      includeDeleted: false,
      excludeBannedAuthors: true,
    });
    const visibleById = new Map(visiblePosts.map((p) => [p.id, p] as const));
    const orderedVisiblePosts = orderedSubjectPostIds
      .map((id) => visibleById.get(id))
      .filter((p): p is (typeof visiblePosts)[number] => Boolean(p));

    // Preserve notification-event ordering for /new-posts: if both a root and a reply
    // are notified, both can appear in the feed (UI layer handles thread collapsing).
    const { items: collapsedVisiblePosts } = collapseFeedByRoot(orderedVisiblePosts, {
      collapseByRoot: params.collapseByRoot ?? false,
      collapseMode: params.collapseMode ?? 'root',
      prefer: params.prefer ?? 'reply',
      getId: (post) => post.id,
      getParentId: (post) => post.parentId ?? null,
    });
    const pagePosts = collapsedVisiblePosts.slice(0, desiredPostLimit);
    const returnedPostIds = new Set(pagePosts.map((p) => p.id));

    let boundaryIndex = -1;
    for (let i = 0; i < raw.length; i++) {
      const row = raw[i];
      const postId = (row?.kind === 'followed_post'
        ? (row?.subjectPostId ?? '')
        : (row?.actorPostId ?? '')).trim();
      if (postId && returnedPostIds.has(postId)) boundaryIndex = i;
    }
    if (boundaryIndex < 0 && raw.length > 0) boundaryIndex = raw.length - 1;

    const hasMore = hasMoreRaw || (boundaryIndex >= 0 && boundaryIndex < raw.length - 1);
    const nextCursor = hasMore && boundaryIndex >= 0 ? raw[boundaryIndex]!.id : null;

    if (pagePosts.length === 0) {
      return { posts: [], nextCursor };
    }

    const repostedPostIds = pagePosts
      .filter((p) => (p as { kind?: string; repostedPostId?: string | null }).kind === 'repost' && (p as { repostedPostId?: string | null }).repostedPostId)
      .map((p) => (p as { repostedPostId?: string | null }).repostedPostId as string);
    const [viewer, parentMap, repostedPostMap] = await Promise.all([
      this.viewerContextService.getViewer(recipientUserId),
      this.collectParentMapForViewer(recipientUserId, pagePosts.map((p) => p.parentId)),
      this.collectRepostedMapForViewer(recipientUserId, repostedPostIds),
    ]);
    const viewerHasAdmin = Boolean(viewer?.siteAdmin);
    const allPostIds = [...pagePosts.map((p) => p.id), ...parentMap.keys()];

    const [
      boostedRows,
      bookmarksRows,
      votedRows,
      repostedRows,
      blockSets,
    ] = await Promise.all([
      this.prisma.boost.findMany({
        where: { userId: recipientUserId, postId: { in: allPostIds } },
        select: { postId: true },
      }),
      this.prisma.bookmark.findMany({
        where: { userId: recipientUserId, postId: { in: allPostIds } },
        select: { postId: true, collections: { select: { collectionId: true } } },
      }).catch((e: unknown) => {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2021') return [];
        throw e;
      }),
      this.prisma.postPollVote.findMany({
        where: { userId: recipientUserId, poll: { postId: { in: allPostIds } } },
        select: { optionId: true, poll: { select: { postId: true } } },
      }),
      (this.prisma.post as any).findMany({
        where: { userId: recipientUserId, kind: 'repost', repostedPostId: { in: allPostIds }, deletedAt: null },
        select: { repostedPostId: true },
      }) as Promise<Array<{ repostedPostId: string | null }>>,
      this.prisma.userBlock.findMany({
        where: { OR: [{ blockerId: recipientUserId }, { blockedId: recipientUserId }] },
        select: { blockerId: true, blockedId: true },
      }),
    ]);

    const boosted = new Set(boostedRows.map((r) => r.postId));
    const bookmarksByPostId = new Map<string, { collectionIds: string[] }>();
    for (const row of bookmarksRows) {
      bookmarksByPostId.set(row.postId, { collectionIds: (row.collections ?? []).map((c) => c.collectionId) });
    }
    const votedPollOptionIdByPostId = new Map<string, string>();
    for (const row of votedRows) votedPollOptionIdByPostId.set(row.poll.postId, row.optionId);
    const repostedByPostId = new Set(
      repostedRows
        .map((r) => (r.repostedPostId ?? '').trim())
        .filter(Boolean),
    );
    const blockedByViewer = new Set<string>();
    const viewerBlockedBy = new Set<string>();
    for (const row of blockSets) {
      if (row.blockerId === recipientUserId) blockedByViewer.add(row.blockedId);
      if (row.blockedId === recipientUserId) viewerBlockedBy.add(row.blockerId);
    }

    const baseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;

    // Inline join-preview build (mirrors PostsService.communityGroupPreviewMapForFeed)
    // so /new-posts can render a clickable group tag on rows that belong to a group,
    // matching the home/explore feeds. We avoid depending on PostsService to keep
    // module wiring acyclic.
    const groupIds = new Set<string>();
    const collectGroupId = (row: { communityGroupId?: string | null } | null | undefined) => {
      const g = String(row?.communityGroupId ?? '').trim();
      if (g) groupIds.add(g);
    };
    for (const p of pagePosts) collectGroupId(p as { communityGroupId?: string | null });
    for (const p of parentMap.values()) collectGroupId(p as { communityGroupId?: string | null });
    for (const p of repostedPostMap.values()) collectGroupId(p as { communityGroupId?: string | null });
    const groupPreviewByGroupId = new Map<string, CommunityGroupPreviewDto>();
    if (groupIds.size > 0) {
      const ids = [...groupIds];
      const [groups, memberships] = await Promise.all([
        this.prisma.communityGroup.findMany({
          where: { id: { in: ids }, deletedAt: null },
        }),
        this.prisma.communityGroupMember.findMany({
          where: { groupId: { in: ids }, userId: recipientUserId },
          select: { groupId: true, status: true, role: true },
        }),
      ]);
      const memberByGroup = new Map(memberships.map((m) => [m.groupId, m] as const));
      for (const g of groups) {
        const dto = toCommunityGroupPreviewDto(g, memberByGroup.get(g.id) ?? null);
        if (dto) groupPreviewByGroupId.set(g.id, dto);
      }
    }

    const attachParentChain = buildAttachParentChain({
      parentMap,
      baseUrl,
      boosted,
      bookmarksByPostId,
      votedPollOptionIdByPostId,
      viewerUserId: recipientUserId,
      viewerHasAdmin,
      internalByPostId: null,
      scoreByPostId: undefined,
      toPostDto,
      blockedByViewer,
      viewerBlockedBy,
      repostedByPostId,
      repostedPostMap: repostedPostMap as any,
      groupPreviewByGroupId,
    });

    return {
      posts: pagePosts.map((p) => attachParentChain(p)),
      nextCursor,
    };
  }

  async getUndeliveredCount(recipientUserId: string): Promise<number> {
    // Chat unread state has its own messages badge; the bell count only includes
    // notification feed rows, and deliberately excludes legacy `message` rows.
    return this.getUndeliveredCountInternal(recipientUserId);
  }

  async markDelivered(recipientUserId: string): Promise<void> {
    const undeliveredCount = await this.prisma.$transaction(async (tx) => {
      const res = await tx.notification.updateMany({
        where: this.undeliveredBellWhere(recipientUserId),
        data: { deliveredAt: new Date() },
      });
      if (res.count > 0) {
        // Clamp to 0 — decrement can't go below 0 even if the counter drifted.
        await tx.$executeRaw`
          UPDATE "User"
          SET "undeliveredNotificationCount" = GREATEST(0, "undeliveredNotificationCount" - ${res.count})
          WHERE id = ${recipientUserId}
        `;
      }
      // Return accurate count from actual rows (handles drifted counters).
      return tx.notification.count({ where: this.undeliveredBellWhere(recipientUserId) });
    });
    this.presenceRealtime.emitNotificationsUpdated(recipientUserId, {
      undeliveredCount,
    });
  }

  async markNewPostsRead(recipientUserId: string): Promise<{ undeliveredCount: number }> {
    const undeliveredCount = await this.prisma.$transaction(async (tx) => {
      const now = new Date();
      const where = {
        recipientUserId,
        kind: 'followed_post' as const,
        OR: [{ readAt: null }, { deliveredAt: null }],
      };
      const deliveredRes = await tx.notification.updateMany({
        where: { ...where, deliveredAt: null },
        data: { deliveredAt: now },
      });
      await tx.notification.updateMany({
        where,
        data: { readAt: now, deliveredAt: now },
      });
      if (deliveredRes.count > 0) {
        await tx.$executeRaw`
          UPDATE "User"
          SET "undeliveredNotificationCount" = GREATEST(0, "undeliveredNotificationCount" - ${deliveredRes.count})
          WHERE id = ${recipientUserId}
        `;
      }
      return tx.notification.count({ where: { recipientUserId, deliveredAt: null } });
    });

    this.presenceRealtime.emitNotificationsUpdated(recipientUserId, {
      undeliveredCount,
    });
    return { undeliveredCount };
  }

  async markReadBySubject(
    recipientUserId: string,
    params: {
      postId?: string | null;
      userId?: string | null;
      articleId?: string | null;
      crewId?: string | null;
      groupId?: string | null;
    },
  ): Promise<void> {
    const { postId, userId, articleId, crewId, groupId } = params;
    if (!postId && !userId && !articleId && !crewId && !groupId) return;

    // Back-compat: followed_post notifications were historically keyed only by actorUserId.
    // When visiting a user's profile we want to clear "new posts" notifications for that actor,
    // even if subjectUserId was not set at creation time.
    const or: Array<Record<string, unknown>> = [];
    if (postId) {
      // Match notifications where this post is the subject (e.g. boost, mention, poll).
      or.push({ subjectPostId: postId });
      // Also match notifications where this post is the actor's post (e.g. comment/reply
      // notifications: subjectPostId = original post, actorPostId = the reply being viewed).
      or.push({ actorPostId: postId });
    }
    if (userId) {
      // Important: do NOT implicitly mark nudges as read when visiting a user's profile.
      // Nudges should only be cleared via explicit actions (ignore / acknowledge / nudge back).
      or.push({ subjectUserId: userId, kind: { not: 'nudge' } });
      or.push({ kind: 'followed_post', actorUserId: userId });
    }
    if (articleId) {
      or.push({ subjectArticleId: articleId });
    }
    if (crewId) {
      // All crew_* notifications carry subjectCrewId once the crew exists. Visiting the
      // crew page surfaces all of them (wall mentions, members joined/left, owner changes,
      // disband notices, invite acceptances/declines), so clear them all in one shot.
      or.push({ subjectCrewId: crewId });
    }
    if (groupId) {
      // Visiting a group page (or the pending-members page) surfaces join requests and
      // any other group-scoped notifications. Clear them all by group id.
      or.push({ subjectGroupId: groupId });
    }
    const where = {
      recipientUserId,
      readAt: null,
      ...(or.length ? { OR: or } : {}),
    } as const;

    const undeliveredCount = await this.prisma.$transaction(async (tx) => {
      const now = new Date();
      await tx.notification.updateMany({
        where,
        data: { readAt: now },
      });

      // Also mark as delivered (seen) when visiting the post/profile, then emit updated count.
      const deliveredWhere = { ...where, deliveredAt: null } as const;
      const deliveredRes = await tx.notification.updateMany({
        where: deliveredWhere,
        data: { deliveredAt: now },
      });
      if (deliveredRes.count > 0) {
        // Clamp to 0 — decrement can't go below 0 even if the counter drifted.
        await tx.$executeRaw`
          UPDATE "User"
          SET "undeliveredNotificationCount" = GREATEST(0, "undeliveredNotificationCount" - ${deliveredRes.count})
          WHERE id = ${recipientUserId}
        `;
      }
      // Return accurate count from actual rows (handles drifted counters).
      return tx.notification.count({ where: { recipientUserId, deliveredAt: null } });
    });
    this.presenceRealtime.emitNotificationsUpdated(recipientUserId, {
      undeliveredCount,
    });
    // markReadBySubject can clear comment notifications (e.g. opening the post via tap).
    void this.emitWaitingCountForUser(recipientUserId);
  }

  /**
   * Mark the recipient's `crew_invite_received` notification for a specific
   * invite as read + delivered. Idempotent and safe to call from any code path
   * that resolves the invite (accept / decline / cancel / expire) so the bell
   * badge clears regardless of which UI surface acted on it.
   */
  async markCrewInviteResolved(
    recipientUserId: string,
    inviteId: string,
  ): Promise<void> {
    const baseWhere = {
      recipientUserId,
      kind: 'crew_invite_received' as const,
      subjectCrewInviteId: inviteId,
    };
    const res = await this.prisma.$transaction(async (tx) => {
      const now = new Date();
      const readRes = await tx.notification.updateMany({
        where: { ...baseWhere, readAt: null },
        data: { readAt: now },
      });
      const deliveredRes = await tx.notification.updateMany({
        where: { ...baseWhere, deliveredAt: null },
        data: { deliveredAt: now },
      });
      if (deliveredRes.count > 0) {
        // Clamp to 0 so a drifted counter can't go negative.
        await tx.$executeRaw`
          UPDATE "User"
          SET "undeliveredNotificationCount" = GREATEST(0, "undeliveredNotificationCount" - ${deliveredRes.count})
          WHERE id = ${recipientUserId}
        `;
      }
      if (readRes.count === 0 && deliveredRes.count === 0) {
        return { changed: false as const, undeliveredCount: null as number | null };
      }
      const undeliveredCount = await tx.notification.count({
        where: { recipientUserId, deliveredAt: null },
      });
      return { changed: true as const, undeliveredCount };
    });
    if (res.changed) {
      this.presenceRealtime.emitNotificationsUpdated(recipientUserId, {
        undeliveredCount: res.undeliveredCount ?? 0,
      });
    }
  }

  async markReadById(
    recipientUserId: string,
    notificationId: string,
  ): Promise<boolean> {
    const notification = await this.prisma.notification.findUnique({
      where: { id: notificationId },
      select: { kind: true },
    });

    const res = await this.prisma.$transaction(async (tx) => {
      const now = new Date();
      const readRes = await tx.notification.updateMany({
        where: { id: notificationId, recipientUserId, readAt: null },
        data: { readAt: now },
      });
      if (readRes.count === 0) return { changed: false as const, undeliveredCount: null as number | null };
      const deliveredRes = await tx.notification.updateMany({
        where: { id: notificationId, recipientUserId, deliveredAt: null },
        data: { deliveredAt: now },
      });
      if (deliveredRes.count > 0) {
        const user = await tx.user.update({
          where: { id: recipientUserId },
          data: { undeliveredNotificationCount: { decrement: deliveredRes.count } },
          select: { undeliveredNotificationCount: true },
        });
        return { changed: true as const, undeliveredCount: user.undeliveredNotificationCount };
      }
      const row = await tx.user.findUnique({
        where: { id: recipientUserId },
        select: { undeliveredNotificationCount: true },
      });
      return { changed: true as const, undeliveredCount: row?.undeliveredNotificationCount ?? 0 };
    });
    if (res.changed) {
      this.presenceRealtime.emitNotificationsUpdated(recipientUserId, {
        undeliveredCount: res.undeliveredCount ?? 0,
      });
      if (notification?.kind === 'comment') {
        void this.emitWaitingCountForUser(recipientUserId);
      }
      this.posthog.capture(recipientUserId, 'notification_tapped', {
        notification_id: notificationId,
        kind: notification?.kind ?? null,
      });
    }
    return res.changed;
  }

  /**
   * Mark a notification as ignored (used for nudges).
   * Semantics:
   * - Clears unread highlight (readAt set)
   * - Clears badge if undelivered (deliveredAt set)
   * - Persists ignoredAt so the sender can remain rate-limited for a while
   */
  async ignoreById(
    recipientUserId: string,
    notificationId: string,
  ): Promise<boolean> {
    const res = await this.prisma.$transaction(async (tx) => {
      const now = new Date();
      const ignoredRes = await tx.notification.updateMany({
        where: { id: notificationId, recipientUserId, ignoredAt: null },
        data: { ignoredAt: now, readAt: now },
      });
      if (ignoredRes.count === 0) return { changed: false as const, undeliveredCount: null as number | null };
      const deliveredRes = await tx.notification.updateMany({
        where: { id: notificationId, recipientUserId, deliveredAt: null },
        data: { deliveredAt: now },
      });
      if (deliveredRes.count > 0) {
        const user = await tx.user.update({
          where: { id: recipientUserId },
          data: { undeliveredNotificationCount: { decrement: deliveredRes.count } },
          select: { undeliveredNotificationCount: true },
        });
        return { changed: true as const, undeliveredCount: user.undeliveredNotificationCount };
      }
      const row = await tx.user.findUnique({
        where: { id: recipientUserId },
        select: { undeliveredNotificationCount: true },
      });
      return { changed: true as const, undeliveredCount: row?.undeliveredNotificationCount ?? 0 };
    });
    if (res.changed) {
      this.presenceRealtime.emitNotificationsUpdated(recipientUserId, {
        undeliveredCount: res.undeliveredCount ?? 0,
      });
    }
    return res.changed;
  }

  async markNudgesReadByActor(
    recipientUserId: string,
    actorUserId: string,
  ): Promise<number> {
    const recipient = (recipientUserId ?? '').trim();
    const actor = (actorUserId ?? '').trim();
    if (!recipient || !actor) return 0;
    const res = await this.prisma.$transaction(async (tx) => {
      const now = new Date();
      const readRes = await tx.notification.updateMany({
        where: {
          recipientUserId: recipient,
          kind: 'nudge',
          actorUserId: actor,
          readAt: null,
        },
        data: { readAt: now },
      });
      if (readRes.count === 0) return { changedCount: 0, undeliveredCount: null as number | null };
      const deliveredRes = await tx.notification.updateMany({
        where: {
          recipientUserId: recipient,
          kind: 'nudge',
          actorUserId: actor,
          deliveredAt: null,
        },
        data: { deliveredAt: now },
      });
      if (deliveredRes.count > 0) {
        const user = await tx.user.update({
          where: { id: recipient },
          data: { undeliveredNotificationCount: { decrement: deliveredRes.count } },
          select: { undeliveredNotificationCount: true },
        });
        return { changedCount: readRes.count, undeliveredCount: user.undeliveredNotificationCount };
      }
      const row = await tx.user.findUnique({
        where: { id: recipient },
        select: { undeliveredNotificationCount: true },
      });
      return { changedCount: readRes.count, undeliveredCount: row?.undeliveredNotificationCount ?? 0 };
    });
    if (res.changedCount > 0) this.presenceRealtime.emitNotificationsUpdated(recipient, { undeliveredCount: res.undeliveredCount ?? 0 });
    return res.changedCount;
  }

  async markNudgesNudgedBackByActor(
    recipientUserId: string,
    actorUserId: string,
  ): Promise<number> {
    const recipient = (recipientUserId ?? '').trim();
    const actor = (actorUserId ?? '').trim();
    if (!recipient || !actor) return 0;
    const res = await this.prisma.$transaction(async (tx) => {
      const now = new Date();
      const nudgedRes = await tx.notification.updateMany({
        where: {
          recipientUserId: recipient,
          kind: 'nudge',
          actorUserId: actor,
          nudgedBackAt: null,
        },
        data: { nudgedBackAt: now, readAt: now },
      });
      if (nudgedRes.count === 0) return { changedCount: 0, undeliveredCount: null as number | null };
      const deliveredRes = await tx.notification.updateMany({
        where: {
          recipientUserId: recipient,
          kind: 'nudge',
          actorUserId: actor,
          deliveredAt: null,
        },
        data: { deliveredAt: now },
      });
      if (deliveredRes.count > 0) {
        const user = await tx.user.update({
          where: { id: recipient },
          data: { undeliveredNotificationCount: { decrement: deliveredRes.count } },
          select: { undeliveredNotificationCount: true },
        });
        return { changedCount: nudgedRes.count, undeliveredCount: user.undeliveredNotificationCount };
      }
      const row = await tx.user.findUnique({
        where: { id: recipient },
        select: { undeliveredNotificationCount: true },
      });
      return { changedCount: nudgedRes.count, undeliveredCount: row?.undeliveredNotificationCount ?? 0 };
    });
    if (res.changedCount > 0) this.presenceRealtime.emitNotificationsUpdated(recipient, { undeliveredCount: res.undeliveredCount ?? 0 });
    return res.changedCount;
  }

  async markNudgeNudgedBackById(
    recipientUserId: string,
    notificationId: string,
  ): Promise<boolean> {
    const res = await this.prisma.$transaction(async (tx) => {
      const now = new Date();
      const nudgedRes = await tx.notification.updateMany({
        where: { id: notificationId, recipientUserId, kind: 'nudge', nudgedBackAt: null },
        data: { nudgedBackAt: now, readAt: now },
      });
      if (nudgedRes.count === 0) return { changed: false as const, undeliveredCount: null as number | null };
      const deliveredRes = await tx.notification.updateMany({
        where: { id: notificationId, recipientUserId, deliveredAt: null },
        data: { deliveredAt: now },
      });
      if (deliveredRes.count > 0) {
        const user = await tx.user.update({
          where: { id: recipientUserId },
          data: { undeliveredNotificationCount: { decrement: deliveredRes.count } },
          select: { undeliveredNotificationCount: true },
        });
        return { changed: true as const, undeliveredCount: user.undeliveredNotificationCount };
      }
      const row = await tx.user.findUnique({
        where: { id: recipientUserId },
        select: { undeliveredNotificationCount: true },
      });
      return { changed: true as const, undeliveredCount: row?.undeliveredNotificationCount ?? 0 };
    });
    if (res.changed) this.presenceRealtime.emitNotificationsUpdated(recipientUserId, { undeliveredCount: res.undeliveredCount ?? 0 });
    return res.changed;
  }

  async ignoreNudgesByActor(
    recipientUserId: string,
    actorUserId: string,
  ): Promise<number> {
    const recipient = (recipientUserId ?? '').trim();
    const actor = (actorUserId ?? '').trim();
    if (!recipient || !actor) return 0;
    const res = await this.prisma.$transaction(async (tx) => {
      const now = new Date();
      const ignoredRes = await tx.notification.updateMany({
        where: {
          recipientUserId: recipient,
          kind: 'nudge',
          actorUserId: actor,
          ignoredAt: null,
        },
        data: { ignoredAt: now, readAt: now },
      });
      if (ignoredRes.count === 0) return { changedCount: 0, undeliveredCount: null as number | null };
      const deliveredRes = await tx.notification.updateMany({
        where: {
          recipientUserId: recipient,
          kind: 'nudge',
          actorUserId: actor,
          deliveredAt: null,
        },
        data: { deliveredAt: now },
      });
      if (deliveredRes.count > 0) {
        const user = await tx.user.update({
          where: { id: recipient },
          data: { undeliveredNotificationCount: { decrement: deliveredRes.count } },
          select: { undeliveredNotificationCount: true },
        });
        return { changedCount: ignoredRes.count, undeliveredCount: user.undeliveredNotificationCount };
      }
      const row = await tx.user.findUnique({
        where: { id: recipient },
        select: { undeliveredNotificationCount: true },
      });
      return { changedCount: ignoredRes.count, undeliveredCount: row?.undeliveredNotificationCount ?? 0 };
    });
    if (res.changedCount > 0) this.presenceRealtime.emitNotificationsUpdated(recipient, { undeliveredCount: res.undeliveredCount ?? 0 });
    return res.changedCount;
  }

  /** Mark all of the user's notifications as read and as seen (clears highlight and badge). */
  async markAllRead(recipientUserId: string): Promise<void> {
    const undeliveredCount = await this.prisma.$transaction(async (tx) => {
      const now = new Date();
      await tx.notification.updateMany({
        where: { recipientUserId, readAt: null, kind: { not: 'message' } },
        data: { readAt: now },
      });
      const deliveredRes = await tx.notification.updateMany({
        where: this.undeliveredBellWhere(recipientUserId),
        data: { deliveredAt: now },
      });
      if (deliveredRes.count > 0) {
        await tx.user.update({
          where: { id: recipientUserId },
          data: { undeliveredNotificationCount: { decrement: deliveredRes.count } },
          select: { undeliveredNotificationCount: true },
        });
        return tx.notification.count({ where: this.undeliveredBellWhere(recipientUserId) });
      }
      return tx.notification.count({ where: this.undeliveredBellWhere(recipientUserId) });
    });
    this.presenceRealtime.emitNotificationsUpdated(recipientUserId, {
      undeliveredCount,
    });
    // markAllRead clears every comment notification too.
    void this.emitWaitingCountForUser(recipientUserId);
  }

  private toNotificationDto(
    n: {
      id: string;
      createdAt: Date;
      kind: NotificationKind;
      deliveredAt: Date | null;
      readAt: Date | null;
      ignoredAt: Date | null;
      nudgedBackAt: Date | null;
      actorPostId: string | null;
      subjectPostId: string | null;
      subjectUserId: string | null;
      subjectArticleId?: string | null;
      subjectArticleCommentId?: string | null;
      subjectGroupId?: string | null;
      subjectCrewId?: string | null;
      subjectCrewInviteId?: string | null;
      subjectCommunityGroupInviteId?: string | null;
      subjectConversationId?: string | null;
      title: string | null;
      body: string | null;
      actor: {
        id: string;
        username: string | null;
        name: string | null;
        avatarKey: string | null;
        avatarUpdatedAt: Date | null;
        premium: boolean;
        isOrganization: boolean;
        verifiedStatus: string;
      } | null;
    },
    publicBaseUrl: string | null,
    subjectPostPreview?: SubjectPostPreviewDto | null,
    subjectPostVisibility: SubjectPostVisibility | null = null,
    subjectTier: SubjectTier = null,
    subjectArticlePreview?: SubjectArticlePreviewDto | null,
    subjectGroupSlug: string | null = null,
    subjectGroupName: string | null = null,
    subjectCrewInviteStatus: NotificationDto['subjectCrewInviteStatus'] = null,
    subjectCrewName: string | null = null,
    subjectCommunityGroupInviteStatus: NotificationDto['subjectCommunityGroupInviteStatus'] = null,
  ): NotificationDto {
    let actor: NotificationActorDto | null = null;
    if (n.actor && !(n.actor as { bannedAt?: Date | null }).bannedAt) {
      actor = {
        id: n.actor.id,
        username: n.actor.username,
        name: n.actor.name,
        avatarUrl: publicAssetUrl({
          publicBaseUrl,
          key: n.actor.avatarKey,
          updatedAt: n.actor.avatarUpdatedAt,
        }),
        premium: n.actor.premium,
        isOrganization: Boolean((n.actor as any).isOrganization),
        verifiedStatus: n.actor.verifiedStatus,
      };
    }
    return {
      id: n.id,
      createdAt: n.createdAt.toISOString(),
      kind: n.kind,
      deliveredAt: n.deliveredAt ? n.deliveredAt.toISOString() : null,
      readAt: n.readAt ? n.readAt.toISOString() : null,
      ignoredAt: n.ignoredAt ? n.ignoredAt.toISOString() : null,
      nudgedBackAt: n.nudgedBackAt ? n.nudgedBackAt.toISOString() : null,
      actor,
      actorPostId: n.actorPostId,
      subjectPostId: n.subjectPostId,
      subjectUserId: n.subjectUserId,
      subjectArticleId: n.subjectArticleId ?? null,
      subjectArticleCommentId: n.subjectArticleCommentId ?? null,
      subjectGroupId: n.subjectGroupId ?? null,
      subjectGroupSlug,
      subjectGroupName,
      subjectCrewId: n.subjectCrewId ?? null,
      subjectCrewInviteId: n.subjectCrewInviteId ?? null,
      subjectCrewInviteStatus: subjectCrewInviteStatus ?? null,
      subjectCrewName: subjectCrewName ?? null,
      subjectCommunityGroupInviteId: n.subjectCommunityGroupInviteId ?? null,
      subjectCommunityGroupInviteStatus: subjectCommunityGroupInviteStatus ?? null,
      subjectConversationId: n.subjectConversationId ?? null,
      title: n.title,
      body: n.body,
      subjectPostPreview: subjectPostPreview ?? null,
      subjectArticlePreview: subjectArticlePreview ?? null,
      subjectPostVisibility,
      subjectTier,
    };
  }

  private async buildNotificationDtoForRecipient(params: {
    recipientUserId: string;
    notificationId: string;
  }): Promise<NotificationDto | null> {
    const { recipientUserId, notificationId } = params;
    const id = (notificationId ?? '').trim();
    if (!id) return null;

    const n = await this.prisma.notification.findFirst({
      where: { id, recipientUserId },
      include: {
        actor: {
          select: {
            id: true,
            username: true,
            name: true,
            avatarKey: true,
            avatarUpdatedAt: true,
            premium: true,
            isOrganization: true,
            verifiedStatus: true,
            bannedAt: true,
          },
        },
      },
    });
    if (!n) return null;

    const publicBaseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;

    let subjectPostPreview: SubjectPostPreviewDto | null = null;
    let subjectTier: SubjectTier = null;
    let subjectPostVisibility: SubjectPostVisibility | null = null;

    const previewPostIds = [
      n.kind === 'repost' && n.actorPostId ? n.actorPostId : null,
      n.subjectPostId,
    ].filter((postId, index, arr): postId is string => Boolean(postId) && arr.indexOf(postId) === index);
    if (previewPostIds.length > 0) {
      const posts = await this.prisma.post.findMany({
        where: { id: { in: previewPostIds } },
        select: {
          id: true,
          body: true,
          visibility: true,
          media: {
            where: { deletedAt: null },
            orderBy: { position: 'asc' },
            select: { kind: true, r2Key: true, thumbnailR2Key: true, url: true },
          },
        },
      });
      const postById = new Map(posts.map((post) => [post.id, post] as const));
      const actorPost = n.kind === 'repost' && n.actorPostId ? postById.get(n.actorPostId) ?? null : null;
      const actorBodySnippet = (actorPost?.body ?? '').trim().slice(0, 150) || null;
      const actorHasMedia = Boolean(actorPost?.media?.some((m) => {
        const url =
          (m as { url?: string }).url?.trim() ||
          (publicAssetUrl({ publicBaseUrl, key: (m as { r2Key?: string }).r2Key ?? null }) ?? '');
        return Boolean(url);
      }));
      const p = actorBodySnippet || actorHasMedia
        ? actorPost
        : (n.subjectPostId ? postById.get(n.subjectPostId) ?? null : actorPost);
      if (p) {
        const bodySnippet = (p.body ?? '').trim().slice(0, 150) || null;
        const media = (p.media ?? [])
          .map((m) => {
            const url =
              (m as { url?: string }).url?.trim() ||
              (publicAssetUrl({ publicBaseUrl, key: (m as { r2Key?: string }).r2Key ?? null }) ?? '');
            const thumbnailUrl =
              (publicAssetUrl({
                publicBaseUrl,
                key: (m as { thumbnailR2Key?: string }).thumbnailR2Key ?? null,
              }) ?? null) || null;
            return { url: url || '', thumbnailUrl, kind: (m as { kind: string }).kind };
          })
          .filter((m) => m.url);
        subjectPostPreview = { bodySnippet, media };
        const vis = (p as { visibility?: string }).visibility;
        subjectTier = vis === 'premiumOnly' ? 'premium' : vis === 'verifiedOnly' ? 'verified' : null;
        if (vis === 'public' || vis === 'verifiedOnly' || vis === 'premiumOnly' || vis === 'onlyMe') {
          subjectPostVisibility = vis;
        }
      }
    } else if (n.subjectUserId) {
      const u = await this.prisma.user.findUnique({
        where: { id: n.subjectUserId },
        select: { id: true, premium: true, verifiedStatus: true },
      });
      if (u) {
        subjectTier = u.premium ? 'premium' : u.verifiedStatus !== 'none' ? 'verified' : null;
      }
    }

    let subjectGroupSlug: string | null = null;
    let subjectGroupName: string | null = null;
    if (n.subjectGroupId) {
      const g = await this.prisma.communityGroup.findUnique({
        where: { id: n.subjectGroupId },
        select: { slug: true, name: true },
      });
      subjectGroupSlug = g?.slug ?? null;
      subjectGroupName = g?.name ?? null;
    }

    let subjectCrewInviteStatus: NotificationDto['subjectCrewInviteStatus'] = null;
    let subjectCrewName: string | null = null;
    if (n.subjectCrewInviteId) {
      const inv = await this.prisma.crewInvite.findUnique({
        where: { id: n.subjectCrewInviteId },
        select: {
          status: true,
          crewNameOnAccept: true,
          crew: { select: { name: true } },
        },
      });
      subjectCrewInviteStatus = inv?.status ?? null;
      // Fall back to the founding `crewNameOnAccept` so even pre-accept invites
      // have a display name when the recipient's `subjectCrewId` isn't set yet.
      const candidate = (inv?.crew?.name ?? inv?.crewNameOnAccept ?? '').trim();
      if (candidate) subjectCrewName = candidate;
    }
    if (!subjectCrewName && n.subjectCrewId) {
      const c = await this.prisma.crew.findUnique({
        where: { id: n.subjectCrewId },
        select: { name: true },
      });
      const candidate = (c?.name ?? '').trim();
      if (candidate) subjectCrewName = candidate;
    }

    let subjectCommunityGroupInviteStatus:
      NotificationDto['subjectCommunityGroupInviteStatus'] = null;
    if (n.subjectCommunityGroupInviteId) {
      const inv = await this.prisma.communityGroupInvite.findUnique({
        where: { id: n.subjectCommunityGroupInviteId },
        select: { status: true },
      });
      subjectCommunityGroupInviteStatus = inv?.status ?? null;
    }

    return this.toNotificationDto(
      n,
      publicBaseUrl,
      subjectPostPreview,
      subjectPostVisibility,
      subjectTier,
      undefined,
      subjectGroupSlug,
      subjectGroupName,
      subjectCrewInviteStatus,
      subjectCrewName,
      subjectCommunityGroupInviteStatus,
    );
  }

  /**
   * Create or refresh a community-group invite notification on the invitee. On
   * re-invite (existing pending invite), bumps `createdAt`, **re-marks unread**
   * (clears delivered/readAt) and bumps the undelivered counter so the bell
   * badge reflects the new ping. Otherwise creates a fresh row.
   *
   * Returns true when the invitee was actively (re)notified — caller should
   * stamp `lastNotifiedAt` on the invite when this returns true.
   */
  async upsertCommunityGroupInviteReceivedNotification(params: {
    inviteeUserId: string;
    inviterUserId: string;
    groupId: string;
    inviteId: string;
    bodySnippet?: string | null;
  }): Promise<{ notified: boolean }> {
    const { inviteeUserId, inviterUserId, groupId, inviteId, bodySnippet } = params;
    if (inviteeUserId === inviterUserId) return { notified: false };

    const result = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.notification.findFirst({
        where: {
          recipientUserId: inviteeUserId,
          kind: 'community_group_invite_received',
          subjectCommunityGroupInviteId: inviteId,
        },
        select: { id: true, deliveredAt: true, readAt: true },
      });

      if (existing) {
        const now = new Date();
        const wasDelivered = existing.deliveredAt != null;
        await tx.notification.update({
          where: { id: existing.id },
          data: {
            createdAt: now,
            deliveredAt: null,
            readAt: null,
            ignoredAt: null,
            actorUserId: inviterUserId,
            body: bodySnippet ?? undefined,
          },
        });
        if (wasDelivered) {
          await tx.user.update({
            where: { id: inviteeUserId },
            data: { undeliveredNotificationCount: { increment: 1 } },
          });
        }
        const undeliveredCount = await tx.notification.count({
          where: { recipientUserId: inviteeUserId, deliveredAt: null },
        });
        return { kind: 'updated' as const, notificationId: existing.id, undeliveredCount };
      }

      const created = await tx.notification.create({
        data: {
          recipientUserId: inviteeUserId,
          kind: 'community_group_invite_received',
          actorUserId: inviterUserId,
          subjectGroupId: groupId,
          subjectCommunityGroupInviteId: inviteId,
          title: 'invited you to their group',
          body: bodySnippet ?? undefined,
        },
        select: { id: true },
      });
      await tx.user.update({
        where: { id: inviteeUserId },
        data: { undeliveredNotificationCount: { increment: 1 } },
      });
      const undeliveredCount = await tx.notification.count({
        where: { recipientUserId: inviteeUserId, deliveredAt: null },
      });
      return { kind: 'created' as const, notificationId: created.id, undeliveredCount };
    });

    this.presenceRealtime.emitNotificationsUpdated(inviteeUserId, {
      undeliveredCount: result.undeliveredCount,
    });
    try {
      const dto = await this.buildNotificationDtoForRecipient({
        recipientUserId: inviteeUserId,
        notificationId: result.notificationId,
      });
      if (dto) {
        this.presenceRealtime.emitNotificationNew(inviteeUserId, { notification: dto });
      }
    } catch (err) {
      this.logger.debug(`[notifications] Failed to emit group invite notification: ${err}`);
    }

    // Web push (best-effort, gated on user prefs).
    try {
      const prefs = await this.getPreferencesInternal(inviteeUserId);
      if (this.shouldSendPushForKind(prefs, 'community_group_invite_received')) {
        const actor = await this.prisma.user.findUnique({
          where: { id: inviterUserId },
          select: { id: true, username: true, name: true, avatarKey: true, avatarUpdatedAt: true },
        });
        const pushCopy = this.buildPushCopy({
          kind: 'community_group_invite_received',
          actor,
          fallbackTitle: 'invited you to their group',
          body: bodySnippet ?? null,
        });
        const publicBaseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;
        const icon = actor
          ? publicAssetUrl({ publicBaseUrl, key: actor.avatarKey, updatedAt: actor.avatarUpdatedAt })
          : null;
        this.sendWebPushToRecipient(inviteeUserId, {
          title: pushCopy.title,
          body: pushCopy.body,
          subjectPostId: null,
          subjectUserId: null,
          tag: this.buildPushTag({
            recipientUserId: inviteeUserId,
            kind: 'community_group_invite_received',
            actorUserId: inviterUserId,
            subjectPostId: null,
            subjectUserId: null,
          }),
          icon,
          badge: '/android-chrome-192x192.png',
          renotify: true,
          kind: 'community_group_invite_received',
          sourceLabel: 'From notifications',
        }).catch((err) => {
          this.logger.warn(`[push] Failed to send group invite push: ${err instanceof Error ? err.message : String(err)}`);
        });
      }
    } catch (err) {
      this.logger.debug(`[push] Failed to evaluate push prefs for group invite: ${err}`);
    }

    return { notified: true };
  }

  /**
   * Create or refresh a community-group invite *response* notification on the
   * inviter (accepted/declined). On a repeat from the same actor + invite,
   * bumps `createdAt` and re-marks unread instead of stacking duplicate rows.
   */
  async upsertCommunityGroupInviteResponseNotification(params: {
    inviterUserId: string;
    inviteeUserId: string;
    groupId: string;
    inviteId: string;
    response: 'accepted' | 'declined';
  }): Promise<void> {
    const { inviterUserId, inviteeUserId, groupId, inviteId, response } = params;
    if (inviterUserId === inviteeUserId) return;
    const kind: NotificationKind =
      response === 'accepted'
        ? 'community_group_invite_accepted'
        : 'community_group_invite_declined';

    const result = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.notification.findFirst({
        where: {
          recipientUserId: inviterUserId,
          kind,
          subjectCommunityGroupInviteId: inviteId,
          actorUserId: inviteeUserId,
        },
        select: { id: true, deliveredAt: true },
      });
      if (existing) {
        const now = new Date();
        const wasDelivered = existing.deliveredAt != null;
        await tx.notification.update({
          where: { id: existing.id },
          data: { createdAt: now, deliveredAt: null, readAt: null, ignoredAt: null },
        });
        if (wasDelivered) {
          await tx.user.update({
            where: { id: inviterUserId },
            data: { undeliveredNotificationCount: { increment: 1 } },
          });
        }
        const undeliveredCount = await tx.notification.count({
          where: { recipientUserId: inviterUserId, deliveredAt: null },
        });
        return { kind: 'updated' as const, notificationId: existing.id, undeliveredCount };
      }
      const created = await tx.notification.create({
        data: {
          recipientUserId: inviterUserId,
          kind,
          actorUserId: inviteeUserId,
          subjectGroupId: groupId,
          subjectCommunityGroupInviteId: inviteId,
          title:
            response === 'accepted'
              ? 'accepted your group invite'
              : 'declined your group invite',
        },
        select: { id: true },
      });
      await tx.user.update({
        where: { id: inviterUserId },
        data: { undeliveredNotificationCount: { increment: 1 } },
      });
      const undeliveredCount = await tx.notification.count({
        where: { recipientUserId: inviterUserId, deliveredAt: null },
      });
      return { kind: 'created' as const, notificationId: created.id, undeliveredCount };
    });

    this.presenceRealtime.emitNotificationsUpdated(inviterUserId, {
      undeliveredCount: result.undeliveredCount,
    });
    try {
      const dto = await this.buildNotificationDtoForRecipient({
        recipientUserId: inviterUserId,
        notificationId: result.notificationId,
      });
      if (dto) {
        this.presenceRealtime.emitNotificationNew(inviterUserId, { notification: dto });
      }
    } catch (err) {
      this.logger.debug(`[notifications] Failed to emit invite response notification: ${err}`);
    }

    // Push for accepted/declined is best-effort; reuse generic flow.
    try {
      const prefs = await this.getPreferencesInternal(inviterUserId);
      if (this.shouldSendPushForKind(prefs, kind)) {
        const actor = await this.prisma.user.findUnique({
          where: { id: inviteeUserId },
          select: { id: true, username: true, name: true, avatarKey: true, avatarUpdatedAt: true },
        });
        const pushCopy = this.buildPushCopy({ kind, actor, fallbackTitle: null, body: null });
        const publicBaseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;
        const icon = actor
          ? publicAssetUrl({ publicBaseUrl, key: actor.avatarKey, updatedAt: actor.avatarUpdatedAt })
          : null;
        this.sendWebPushToRecipient(inviterUserId, {
          title: pushCopy.title,
          body: pushCopy.body,
          subjectPostId: null,
          subjectUserId: null,
          tag: this.buildPushTag({
            recipientUserId: inviterUserId,
            kind,
            actorUserId: inviteeUserId,
            subjectPostId: null,
            subjectUserId: null,
          }),
          icon,
          badge: '/android-chrome-192x192.png',
          renotify: true,
          kind,
          sourceLabel: 'From notifications',
        }).catch((err) => {
          this.logger.warn(`[push] Failed to send invite response push: ${err instanceof Error ? err.message : String(err)}`);
        });
      }
    } catch (err) {
      this.logger.debug(`[push] Failed to evaluate push prefs for invite response: ${err}`);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Group lifecycle notification upserts
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Shared upsert core: find-or-create a notification row identified by
   * (recipient, kind, actorUser, subjectGroup). On re-trigger with the
   * same key, bumps `createdAt`, clears delivered/read timestamps, and
   * increments the undelivered counter if the row was previously delivered.
   */
  private async upsertGroupNotification(params: {
    recipientUserId: string;
    kind: NotificationKind;
    actorUserId: string | null;
    subjectGroupId: string;
    title: string;
  }): Promise<{ notificationId: string; undeliveredCount: number; isNew: boolean }> {
    const { recipientUserId, kind, actorUserId, subjectGroupId, title } = params;
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.notification.findFirst({
        where: {
          recipientUserId,
          kind,
          actorUserId: actorUserId ?? undefined,
          subjectGroupId,
        },
        select: { id: true, deliveredAt: true },
      });

      if (existing) {
        const wasDelivered = existing.deliveredAt != null;
        await tx.notification.update({
          where: { id: existing.id },
          data: { createdAt: new Date(), deliveredAt: null, readAt: null, ignoredAt: null, title },
        });
        if (wasDelivered) {
          await tx.user.update({
            where: { id: recipientUserId },
            data: { undeliveredNotificationCount: { increment: 1 } },
          });
        }
        const undeliveredCount = await tx.notification.count({
          where: { recipientUserId, deliveredAt: null },
        });
        return { notificationId: existing.id, undeliveredCount, isNew: false };
      }

      const created = await tx.notification.create({
        data: { recipientUserId, kind, actorUserId: actorUserId ?? undefined, subjectGroupId, title },
        select: { id: true },
      });
      await tx.user.update({
        where: { id: recipientUserId },
        data: { undeliveredNotificationCount: { increment: 1 } },
      });
      const undeliveredCount = await tx.notification.count({
        where: { recipientUserId, deliveredAt: null },
      });
      return { notificationId: created.id, undeliveredCount, isNew: true };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  private async emitGroupNotification(recipientUserId: string, notificationId: string, undeliveredCount: number) {
    this.presenceRealtime.emitNotificationsUpdated(recipientUserId, { undeliveredCount });
    try {
      const dto = await this.buildNotificationDtoForRecipient({ recipientUserId, notificationId });
      if (dto) this.presenceRealtime.emitNotificationNew(recipientUserId, { notification: dto });
    } catch { /* best-effort */ }
  }

  private async pushGroupNotification(params: {
    recipientUserId: string;
    actorUserId: string | null;
    kind: NotificationKind;
    subjectGroupId: string;
  }): Promise<void> {
    const { recipientUserId, actorUserId, kind, subjectGroupId } = params;
    try {
      const prefs = await this.getPreferencesInternal(recipientUserId);
      if (!this.shouldSendPushForKind(prefs, kind)) return;
      const actor = actorUserId
        ? await this.prisma.user.findUnique({
            where: { id: actorUserId },
            select: { id: true, username: true, name: true, avatarKey: true, avatarUpdatedAt: true },
          })
        : null;
      const pushCopy = this.buildPushCopy({ kind, actor, fallbackTitle: null, body: null });
      const publicBaseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;
      const icon = actor
        ? publicAssetUrl({ publicBaseUrl, key: actor.avatarKey, updatedAt: actor.avatarUpdatedAt })
        : null;
      this.sendWebPushToRecipient(recipientUserId, {
        title: pushCopy.title,
        body: pushCopy.body,
        subjectPostId: null,
        subjectUserId: null,
        url: `/g/${subjectGroupId}`,
        tag: this.buildPushTag({ recipientUserId, kind, actorUserId, subjectPostId: null, subjectUserId: null }),
        icon,
        badge: '/android-chrome-192x192.png',
        renotify: true,
        kind,
        sourceLabel: 'From notifications',
      }).catch((err) => {
        this.logger.warn(`[push] Failed to send group notification push (${kind}): ${err instanceof Error ? err.message : String(err)}`);
      });
    } catch (err) {
      this.logger.debug(`[push] Failed to evaluate push prefs for group notification (${kind}): ${err}`);
    }
  }

  /**
   * Notify a single existing member that a new user joined their group.
   * Per-(recipient, actor, group) row so multi-join events roll up in the feed.
   */
  async upsertGroupMemberJoinedNotification(params: {
    recipientUserId: string;
    joinerUserId: string;
    groupId: string;
  }): Promise<void> {
    const { recipientUserId, joinerUserId, groupId } = params;
    if (recipientUserId === joinerUserId) return;
    const result = await this.upsertGroupNotification({
      recipientUserId,
      kind: 'community_group_member_joined',
      actorUserId: joinerUserId,
      subjectGroupId: groupId,
      title: 'joined the group',
    });
    await this.emitGroupNotification(recipientUserId, result.notificationId, result.undeliveredCount);
    if (result.isNew) {
      void this.pushGroupNotification({ recipientUserId, actorUserId: joinerUserId, kind: 'community_group_member_joined', subjectGroupId: groupId });
    }
  }

  /**
   * Notify the requester that their join request was approved or rejected.
   */
  async upsertGroupJoinDecisionNotification(params: {
    recipientUserId: string;
    groupId: string;
    actorUserId: string;
    decision: 'approved' | 'rejected';
  }): Promise<void> {
    const { recipientUserId, groupId, actorUserId, decision } = params;
    if (recipientUserId === actorUserId) return;
    const kind: NotificationKind = decision === 'approved' ? 'community_group_join_approved' : 'community_group_join_rejected';
    const title = decision === 'approved' ? 'Your join request was approved' : 'Your join request was not accepted';
    const result = await this.upsertGroupNotification({
      recipientUserId,
      kind,
      actorUserId,
      subjectGroupId: groupId,
      title,
    });
    await this.emitGroupNotification(recipientUserId, result.notificationId, result.undeliveredCount);
    if (result.isNew) {
      void this.pushGroupNotification({ recipientUserId, actorUserId, kind, subjectGroupId: groupId });
    }
  }

  /**
   * Notify a user that they were removed from a group.
   */
  async upsertGroupMemberRemovedNotification(params: {
    recipientUserId: string;
    groupId: string;
    actorUserId: string;
  }): Promise<void> {
    const { recipientUserId, groupId, actorUserId } = params;
    if (recipientUserId === actorUserId) return;
    const result = await this.upsertGroupNotification({
      recipientUserId,
      kind: 'community_group_member_removed',
      actorUserId,
      subjectGroupId: groupId,
      title: 'You were removed from a group',
    });
    await this.emitGroupNotification(recipientUserId, result.notificationId, result.undeliveredCount);
    if (result.isNew) {
      void this.pushGroupNotification({ recipientUserId, actorUserId, kind: 'community_group_member_removed', subjectGroupId: groupId });
    }
  }

  /**
   * Notify a member that a group they were in was disbanded.
   */
  async upsertGroupDisbandedNotification(params: {
    recipientUserId: string;
    groupId: string;
    actorUserId: string;
  }): Promise<void> {
    const { recipientUserId, groupId, actorUserId } = params;
    if (recipientUserId === actorUserId) return;
    const result = await this.upsertGroupNotification({
      recipientUserId,
      kind: 'community_group_disbanded',
      actorUserId,
      subjectGroupId: groupId,
      title: 'A group you were in was disbanded',
    });
    await this.emitGroupNotification(recipientUserId, result.notificationId, result.undeliveredCount);
    if (result.isNew) {
      void this.pushGroupNotification({ recipientUserId, actorUserId, kind: 'community_group_disbanded', subjectGroupId: groupId });
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Crew lifecycle notification upserts (filling in unused enum values)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Shared upsert for crew-scoped notifications.
   */
  private async upsertCrewNotification(params: {
    recipientUserId: string;
    kind: NotificationKind;
    actorUserId: string | null;
    subjectCrewId: string;
    title: string;
  }): Promise<{ notificationId: string; undeliveredCount: number; isNew: boolean }> {
    const { recipientUserId, kind, actorUserId, subjectCrewId, title } = params;
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.notification.findFirst({
        where: { recipientUserId, kind, actorUserId: actorUserId ?? undefined, subjectCrewId },
        select: { id: true, deliveredAt: true },
      });

      if (existing) {
        const wasDelivered = existing.deliveredAt != null;
        await tx.notification.update({
          where: { id: existing.id },
          data: { createdAt: new Date(), deliveredAt: null, readAt: null, ignoredAt: null, title },
        });
        if (wasDelivered) {
          await tx.user.update({
            where: { id: recipientUserId },
            data: { undeliveredNotificationCount: { increment: 1 } },
          });
        }
        const undeliveredCount = await tx.notification.count({ where: { recipientUserId, deliveredAt: null } });
        return { notificationId: existing.id, undeliveredCount, isNew: false };
      }

      const created = await tx.notification.create({
        data: { recipientUserId, kind, actorUserId: actorUserId ?? undefined, subjectCrewId, title },
        select: { id: true },
      });
      await tx.user.update({
        where: { id: recipientUserId },
        data: { undeliveredNotificationCount: { increment: 1 } },
      });
      const undeliveredCount = await tx.notification.count({ where: { recipientUserId, deliveredAt: null } });
      return { notificationId: created.id, undeliveredCount, isNew: true };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  private async emitCrewNotification(recipientUserId: string, notificationId: string, undeliveredCount: number) {
    this.presenceRealtime.emitNotificationsUpdated(recipientUserId, { undeliveredCount });
    try {
      const dto = await this.buildNotificationDtoForRecipient({ recipientUserId, notificationId });
      if (dto) this.presenceRealtime.emitNotificationNew(recipientUserId, { notification: dto });
    } catch { /* best-effort */ }
  }

  /** Notify remaining crew members that someone left. */
  async upsertCrewMemberLeftNotification(params: {
    recipientUserId: string;
    leaverUserId: string;
    crewId: string;
  }): Promise<void> {
    const { recipientUserId, leaverUserId, crewId } = params;
    if (recipientUserId === leaverUserId) return;
    const result = await this.upsertCrewNotification({
      recipientUserId,
      kind: 'crew_member_left',
      actorUserId: leaverUserId,
      subjectCrewId: crewId,
      title: 'left your crew',
    });
    await this.emitCrewNotification(recipientUserId, result.notificationId, result.undeliveredCount);
  }

  /** Notify the kicked member that they were removed. */
  async upsertCrewMemberKickedNotification(params: {
    recipientUserId: string;
    actorUserId: string;
    crewId: string;
  }): Promise<void> {
    const { recipientUserId, actorUserId, crewId } = params;
    if (recipientUserId === actorUserId) return;
    const result = await this.upsertCrewNotification({
      recipientUserId,
      kind: 'crew_member_kicked',
      actorUserId,
      subjectCrewId: crewId,
      title: 'You were removed from your crew',
    });
    await this.emitCrewNotification(recipientUserId, result.notificationId, result.undeliveredCount);
  }

  /** Notify every former crew member that the crew was disbanded. */
  async upsertCrewDisbandedNotification(params: {
    recipientUserId: string;
    actorUserId: string;
    crewId: string;
  }): Promise<void> {
    const { recipientUserId, actorUserId, crewId } = params;
    if (recipientUserId === actorUserId) return;
    const result = await this.upsertCrewNotification({
      recipientUserId,
      kind: 'crew_disbanded',
      actorUserId,
      subjectCrewId: crewId,
      title: 'Your crew was disbanded',
    });
    await this.emitCrewNotification(recipientUserId, result.notificationId, result.undeliveredCount);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // DM (message) notification upsert
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * One row per (recipient, conversation). Re-marks as unread on every new
   * message so the bell keeps dotting until the conversation is opened.
   */
  async upsertMessageNotification(params: {
    recipientUserId: string;
    senderUserId: string;
    conversationId: string;
    snippet?: string | null;
  }): Promise<void> {
    const { recipientUserId, senderUserId, conversationId, snippet } = params;
    if (recipientUserId === senderUserId) return;

    const result = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.notification.findFirst({
        where: { recipientUserId, kind: 'message', subjectConversationId: conversationId },
        select: { id: true, deliveredAt: true },
      });

      if (existing) {
        const wasDelivered = existing.deliveredAt != null;
        await tx.notification.update({
          where: { id: existing.id },
          data: {
            createdAt: new Date(),
            deliveredAt: null,
            readAt: null,
            ignoredAt: null,
            actorUserId: senderUserId,
            body: snippet ?? undefined,
            title: 'sent you a message',
          },
        });
        if (wasDelivered) {
          await tx.user.update({
            where: { id: recipientUserId },
            data: { undeliveredNotificationCount: { increment: 1 } },
          });
        }
        const undeliveredCount = await tx.notification.count({ where: { recipientUserId, deliveredAt: null } });
        return { notificationId: existing.id, undeliveredCount, isNew: false };
      }

      const created = await tx.notification.create({
        data: {
          recipientUserId,
          kind: 'message',
          actorUserId: senderUserId,
          subjectConversationId: conversationId,
          title: 'sent you a message',
          body: snippet ?? undefined,
        },
        select: { id: true },
      });
      await tx.user.update({
        where: { id: recipientUserId },
        data: { undeliveredNotificationCount: { increment: 1 } },
      });
      const undeliveredCount = await tx.notification.count({ where: { recipientUserId, deliveredAt: null } });
      return { notificationId: created.id, undeliveredCount, isNew: true };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

    this.presenceRealtime.emitNotificationsUpdated(recipientUserId, { undeliveredCount: result.undeliveredCount });
    try {
      const dto = await this.buildNotificationDtoForRecipient({ recipientUserId, notificationId: result.notificationId });
      if (dto) this.presenceRealtime.emitNotificationNew(recipientUserId, { notification: dto });
    } catch { /* best-effort */ }
  }

  /**
   * Mark the message notification for a conversation as read when the user opens it.
   * Also decrements the undelivered counter if the row was undelivered.
   */
  async markConversationMessageNotificationRead(params: {
    userId: string;
    conversationId: string;
  }): Promise<void> {
    const { userId, conversationId } = params;
    const existing = await this.prisma.notification.findFirst({
      where: { recipientUserId: userId, kind: 'message', subjectConversationId: conversationId, readAt: null },
      select: { id: true, deliveredAt: true },
    });
    if (!existing) return;

    const wasUndelivered = existing.deliveredAt == null;
    await this.prisma.$transaction(async (tx) => {
      const now = new Date();
      await tx.notification.update({
        where: { id: existing.id },
        data: { readAt: now, deliveredAt: existing.deliveredAt ?? now },
      });
      if (wasUndelivered) {
        await tx.user.update({
          where: { id: userId },
          data: { undeliveredNotificationCount: { decrement: 1 } },
        });
      }
    });

    if (wasUndelivered) {
      const undeliveredCount = await this.prisma.notification.count({
        where: { recipientUserId: userId, deliveredAt: null },
      });
      this.presenceRealtime.emitNotificationsUpdated(userId, { undeliveredCount });
    }
    this.presenceRealtime.emitNotificationsDeleted(userId, { notificationIds: [existing.id] });
  }
}
