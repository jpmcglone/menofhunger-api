import { Injectable, Logger } from '@nestjs/common';
import { NotificationPushDeliveryService } from './notification-push-delivery.service';
import { buildPushCopy, buildPushTag, pushCategory } from './notification-push-copy';
import { AppConfigService } from '../app/app-config.service';
import { NotificationPreferencesService } from './notification-preferences.service';
import { PostsReadService } from '../posts-read/posts-read.service';
import { PrismaService } from '../prisma/prisma.service';
import { findGroupNotificationPreference } from '../viewer/group-membership.queries';
import { publicAssetUrl } from '../../common/assets/public-asset-url';
import type { NotificationKind } from '@prisma/client';
import { permitsFollowNotification } from './follow-notification-policy';
import { pushSubtitle, shouldSendPushForKind } from './notification-push.rules';
import { NOT_DELETED } from '../../common/prisma/where';

@Injectable()
export class NotificationPushKindService {
  private readonly logger = new Logger(NotificationPushKindService.name);

  constructor(
    private readonly delivery: NotificationPushDeliveryService,
    private readonly appConfig: AppConfigService,
    private readonly postsRead: PostsReadService,
    private readonly preferences: NotificationPreferencesService,
    private readonly prisma: PrismaService,
  ) {}

  async sendKindPushForActor(params: {
    recipientUserId: string;
    kind: NotificationKind;
    actorUserId: string | null;
    fallbackTitle?: string | null;
    body?: string | null;
    actorPostId?: string | null;
    subjectArticleId?: string | null;
    subjectPostId?: string | null;
    subjectUserId?: string | null;
    subjectGroupId?: string | null;
    subjectCommunityGroupInviteId?: string | null;
    url?: string | null;
    notificationId?: string | null;
    sourceLabel?: string;
  }): Promise<void> {
    const { recipientUserId, kind, actorUserId } = params;
    try {
      const prefs = await this.preferences.getPreferencesInternal(recipientUserId);
      if (!shouldSendPushForKind(prefs, kind)) return;
      if (!(await permitsFollowNotification({ follow: this.prisma.follow, post: this.postsRead }, params))) return;
      const mediaPostId = params.actorPostId ?? params.subjectPostId ?? null;
      const threadPostId = params.subjectPostId ?? params.actorPostId ?? null;
      const [actor, mediaPost, threadPost, group] = await Promise.all([
        actorUserId ? this.delivery.getActorMini(actorUserId) : null,
        mediaPostId
          ? this.postsRead.findIncludingDeleted({
              where: { id: mediaPostId },
              select: {
                id: true,
                deletedAt: true,
                rootId: true,
                communityGroupId: true,
                kind: true,
                media: {
                  where: NOT_DELETED,
                  orderBy: { position: 'asc' },
                  take: 1,
                  select: {
                    kind: true,
                    source: true,
                    r2Key: true,
                    thumbnailR2Key: true,
                    url: true,
                  },
                },
              },
            })
          : null,
        threadPostId && threadPostId !== mediaPostId
          ? this.postsRead.findIncludingDeleted({
              where: { id: threadPostId },
              select: { id: true, deletedAt: true, rootId: true },
            })
          : null,
        params.subjectGroupId
          ? this.prisma.communityGroup.findUnique({
              where: { id: params.subjectGroupId },
              select: { slug: true, name: true, avatarImageUrl: true, deletedAt: true },
            })
          : null,
      ]);
      // Re-check at delivery time: queued pushes may outlive a preference change.
      const activityGroupId = mediaPost?.communityGroupId;
      if (activityGroupId && ['comment', 'mention', 'boost', 'repost', 'followed_post', 'community_group_post'].includes(kind)) {
        const member = await findGroupNotificationPreference(this.prisma, activityGroupId, recipientUserId);
        if (member?.notificationPreference === 'muted') return;
        if (member?.notificationPreference === 'repliesAndMentions' && kind !== 'comment' && kind !== 'mention') return;
      }
      const pushCopy = buildPushCopy({
        kind,
        actor,
        fallbackTitle: params.fallbackTitle ?? null,
        body: params.body ?? null,
        subjectArticleId: params.subjectArticleId ?? null,
      });
      const publicBaseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;
      const icon = actor
        ? publicAssetUrl({
            publicBaseUrl,
            key: actor.avatarKey,
            updatedAt: actor.avatarUpdatedAt,
          })
        : null;
      const currentGroup = group?.deletedAt ? null : group;
      const firstMedia = mediaPost?.deletedAt ? null : mediaPost?.media[0];
      const mediaKey =
        firstMedia?.kind === 'video' ? firstMedia.thumbnailR2Key : firstMedia?.r2Key;
      const mediaUrl =
        publicAssetUrl({ publicBaseUrl, key: mediaKey ?? null }) ??
        (firstMedia?.source === 'giphy' ? firstMedia.url?.trim() || null : null);
      const resolvedThreadPost = threadPost ?? mediaPost;
      const threadId = params.subjectGroupId
        ? `group-${params.subjectGroupId}`
        : kind === 'follow'
          ? 'notif-follows'
          : resolvedThreadPost
            ? `post-${resolvedThreadPost.rootId ?? resolvedThreadPost.id}`
            : null;
      const postId = params.subjectArticleId
        ? null
        : kind === 'comment' || kind === 'mention'
          ? params.subjectPostId ?? params.actorPostId ?? null
          : params.actorPostId ?? params.subjectPostId ?? null;
      const groupUrl =
        currentGroup && params.subjectGroupId
          ? `/g/${currentGroup.slug || params.subjectGroupId}${
              kind === 'group_join_request' ? '/pending' : ''
            }`
          : null;
      this.delivery.sendWebPushToRecipient(recipientUserId, {
        title: pushCopy.title,
        body: pushCopy.body,
        notificationId: params.notificationId ?? undefined,
        subjectPostId: params.subjectPostId ?? null,
        subjectUserId: params.subjectUserId ?? null,
        url: params.url ?? groupUrl,
        tag: buildPushTag({
          recipientUserId,
          kind,
          actorUserId,
          subjectPostId: params.subjectPostId ?? null,
          subjectUserId: params.subjectUserId ?? null,
        }),
        icon,
        avatarUrl: icon || currentGroup?.avatarImageUrl?.trim() || null,
        mediaUrl,
        subtitle: pushSubtitle(
          kind,
          currentGroup?.name,
          params.fallbackTitle ?? null,
          params.subjectArticleId ?? null,
        ),
        threadId,
        category: pushCategory(kind, Boolean(postId)),
        actorUsername: actor?.username ?? null,
        actorName: actor?.name ?? null,
        groupInviteId: params.subjectCommunityGroupInviteId ?? null,
        postId,
        badge: '/android-chrome-192x192.png',
        renotify: true,
        kind,
        soundScope: mediaPost?.kind === "board" ? "board" : params.subjectGroupId || activityGroupId ? "group" : undefined,
        actorUserId,
        ...(params.sourceLabel ? { sourceLabel: params.sourceLabel } : {}),
      }).catch((err) => {
        this.logger.warn(`[push] Failed to send web push (${kind}): ${err instanceof Error ? err.message : String(err)}`);
      });
    } catch (err) {
      this.logger.debug(`[push] Failed to evaluate push preferences (${kind}): ${err}`);
    }
  }
}

