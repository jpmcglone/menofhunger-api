import { findGroupNotificationPreference } from '../viewer/group-membership.queries';
import type { AvatarVideoDto } from '../../common/dto/avatar-video.dto';
import { publicAssetUrl } from '../../common/assets/public-asset-url';
import type { NotificationKind } from '@prisma/client';
import { permitsFollowNotification } from './follow-notification-policy';
import type { NotificationPushService } from './notification-push.service';

/** Person-accountability pushes. Pages inherit operator premium and would otherwise get these on the operator's phone. */
const PERSON_ONLY_PUSH_KINDS = new Set<NotificationKind>([
  'word_of_the_day',
  'quote_of_the_day',
  'checkin_reminder',
  'on_this_day',
  'checkin_post',
  'nudge',
]);

export async function sendWebPushToRecipientOn(host: NotificationPushService, 
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
    subtitle?: string | null;
    threadId?: string | null;
    category?: string | null;
    avatarUrl?: string | null; avatarVideo?: AvatarVideoDto | null;
    mediaUrl?: string | null;
    actorUsername?: string | null;
    actorName?: string | null;
    groupInviteId?: string | null;
    postId?: string | null;
    /** When the recipient is a page, skip this actor if they operate it. */
    actorUserId?: string | null;
    /** Protected destinations re-authorize immediately before each network delivery. */
    canDeliver?: () => Promise<boolean>;
  },
): Promise<void> {
  if (!host.pushChannelConfigured()) return;
  if (params.canDeliver && !await params.canDeliver()) return;
  const kind = params.kind ?? 'generic';

  const baseUrl =
    host.appConfig.pushFrontendBaseUrl() ??
    host.appConfig.allowedOrigins()[0]?.trim() ??
    'https://menofhunger.com';
  const safeBase = baseUrl.replace(/\/$/, '');
  let url = params.url?.trim() || `${safeBase}/notifications`;
  if (!params.url && params.subjectPostId) {
    url = `${safeBase}/p/${params.subjectPostId}`;
  } else if (!params.url && params.subjectUserId) {
    const subjectUser = await host.prisma.user.findUnique({
      where: { id: params.subjectUserId },
      select: { username: true },
    });
    const username = (subjectUser?.username ?? '').trim();
    if (username) {
      url = `${safeBase}/u/${encodeURIComponent(username)}`;
    }
  }

  // Resolve tag before coalesce check so the key is subject-scoped, not kind-only.
  const defaultTag = params.test ? `notification-test-${Date.now()}` : `notification-${recipientUserId}`;
  const tag = params.tag?.trim() || defaultTag;

  if (!params.test && (await host.isPushCoalesced(recipientUserId, tag, kind))) {
    host.logger.debug(`[push] Coalesced ${kind} (tag=${tag}) for user ${recipientUserId}`);
    return;
  }

  // Distinguish "explicit empty body" (e.g. reply-nudge that's title-only) from "no body provided"
  // (legacy callers that want the friendly fallback).
  let body = params.body === undefined ? 'You have a new notification.' : params.body;
  if (params.sourceLabel) {
    body = body ? `${body} · ${params.sourceLabel}` : params.sourceLabel;
  }

  const recipient = await host.prisma.user.findUnique({
    where: { id: recipientUserId },
    select: { accountKind: true, username: true },
  });
  if (recipient?.accountKind === 'page' && PERSON_ONLY_PUSH_KINDS.has(kind as NotificationKind)) {
    host.logger.debug(`[push] Skipping ${kind} for page ${recipientUserId}`);
    return;
  }
  const actorUserId = (params.actorUserId ?? '').trim();
  const tokenOwners = (
    await host.tokenOwnersForRecipient(recipientUserId, recipient?.accountKind)
  ).filter((ownerId) => !actorUserId || ownerId !== actorUserId);
  if (tokenOwners.length === 0) {
    host.logger.debug(`[push] No token owners for ${kind} after excluding actor`);
    return;
  }
  const recipientUsername = (recipient?.username ?? '').trim() || null;

  const titleForOwner = (tokenOwnerId: string) => {
    if (tokenOwnerId === recipientUserId || !recipientUsername) return params.title;
    return `@${recipientUsername} · ${params.title}`;
  };

  // iOS / APNs: always deliver. The app's UNUserNotificationCenterDelegate decides
  // whether to surface a banner when foregrounded — that is a client-side concern.
  if (host.apnsPush.configured()) {
    const apnsBody = host.apnsBodyWithVisibleAction({
      kind,
      body: body ?? '',
      subtitle: params.subtitle ?? null,
      actorUsername: params.actorUsername ?? null,
    });
    for (const tokenOwnerId of tokenOwners) {
      const delivery = host.apnsPush
        .sendToUser(tokenOwnerId, {
          title: titleForOwner(tokenOwnerId),
          body: apnsBody,
          url,
          notificationId: params.notificationId ?? null,
          kind,
          collapseId: tag,
          mutableContent: Boolean(params.avatarUrl || params.mediaUrl || params.actorUsername),
          subtitle: params.subtitle ?? null,
          threadId: params.threadId ?? null,
          category: params.category ?? null,
          avatarUrl: params.avatarUrl ?? null,
          mediaUrl: params.mediaUrl ?? null,
          actorUsername: params.actorUsername ?? null,
          actorName: params.actorName ?? null,
          groupInviteId: params.groupInviteId ?? null,
          postId: params.postId ?? null,
          recipientUserId,
          recipientUsername,
          canDeliver: params.canDeliver,
        })
        .catch((err) => {
          if (params.canDeliver) throw err;
          host.logger.warn(`[apns] Failed to send push (${kind}): ${err instanceof Error ? err.message : String(err)}`);
        });
      if (params.canDeliver) await delivery;
    }
  }

  for (const tokenOwnerId of tokenOwners) {
    await host.sendWebPushOnly(tokenOwnerId, {
      canDeliver: params.canDeliver,
      payload: JSON.stringify({
        title: titleForOwner(tokenOwnerId),
        body,
        notificationId: params.notificationId ?? undefined,
        url,
        tag,
        kind,
        icon: params.icon ?? undefined,
        badge: params.badge ?? '/android-chrome-192x192.png',
        renotify: Boolean(params.renotify),
        test: params.test === true,
        recipientUserId,
        recipientUsername,
      }),
    });
  }

  if (!params.test) {
    await host.recordPushSent(recipientUserId, tag).catch(() => {});
  }
}



