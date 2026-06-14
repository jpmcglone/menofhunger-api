import { Injectable } from '@nestjs/common';
import { type NotificationKind, type VerifiedStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfigService } from '../app/app-config.service';
import { publicAssetUrl } from '../../common/assets/public-asset-url';
import { createdAtIdCursorWhere } from '../../common/pagination/created-at-id-cursor';
import { PostVisibilityReadService } from '../viewer/post-visibility-read.service';
import { NotificationReadStateService } from './notification-read-state.service';
import type { NotificationActorDto, NotificationDto, SubjectPostPreviewDto, SubjectArticlePreviewDto, SubjectPostVisibility, SubjectTier } from './notification.dto';
import type {
  FollowedPostsRollupDto,
  NotificationFeedItemDto,
  NotificationGroupDto,
  NotificationGroupKind,
} from '../../common/dto/notification-feed.dto';
import type { PostDto } from '../../common/dto/post.dto';
import { collapseFeedByRoot, type FeedCollapseMode, type FeedCollapsePrefer } from '../../common/feed-collapse/collapse-by-root';

/**
 * Kinds that have dedicated filter chips on the notifications page.
 * "Other" = every kind that is NOT in this set and NOT 'message'.
 */
const PRIMARY_NOTIFICATION_KINDS = ['comment', 'mention', 'followed_post', 'follow', 'boost'] as const satisfies NotificationKind[];

/**
 * Notification feed reads: the bell list (with grouping + rollups), the
 * new-posts feed, and per-row DTO composition (also used by the writer for
 * realtime `notifications:new` payloads).
 */
@Injectable()
export class NotificationQueryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly appConfig: AppConfigService,
    private readonly postVisibility: PostVisibilityReadService,
    private readonly readState: NotificationReadStateService,
  ) {}

  notificationPostId(
    n: { kind: NotificationKind; actorPostId?: string | null; subjectPostId?: string | null },
  ): string | null {
    if (n.kind === 'followed_post') return (n.subjectPostId ?? '').trim() || null;
    if (n.kind === 'comment') return (n.actorPostId ?? '').trim() || null;
    if (n.kind === 'mention') return (n.actorPostId ?? '').trim() || null;
    if (n.kind === 'repost') return (n.actorPostId ?? n.subjectPostId ?? '').trim() || null;
    return null;
  }

  async list(params: {
    recipientUserId: string;
    limit: number;
    cursor: string | null;
    kind?: NotificationKind | 'other';
  }) {
    const { recipientUserId, limit, cursor, kind } = params;
    const desiredItemLimit = Math.max(1, Math.min(limit, 50));
    const maxGroupNotifications = 50;
    const rawFetchLimit = Math.min(desiredItemLimit * 6, 250);
    if (kind === 'message') {
      const [undeliveredCount, unreadByKind] = await Promise.all([
        this.readState.getUndeliveredCount(recipientUserId),
        this.readState.getUnreadCountsByKind(recipientUserId),
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
        ...(kind === 'other'
          ? { kind: { notIn: [...PRIMARY_NOTIFICATION_KINDS, 'message' as const] } }
          : kind
            ? { kind }
            : { kind: { not: 'message' as const } }),
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
      this.readState.getUndeliveredCount(recipientUserId),
      this.readState.getUnreadCountsByKind(recipientUserId),
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

    const notificationPostIds = [
      ...new Set(
        raw
          .flatMap((n) => {
            const primary = this.notificationPostId(n);
            const fallback = n.kind === 'repost' ? n.subjectPostId : null;
            return [primary, fallback].filter(Boolean);
          })
          .filter(Boolean),
      ),
    ] as string[];
    const notificationPostDtoById =
      notificationPostIds.length > 0
        ? await this.postVisibility.getVisiblePostsByIds({
            viewerUserId: recipientUserId,
            ids: notificationPostIds,
            includeDeleted: false,
            excludeBannedAuthors: true,
          }).then((posts) => this.postVisibility.composePostDtoMapForViewer(recipientUserId, posts))
        : new Map<string, PostDto>();

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
    // same time so the row can say "invited you to The Iron Men".
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
      const notificationPostId = this.notificationPostId(n);
      const notificationPost =
        (notificationPostId ? notificationPostDtoById.get(notificationPostId) ?? null : null)
        ?? (n.kind === 'repost' && n.subjectPostId ? notificationPostDtoById.get(n.subjectPostId) ?? null : null);
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
        notificationPost,
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

      if (n.post && (n.kind === 'followed_post' || n.kind === 'comment' || n.kind === 'mention' || n.kind === 'repost')) {
        items.push({ type: 'single', notification: n });
        i += 1;
        continue;
      }
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

    const visiblePosts = await this.postVisibility.getVisiblePostsByIds({
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

    const postDtoById = await this.postVisibility.composePostDtoMapForViewer(recipientUserId, pagePosts);

    return {
      posts: pagePosts.map((p) => postDtoById.get(p.id)).filter((p): p is PostDto => Boolean(p)),
      nextCursor,
    };
  }

  toNotificationDto(
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
        verifiedStatus: VerifiedStatus;
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
    post: PostDto | null = null,
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
      post: post ?? null,
      subjectArticlePreview: subjectArticlePreview ?? null,
      subjectPostVisibility,
      subjectTier,
    };
  }

  /** Hydrate a single notification row into its full DTO (used for realtime `notifications:new`). */
  async buildNotificationDtoForRecipient(params: {
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
    let post: PostDto | null = null;

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

    const notificationPostId = this.notificationPostId(n);
    const notificationPostIds = [
      notificationPostId,
      n.kind === 'repost' ? n.subjectPostId : null,
    ].filter((postId, index, arr): postId is string => Boolean(postId) && arr.indexOf(postId) === index);
    if (notificationPostIds.length > 0) {
      const visiblePosts = await this.postVisibility.getVisiblePostsByIds({
        viewerUserId: recipientUserId,
        ids: notificationPostIds,
        includeDeleted: false,
        excludeBannedAuthors: true,
      });
      const postDtoById = await this.postVisibility.composePostDtoMapForViewer(recipientUserId, visiblePosts);
      post =
        (notificationPostId ? postDtoById.get(notificationPostId) ?? null : null)
        ?? (n.kind === 'repost' && n.subjectPostId ? postDtoById.get(n.subjectPostId) ?? null : null);
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
      post,
    );
  }
}
