import { clampLimit } from '../../common/pagination/page';
import { USER_BRIEF_SELECT } from '../../common/prisma-selects/user.select';
import { Injectable, Optional } from "@nestjs/common";
import { NotificationQueryListService, NOTIFICATION_POST_CARD_KINDS } from './notification-query-list.service';
import { type NotificationKind } from "@prisma/client";
import { MutesService } from "../mutes/mutes.service";
import { PrismaService } from "../prisma/prisma.service";
import { AppConfigService } from "../app/app-config.service";
import { publicAssetUrl } from "../../common/assets/public-asset-url";
import { createdAtIdCursorWhere } from "../../common/pagination/created-at-id-cursor";
import { PostVisibilityReadService } from "../viewer/post-visibility-read.service";
import { NotificationReadStateService } from "./notification-read-state.service";
import { CacheService } from "../redis/cache.service";
import { CacheInvalidationService } from "../redis/cache-invalidation.service";
import { CacheTtl } from "../redis/cache-ttl";
import { RedisKeys, stableJsonHash } from "../redis/redis-keys";
import type { NotificationDto, SubjectPostPreviewDto, SubjectPostVisibility, SubjectTier } from "./notification.dto";
import type { PostDto } from "../../common/dto/post.dto";
import { collapseFeedByRoot, type FeedCollapseMode, type FeedCollapsePrefer } from "../../common/feed-collapse/collapse-by-root";
import { PostsReadService } from '../posts-read/posts-read.service';
import { notificationPostId as postIdOf, toNotificationDto } from './notification-query.mapper';
import { NOT_DELETED } from '../../common/prisma/where';
/**
 * Notification feed reads: the bell list (with grouping), the
 * new-posts feed, and per-row DTO composition (also used by the writer for
 * realtime `notifications:new` payloads).
 */