export async function sendKindPushForActorOn(host: NotificationPushService, params: {
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
    const prefs = await host.preferences.getPreferencesInternal(recipientUserId);
    if (!host.shouldSendPushForKind(prefs, kind)) return;
    if (!(await permitsFollowNotification({ follow: host.prisma.follow, post: host.postsRead.read }, params))) return;
    const mediaPostId = params.actorPostId ?? params.subjectPostId ?? null;
    const threadPostId = params.subjectPostId ?? params.actorPostId ?? null;
    const [actor, mediaPost, threadPost, group] = await Promise.all([
      actorUserId ? host.getActorMini(actorUserId) : null,
      mediaPostId
        ? host.postsRead.read.findUnique({
            where: { id: mediaPostId },
            select: {
              id: true,
              deletedAt: true,
              rootId: true,
              communityGroupId: true,
              media: {
                where: { deletedAt: null },
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
        ? host.postsRead.read.findUnique({
            where: { id: threadPostId },
            select: { id: true, deletedAt: true, rootId: true },
          })
        : null,
      params.subjectGroupId
        ? host.prisma.communityGroup.findUnique({
            where: { id: params.subjectGroupId },
            select: { slug: true, name: true, avatarImageUrl: true, deletedAt: true },
          })
        : null,
    ]);
    // Re-check at delivery time: queued pushes may outlive a preference change.
    const activityGroupId = mediaPost?.communityGroupId;
    if (activityGroupId && ['comment', 'mention', 'boost', 'repost', 'followed_post', 'community_group_post'].includes(kind)) {
      const member = await findGroupNotificationPreference(host.prisma, activityGroupId, recipientUserId);
      if (member?.notificationPreference === 'muted') return;
      if (member?.notificationPreference === 'repliesAndMentions' && kind !== 'comment' && kind !== 'mention') return;
    }
    const pushCopy = host.buildPushCopy({
      kind,
      actor,
      fallbackTitle: params.fallbackTitle ?? null,
      body: params.body ?? null,
      subjectArticleId: params.subjectArticleId ?? null,
    });
    const publicBaseUrl = host.appConfig.r2()?.publicBaseUrl ?? null;
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
    host.sendWebPushToRecipient(recipientUserId, {
      title: pushCopy.title,
      body: pushCopy.body,
      notificationId: params.notificationId ?? undefined,
      subjectPostId: params.subjectPostId ?? null,
      subjectUserId: params.subjectUserId ?? null,
      url: params.url ?? groupUrl,
      tag: host.buildPushTag({
        recipientUserId,
        kind,
        actorUserId,
        subjectPostId: params.subjectPostId ?? null,
        subjectUserId: params.subjectUserId ?? null,
      }),
      icon,
      avatarUrl: icon || currentGroup?.avatarImageUrl?.trim() || null,
      mediaUrl,
      subtitle: host.pushSubtitle(
        kind,
        currentGroup?.name,
        params.fallbackTitle ?? null,
        params.subjectArticleId ?? null,
      ),
      threadId,
      category: host.pushCategory(kind, Boolean(postId)),
      actorUsername: actor?.username ?? null,
      actorName: actor?.name ?? null,
      groupInviteId: params.subjectCommunityGroupInviteId ?? null,
      postId,
      badge: '/android-chrome-192x192.png',
      renotify: true,
      kind,
      actorUserId,
      ...(params.sourceLabel ? { sourceLabel: params.sourceLabel } : {}),
    }).catch((err) => {
      host.logger.warn(`[push] Failed to send web push (${kind}): ${err instanceof Error ? err.message : String(err)}`);
    });
  } catch (err) {
    host.logger.debug(`[push] Failed to evaluate push preferences (${kind}): ${err}`);
  }
}