@Injectable()
export class NotificationQueryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly postsRead: PostsReadService,
    private readonly appConfig: AppConfigService,
    private readonly postVisibility: PostVisibilityReadService,
    private readonly readState: NotificationReadStateService,
    private readonly listing: NotificationQueryListService,
    private readonly cache?: CacheService,
    private readonly cacheInvalidation?: CacheInvalidationService,
    @Optional() private readonly mutes?: MutesService,
  ) {}

  async list(params: {
    recipientUserId: string;
    limit: number;
    cursor: string | null;
    kind?: NotificationKind | "other" | "board" | "articles";
    unreadOnly?: boolean;
    boardCommentsOnly?: boolean;
  }) {
    const firstPage = !(params.cursor ?? "").trim();
    if (!firstPage || !this.cache || !this.cacheInvalidation) {
      return this.listUncached(params);
    }

    const ver = await this.cacheInvalidation.notificationsListVersion(
      params.recipientUserId,
    );
    const paramsHash = stableJsonHash({
      limit: params.limit,
      kind: params.kind ?? null,
      unreadOnly: params.unreadOnly === true,
      boardCommentsOnly: params.boardCommentsOnly === true,
      // Bump when Posts/Replies chip predicates change so stale page-1 caches miss.
      categories: 2,
    });
    return this.cache.getOrSetJsonWithLock({
      enabled: true,
      key: RedisKeys.notificationsList(params.recipientUserId, paramsHash, ver),
      ttlSeconds: CacheTtl.authNotificationsPage1Seconds,
      lockKey: RedisKeys.notificationsListLock(
        params.recipientUserId,
        paramsHash,
        ver,
      ),
      lockTtlMs: 10_000,
      lockWaitMs: 750,
      computeAndSet: () => this.listUncached(params),
      fallback: () => this.listUncached(params),
    });
  }

  async listUncached(params: {
    recipientUserId: string;
    limit: number;
    cursor: string | null;
    kind?: NotificationKind | "other" | "board" | "articles";
    unreadOnly?: boolean;
    boardCommentsOnly?: boolean;
  }) {
    return this.listing.listUncached(params);
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
    const desiredPostLimit = clampLimit(limit, { default: 50, max: 50 });
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
      where: {
        OR: [{ blockerId: recipientUserId }, { blockedId: recipientUserId }],
      },
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
      .map((r) => (r.followingId ?? "").trim())
      .filter(Boolean);

    const notifications = await this.prisma.notification.findMany({
      where: {
        recipientUserId,
        OR: [
          // Canonical "new post from someone you follow".
          { kind: "followed_post", subjectPostId: { not: null } },
          { kind: "checkin_post", subjectPostId: { not: null } },
          // Replies can show up as comment/mention notifications for the same action.
          // Include them when the actor is someone the viewer follows so /new-posts
          // remains "posts from followed users", regardless of notification kind.
          ...(followedActorIds.length > 0
            ? [
                {
                  kind: "comment" as const,
                  actorPostId: { not: null },
                  actorUserId: { in: followedActorIds },
                },
                {
                  kind: "mention" as const,
                  actorPostId: { not: null },
                  actorUserId: { in: followedActorIds },
                },
              ]
            : []),
        ],
        ...(blockedActorIds.length > 0
          ? {
              NOT: {
                AND: [
                  { actorUserId: { not: null } },
                  { actorUserId: { in: blockedActorIds } },
                ],
              },
            }
          : {}),
        ...(cursorWhere ? { AND: [cursorWhere] } : {}),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: rawFetchLimit + 1,
      select: { id: true, kind: true, subjectPostId: true, actorPostId: true },
    });

    const raw = notifications.slice(0, rawFetchLimit);
    const hasMoreRaw = notifications.length > rawFetchLimit;

    const orderedSubjectPostIds: string[] = [];
    const seenSubjectPostIds = new Set<string>();
    for (const n of raw) {
      const postId = (
        n.kind === "followed_post" ||
        n.kind === "checkin_post" ||
        n.kind === "community_group_post"
          ? (n.subjectPostId ?? "")
          : (n.actorPostId ?? "")
      ).trim();
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
    const { items: collapsedVisiblePosts } = collapseFeedByRoot(
      orderedVisiblePosts,
      {
        collapseByRoot: params.collapseByRoot ?? false,
        collapseMode: params.collapseMode ?? "root",
        prefer: params.prefer ?? "reply",
        getId: (post) => post.id,
        getParentId: (post) => post.parentId ?? null,
      },
    );
    const pagePosts = collapsedVisiblePosts.slice(0, desiredPostLimit);
    const returnedPostIds = new Set(pagePosts.map((p) => p.id));

    let boundaryIndex = -1;
    for (let i = 0; i < raw.length; i++) {
      const row = raw[i];
      const postId = (
        row?.kind === "followed_post" || row?.kind === "checkin_post"
          ? (row?.subjectPostId ?? "")
          : (row?.actorPostId ?? "")
      ).trim();
      if (postId && returnedPostIds.has(postId)) boundaryIndex = i;
    }
    if (boundaryIndex < 0 && raw.length > 0) boundaryIndex = raw.length - 1;

    const hasMore =
      hasMoreRaw || (boundaryIndex >= 0 && boundaryIndex < raw.length - 1);
    const nextCursor =
      hasMore && boundaryIndex >= 0 ? raw[boundaryIndex]!.id : null;

    if (pagePosts.length === 0) {
      return { posts: [], nextCursor };
    }

    const postDtoById = await this.postVisibility.composePostDtoMapForViewer(
      recipientUserId,
      pagePosts,
    );

    return {
      posts: pagePosts
        .map((p) => postDtoById.get(p.id))
        .filter((p): p is PostDto => Boolean(p)),
      nextCursor,
    };
  }

  /** Hydrate a single notification row into its full DTO (used for realtime `notifications:new`). */
  async buildNotificationDtoForRecipient(params: {
    recipientUserId: string;
    notificationId: string;
  }): Promise<NotificationDto | null> {
    const { recipientUserId, notificationId } = params;
    const id = (notificationId ?? "").trim();
    if (!id) return null;

    const blockSets =
      await this.postVisibility.viewerBlockSets(recipientUserId);
    const blockedActorIds = [
      ...blockSets.blockedByViewer,
      ...blockSets.viewerBlockedBy,
    ];
    const n = await this.prisma.notification.findFirst({
      where: {
        id,
        recipientUserId,
        ...(blockedActorIds.length
          ? {
              NOT: {
                AND: [
                  { actorUserId: { not: null } },
                  { actorUserId: { in: blockedActorIds } },
                ],
              },
            }
          : {}),
      },
      include: {
        subjectPost: {
          select: { id: true, parentId: true, kind: true, rootId: true },
        },
        actorPost: {
          select: { id: true, parentId: true, kind: true, rootId: true },
        },
        actor: {
          select: {
            ...USER_BRIEF_SELECT,
            avatarKey: true,
            avatarVideoKey: true,
            avatarVideoDurationMs: true,
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
      n.kind === "repost" && n.actorPostId ? n.actorPostId : null,
      n.subjectPostId,
    ].filter(
      (postId, index, arr): postId is string =>
        Boolean(postId) && arr.indexOf(postId) === index,
    );
    if (previewPostIds.length > 0) {
      const posts = await this.postsRead.findMany({
        where: { id: { in: previewPostIds } },
        select: {
          id: true,
          body: true,
          kind: true,
          visibility: true,
          media: {
            where: NOT_DELETED,
            orderBy: { position: "asc" },
            select: {
              kind: true,
              r2Key: true,
              thumbnailR2Key: true,
              url: true,
            },
          },
        },
      });
      const postById = new Map(posts.map((post) => [post.id, post] as const));
      const actorPost =
        n.kind === "repost" && n.actorPostId
          ? (postById.get(n.actorPostId) ?? null)
          : null;
      const actorBodySnippet =
        (actorPost?.body ?? "").trim().slice(0, 150) || null;
      const actorHasMedia = Boolean(
        actorPost?.media?.some((m) => {
          const url =
            (m as { url?: string }).url?.trim() ||
            (publicAssetUrl({
              publicBaseUrl,
              key: (m as { r2Key?: string }).r2Key ?? null,
            }) ??
              "");
          return Boolean(url);
        }),
      );
      const p =
        actorBodySnippet || actorHasMedia
          ? actorPost
          : n.subjectPostId
            ? (postById.get(n.subjectPostId) ?? null)
            : actorPost;
      if (p) {
        const bodySnippet = (p.body ?? "").trim().slice(0, 150) || null;
        const media = (p.media ?? [])
          .map((m) => {
            const url =
              (m as { url?: string }).url?.trim() ||
              (publicAssetUrl({
                publicBaseUrl,
                key: (m as { r2Key?: string }).r2Key ?? null,
              }) ??
                "");
            const thumbnailUrl =
              (publicAssetUrl({
                publicBaseUrl,
                key: (m as { thumbnailR2Key?: string }).thumbnailR2Key ?? null,
              }) ??
                null) ||
              null;
            return {
              url: url || "",
              thumbnailUrl,
              kind: (m as { kind: string }).kind,
            };
          })
          .filter((m) => m.url);
        subjectPostPreview = {
          bodySnippet,
          media,
          kind: (p as { kind?: string }).kind ?? null,
        };
        const vis = (p as { visibility?: string }).visibility;
        subjectTier =
          vis === "premiumOnly"
            ? "premium"
            : vis === "verifiedOnly"
              ? "verified"
              : null;
        if (
          vis === "public" ||
          vis === "verifiedOnly" ||
          vis === "premiumOnly" ||
          vis === "onlyMe"
        ) {
          subjectPostVisibility = vis;
        }
      }
    } else if (n.subjectUserId) {
      const u = await this.prisma.user.findUnique({
        where: { id: n.subjectUserId },
        select: { id: true, premium: true, verifiedStatus: true },
      });
      if (u) {
        subjectTier = u.premium
          ? "premium"
          : u.verifiedStatus !== "none"
            ? "verified"
            : null;
      }
    }

    const notificationPostId = postIdOf(n);
    const notificationPostIds = NOTIFICATION_POST_CARD_KINDS.has(n.kind)
      ? [
          notificationPostId,
          n.kind === "repost" ? n.subjectPostId : null,
        ].filter(
          (postId, index, arr): postId is string =>
            Boolean(postId) && arr.indexOf(postId) === index,
        )
      : [];
    if (notificationPostIds.length > 0) {
      const visiblePosts = await this.postVisibility.getVisiblePostsByIds({
        viewerUserId: recipientUserId,
        ids: notificationPostIds,
        includeDeleted: false,
        excludeBannedAuthors: true,
      });
      const postDtoById = await this.postVisibility.composePostDtoMapForViewer(
        recipientUserId,
        visiblePosts,
      );
      post =
        (notificationPostId
          ? (postDtoById.get(notificationPostId) ?? null)
          : null) ??
        (n.kind === "repost" && n.subjectPostId
          ? (postDtoById.get(n.subjectPostId) ?? null)
          : null);
    }

    let subjectGroupSlug: string | null = null;
    let subjectGroupName: string | null = null;
    let subjectGroupAvatarUrl: string | null = null;
    if (n.subjectGroupId) {
      const g = await this.prisma.communityGroup.findUnique({
        where: { id: n.subjectGroupId },
        select: { slug: true, name: true, avatarImageUrl: true },
      });
      subjectGroupSlug = g?.slug ?? null;
      subjectGroupName = g?.name ?? null;
      subjectGroupAvatarUrl = g?.avatarImageUrl ?? null;
    }

    let subjectCrewInviteStatus: NotificationDto["subjectCrewInviteStatus"] =
      null;
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
      const candidate = (inv?.crew?.name ?? inv?.crewNameOnAccept ?? "").trim();
      if (candidate) subjectCrewName = candidate;
    }
    if (!subjectCrewName && n.subjectCrewId) {
      const c = await this.prisma.crew.findUnique({
        where: { id: n.subjectCrewId },
        select: { name: true },
      });
      const candidate = (c?.name ?? "").trim();
      if (candidate) subjectCrewName = candidate;
    }

    let subjectCommunityGroupInviteStatus: NotificationDto["subjectCommunityGroupInviteStatus"] =
      null;
    if (n.subjectCommunityGroupInviteId) {
      const inv = await this.prisma.communityGroupInvite.findUnique({
        where: { id: n.subjectCommunityGroupInviteId },
        select: { status: true },
      });
      subjectCommunityGroupInviteStatus = inv?.status ?? null;
    }

    let subjectSpaceOwnerUsername: string | null = null;
    if (n.subjectSpaceId) {
      const space = await this.prisma.space.findUnique({
        where: { id: n.subjectSpaceId },
        select: { owner: { select: { username: true } } },
      });
      subjectSpaceOwnerUsername = (space?.owner?.username ?? "").trim() || null;
    }

    return toNotificationDto(
      n,
      publicBaseUrl,
      subjectPostPreview,
      subjectPostVisibility,
      subjectTier,
      undefined,
      subjectGroupSlug,
      subjectGroupName,
      subjectGroupAvatarUrl,
      subjectCrewInviteStatus,
      subjectCrewName,
      subjectCommunityGroupInviteStatus,
      post,
      subjectSpaceOwnerUsername,
    );
  }
}

export { boardNotificationRefs } from './notification-query.mapper';
