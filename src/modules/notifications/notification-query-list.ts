import type { NotificationKind } from "@prisma/client";
import { publicAssetUrl } from "../../common/assets/public-asset-url";
import { createdAtIdCursorWhere } from "../../common/pagination/created-at-id-cursor";
import {
  boardActivityWhere,
  notificationCategoryCounts,
  notificationFilterWhere,
} from "./notification-category";
import type {
  NotificationFeedItemDto,
  NotificationGroupDto,
  NotificationGroupKind,
} from "../../common/dto/notification-feed.dto";
import type {
  NotificationActorDto,
  NotificationDto,
  SubjectArticlePreviewDto,
  SubjectPostPreviewDto,
  SubjectPostVisibility,
  SubjectTier,
} from "./notification.dto";
import type { PostDto } from "../../common/dto/post.dto";
import type { NotificationQueryService } from "./notification-query.service";

/** Kinds that embed a full PostDto card in the bell. Everything else uses subjectPostPreview. */
export const NOTIFICATION_POST_CARD_KINDS = new Set<NotificationKind>([
  "comment",
  "mention",
  "followed_post",
  "checkin_post",
  "community_group_post",
  "repost",
]);

export async function listUncachedOn(host: NotificationQueryService, params: {
  recipientUserId: string;
  limit: number;
  cursor: string | null;
  kind?: NotificationKind | "other" | "board" | "articles";
  unreadOnly?: boolean;
  boardCommentsOnly?: boolean;
}) {
  const { recipientUserId, limit, cursor, kind } = params;
  const desiredItemLimit = Math.max(1, Math.min(limit, 50));
  const maxGroupNotifications = 50;
  const rawFetchLimit = Math.min(desiredItemLimit * 6, 250);
  const [cursorWhere, blockSets, mutedIds] = await Promise.all([
    createdAtIdCursorWhere({
      cursor,
      lookup: async (id) =>
        host.prisma.notification
          .findUnique({
            where: { id, recipientUserId },
            select: { id: true, createdAt: true },
          })
          .then((r) => (r ? { id: r.id, createdAt: r.createdAt } : null)),
    }),
    host.postVisibility.viewerBlockSets(recipientUserId),
    host.mutes
      ? host.mutes.mutedIds(recipientUserId)
      : Promise.resolve(new Set<string>()),
  ]);
  const blockedActorIds = [
    ...blockSets.blockedByViewer,
    ...blockSets.viewerBlockedBy,
    ...mutedIds,
  ];
  const notifications = await host.prisma.notification.findMany({
    where: {
      recipientUserId,
      ...notificationFilterWhere(kind),
      ...(params.boardCommentsOnly ? { kind: { in: ["comment", "mention", "followed_post"] as NotificationKind[] }, OR: [
        { actorPost: { is: { kind: "board" as const, parentId: { not: null } } } },
        { kind: "followed_post" as const, subjectPost: { is: { kind: "board" as const, parentId: { not: null } } } },
      ] } : {}),
      ...(params.unreadOnly ? { readAt: null } : {}),
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
      // Board owns its comments and mentions; they appear only in Board's own activity feed.
      AND: [
        ...(cursorWhere ? [cursorWhere] : []),
        ...(kind === "board" || params.boardCommentsOnly
          ? []
          : [{ NOT: boardActivityWhere() }]),
      ],
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
          id: true,
          username: true,
          name: true,
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
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: rawFetchLimit + 1,
  });

  const raw = notifications.slice(0, rawFetchLimit);
  const hasMoreRaw = notifications.length > rawFetchLimit;
  const [undeliveredCount, unreadByKind] = await Promise.all([
    host.readState.getUndeliveredCount(recipientUserId),
    host.readState.getUnreadCountsByKind(recipientUserId, blockedActorIds),
  ]);

  const followedReplies = await host.prisma.notification.count({
    where: {
      recipientUserId,
      readAt: null,
      kind: "followed_post",
      subjectPost: { is: { parentId: { not: null } } },
      AND: [{ NOT: boardActivityWhere() }],
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
  });
  const unreadByCategory = notificationCategoryCounts(
    unreadByKind,
    followedReplies ?? 0,
  );

  const publicBaseUrl = host.appConfig.r2()?.publicBaseUrl ?? null;
  const previewPostIds = [
    ...new Set(
      raw
        .flatMap((n) =>
          n.kind === "repost" && n.actorPostId
            ? [n.actorPostId, n.subjectPostId]
            : [n.subjectPostId],
        )
        .filter(Boolean),
    ),
  ] as string[];
  const subjectUserIds = [
    ...new Set(raw.map((n) => n.subjectUserId).filter(Boolean)),
  ] as string[];
  const subjectArticleIds = [
    ...new Set(
      raw
        .filter((n) => n.kind === "followed_article" && n.subjectArticleId)
        .map((n) => n.subjectArticleId as string),
    ),
  ];
  const notificationPostIds = [
    ...new Set(
      raw
        .flatMap((n) => {
          if (!NOTIFICATION_POST_CARD_KINDS.has(n.kind)) return [];
          const primary = host.notificationPostId(n);
          const fallback = n.kind === "repost" ? n.subjectPostId : null;
          return [primary, fallback].filter(Boolean);
        })
        .filter(Boolean),
    ),
  ] as string[];
  const subjectGroupIds = [
    ...new Set(
      raw
        .filter((n) => Boolean(n.subjectGroupId))
        .map((n) => n.subjectGroupId as string),
    ),
  ];
  const subjectCrewInviteIds = [
    ...new Set(
      raw.map((n) => n.subjectCrewInviteId).filter(Boolean) as string[],
    ),
  ];
  const subjectCrewIds = [
    ...new Set(
      raw
        .filter((n) => n.subjectCrewId && !n.subjectCrewInviteId)
        .map((n) => n.subjectCrewId as string),
    ),
  ];
  const subjectCommunityGroupInviteIds = [
    ...new Set(
      raw
        .map((n) => n.subjectCommunityGroupInviteId)
        .filter(Boolean) as string[],
    ),
  ];
  const subjectSpaceIds = [
    ...new Set(raw.map((n) => n.subjectSpaceId).filter(Boolean) as string[]),
  ];

  const [
    subjectPosts,
    subjectUsers,
    subjectArticles,
    notificationPostDtoById,
    subjectGroups,
    subjectCrewInvites,
    subjectCrews,
    subjectCommunityGroupInvites,
    subjectSpaces,
  ] = await Promise.all([
    previewPostIds.length > 0
      ? host.postsRead.read.findMany({
          where: { id: { in: previewPostIds } },
          select: {
            id: true,
            body: true,
            visibility: true,
            media: {
              where: { deletedAt: null },
              orderBy: { position: "asc" },
              select: {
                kind: true,
                r2Key: true,
                thumbnailR2Key: true,
                url: true,
              },
            },
          },
        })
      : Promise.resolve([]),
    subjectUserIds.length > 0
      ? host.prisma.user.findMany({
          where: { id: { in: subjectUserIds } },
          select: { id: true, premium: true, verifiedStatus: true },
        })
      : Promise.resolve([]),
    subjectArticleIds.length > 0
      ? host.prisma.article.findMany({
          where: { id: { in: subjectArticleIds } },
          select: {
            id: true,
            title: true,
            excerpt: true,
            thumbnailR2Key: true,
            visibility: true,
          },
        })
      : Promise.resolve([]),
    notificationPostIds.length > 0
      ? host.postVisibility
          .getVisiblePostsByIds({
            viewerUserId: recipientUserId,
            ids: notificationPostIds,
            includeDeleted: false,
            excludeBannedAuthors: true,
          })
          .then((posts) =>
            host.postVisibility.composePostDtoMapForViewer(
              recipientUserId,
              posts,
            ),
          )
      : Promise.resolve(new Map<string, PostDto>()),
    subjectGroupIds.length > 0
      ? host.prisma.communityGroup.findMany({
          where: { id: { in: subjectGroupIds } },
          select: { id: true, slug: true, name: true },
        })
      : Promise.resolve([]),
    subjectCrewInviteIds.length > 0
      ? host.prisma.crewInvite.findMany({
          where: { id: { in: subjectCrewInviteIds } },
          select: {
            id: true,
            status: true,
            crewNameOnAccept: true,
            crew: { select: { name: true } },
          },
        })
      : Promise.resolve([]),
    subjectCrewIds.length > 0
      ? host.prisma.crew.findMany({
          where: { id: { in: subjectCrewIds } },
          select: { id: true, name: true },
        })
      : Promise.resolve([]),
    subjectCommunityGroupInviteIds.length > 0
      ? host.prisma.communityGroupInvite.findMany({
          where: { id: { in: subjectCommunityGroupInviteIds } },
          select: { id: true, status: true },
        })
      : Promise.resolve([]),
    subjectSpaceIds.length > 0
      ? host.prisma.space.findMany({
          where: { id: { in: subjectSpaceIds } },
          select: { id: true, owner: { select: { username: true } } },
        })
      : Promise.resolve([]),
  ]);

  const subjectPreviewByPostId = new Map<string, SubjectPostPreviewDto>();
  const subjectTierByPostId = new Map<string, SubjectTier>();
  const subjectVisibilityByPostId = new Map<string, SubjectPostVisibility>();
  for (const p of subjectPosts) {
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
    subjectPreviewByPostId.set(p.id, { bodySnippet, media });
    const vis = (p as { visibility?: string }).visibility;
    subjectTierByPostId.set(
      p.id,
      vis === "premiumOnly"
        ? "premium"
        : vis === "verifiedOnly"
          ? "verified"
          : null,
    );
    if (
      vis === "public" ||
      vis === "verifiedOnly" ||
      vis === "premiumOnly" ||
      vis === "onlyMe"
    ) {
      subjectVisibilityByPostId.set(p.id, vis);
    }
  }

  const subjectTierByUserId = new Map<string, SubjectTier>();
  for (const u of subjectUsers) {
    const tier: SubjectTier = u.premium
      ? "premium"
      : u.verifiedStatus !== "none"
        ? "verified"
        : null;
    subjectTierByUserId.set(u.id, tier);
  }

  const subjectArticlePreviewById = new Map<
    string,
    SubjectArticlePreviewDto
  >();
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

  const subjectGroupById = new Map(
    subjectGroups.map((g) => [g.id, g] as const),
  );
  const subjectCrewInviteStatusById = new Map(
    subjectCrewInvites.map((inv) => [inv.id, inv.status] as const),
  );
  const subjectCrewNameByInviteId = new Map(
    subjectCrewInvites.map(
      (inv) =>
        [
          inv.id,
          ((inv.crew?.name ?? inv.crewNameOnAccept ?? "") as string).trim() ||
            null,
        ] as const,
    ),
  );
  const subjectCrewNameByCrewId = new Map(
    subjectCrews.map((c) => [c.id, (c.name ?? "").trim() || null] as const),
  );
  const subjectCommunityGroupInviteStatusById = new Map(
    subjectCommunityGroupInvites.map((inv) => [inv.id, inv.status] as const),
  );
  const subjectSpaceOwnerUsernameById = new Map(
    subjectSpaces.map(
      (s) => [s.id, (s.owner.username ?? "").trim() || null] as const,
    ),
  );

  const dtos: NotificationDto[] = raw.map((n) => {
    const actorPreview =
      n.kind === "repost" && n.actorPostId
        ? (subjectPreviewByPostId.get(n.actorPostId) ?? null)
        : null;
    const hasActorPreview = Boolean(
      actorPreview?.bodySnippet || actorPreview?.media?.length,
    );
    const previewPostId = hasActorPreview ? n.actorPostId : n.subjectPostId;
    const preview = previewPostId
      ? (subjectPreviewByPostId.get(previewPostId) ?? null)
      : null;
    const articlePreview = n.subjectArticleId
      ? (subjectArticlePreviewById.get(n.subjectArticleId) ?? null)
      : null;
    const subjectPostVisibility = previewPostId
      ? (subjectVisibilityByPostId.get(previewPostId) ?? null)
      : null;
    let subjectTier: SubjectTier = null;
    if (previewPostId)
      subjectTier = subjectTierByPostId.get(previewPostId) ?? null;
    else if (n.subjectUserId)
      subjectTier = subjectTierByUserId.get(n.subjectUserId) ?? null;
    const subjectGroup = n.subjectGroupId
      ? (subjectGroupById.get(n.subjectGroupId) ?? null)
      : null;
    const subjectCrewInviteStatus = n.subjectCrewInviteId
      ? (subjectCrewInviteStatusById.get(n.subjectCrewInviteId) ?? null)
      : null;
    // Prefer the live crew name; fall back to the founding invite's
    // `crewNameOnAccept` so even pre-accept invites show the chosen name.
    const subjectCrewName = n.subjectCrewId
      ? (subjectCrewNameByCrewId.get(n.subjectCrewId) ?? null)
      : n.subjectCrewInviteId
        ? (subjectCrewNameByInviteId.get(n.subjectCrewInviteId) ?? null)
        : null;
    const subjectCommunityGroupInviteStatus = n.subjectCommunityGroupInviteId
      ? (subjectCommunityGroupInviteStatusById.get(
          n.subjectCommunityGroupInviteId,
        ) ?? null)
      : null;
    const notificationPostId = host.notificationPostId(n);
    const notificationPost =
      (notificationPostId
        ? (notificationPostDtoById.get(notificationPostId) ?? null)
        : null) ??
      (n.kind === "repost" && n.subjectPostId
        ? (notificationPostDtoById.get(n.subjectPostId) ?? null)
        : null);
    const subjectSpaceOwnerUsername = n.subjectSpaceId
      ? (subjectSpaceOwnerUsernameById.get(n.subjectSpaceId) ?? null)
      : null;
    return host.toNotificationDto(
      n,
      publicBaseUrl,
      preview,
      subjectPostVisibility,
      subjectTier,
      articlePreview,
      subjectGroup?.slug ?? null,
      subjectGroup?.name ?? null,
      null, // subjectGroupAvatarUrl not fetched in batch path; fallback to null
      subjectCrewInviteStatus,
      subjectCrewName,
      subjectCommunityGroupInviteStatus,
      notificationPost,
      subjectSpaceOwnerUsername,
    );
  });

  // Follow bell settings are no longer used to collapse notifications.
  // All followed_post notifications appear as standalone rows regardless of bell.
  // (Bell-enabled follows still receive reply/comment notifications separately.)

  function groupKey(n: NotificationDto): string | null {
    if (n.kind === "boost" && n.subjectPostId) {
      const tier = n.actor?.isOrganization
        ? "organization"
        : n.actor?.premium
          ? "premium"
          : n.actor?.verifiedStatus && n.actor.verifiedStatus !== "none"
            ? "verified"
            : "normal";
      // A group has one arrow: keep each boost tier separate so its color remains truthful.
      return `boost:post:${n.subjectPostId}:tier:${tier}`;
    }
    if (n.kind === "comment" && n.subjectPostId)
      return `comment:post:${n.subjectPostId}`;
    if (n.kind === "community_group_member_joined" && n.subjectGroupId)
      return `community_group_member_joined:group:${n.subjectGroupId}`;
    if (n.kind === "crew_member_joined" && n.subjectCrewId)
      return `crew_member_joined:crew:${n.subjectCrewId}`;
    if (n.kind === "crew_member_left" && n.subjectCrewId)
      return `crew_member_left:crew:${n.subjectCrewId}`;
    if (n.kind === "follow") return "follow";
    if (n.kind === "nudge" && n.actor?.id) return `nudge:actor:${n.actor.id}`;
    return null;
  }

  function groupKindFromKey(key: string): NotificationGroupKind | null {
    if (key.startsWith("boost:")) return "boost";
    if (key.startsWith("repost:")) return "repost";
    if (key.startsWith("comment:")) return "comment";
    if (key === "follow") return "follow";
    if (key.startsWith("nudge:")) return "nudge";
    return null;
  }

  function buildGroup(
    members: NotificationDto[],
    key: string,
  ): NotificationGroupDto {
    const newest = members[0]!;
    const kind =
      groupKindFromKey(key) ?? (newest.kind as NotificationGroupKind);
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
      kind === "comment"
        ? (members.find((m) => (m.body ?? "").trim())?.body ?? null)
        : null;

    const subjectPostId =
      kind === "boost" || kind === "repost" || kind === "comment"
        ? (newest.subjectPostId ?? null)
        : null;
    const subjectUserId =
      kind === "follow"
        ? (newest.actor?.id ?? newest.subjectUserId ?? null)
        : kind === "nudge"
          ? (newest.actor?.id ?? newest.subjectUserId ?? null)
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
      ...(newest.boardThreadId
        ? { boardThreadId: newest.boardThreadId }
        : {}),
    };
  }

  // Group supported events, but never drop distinct notification IDs for the same post.
  const seenNotificationIds = new Set<string>();
  const pushSingle = (
    target: NotificationFeedItemDto[],
    n: NotificationDto,
  ): void => {
    if (seenNotificationIds.has(n.id)) return;
    seenNotificationIds.add(n.id);
    target.push({ type: "single", notification: n });
  };

  if (kind) {
    const page: NotificationFeedItemDto[] = [];
    for (const n of dtos) {
      pushSingle(page, n);
      if (page.length >= desiredItemLimit) break;
    }
    const lastItem = page.at(-1);
    const hasMore = dtos.length > page.length || hasMoreRaw;
    return {
      items: page,
      nextCursor: hasMore
        ? lastItem?.type === "single"
          ? lastItem.notification.id
          : null
        : null,
      undeliveredCount,
      unreadByKind,
      unreadByCategory,
    };
  }

  const items: NotificationFeedItemDto[] = [];
  let i = 0;
  while (i < dtos.length && items.length < desiredItemLimit) {
    const n = dtos[i]!;

    // followed_post / checkin_post notifications always appear as standalone items regardless of bell setting.
    // The bell only controls whether reply notifications from followed users are delivered.
    if (
      n.kind === "followed_post" ||
      n.kind === "checkin_post" ||
      n.kind === "community_group_post"
    ) {
      pushSingle(items, n);
      i += 1;
      continue;
    }

    if (
      n.post &&
      (n.kind === "comment" || n.kind === "mention" || n.kind === "repost")
    ) {
      pushSingle(items, n);
      i += 1;
      continue;
    }

    const key = groupKey(n);
    if (!key) {
      pushSingle(items, n);
      i += 1;
      continue;
    }

    const members: NotificationDto[] = [n];
    let j = i + 1;
    while (
      j < dtos.length &&
      groupKey(dtos[j]!) === key &&
      members.length < maxGroupNotifications
    ) {
      members.push(dtos[j]!);
      j += 1;
    }

    if (members.length === 1) {
      pushSingle(items, n);
      i += 1;
      continue;
    }

    items.push({ type: "group", group: buildGroup(members, key) });
    i = j;
  }

  const lastConsumedId = i > 0 ? (dtos[i - 1]?.id ?? null) : null;
  const hasMore = i < dtos.length || hasMoreRaw;
  const nextCursor = hasMore ? lastConsumedId : null;

  return {
    items,
    nextCursor,
    undeliveredCount,
    unreadByKind,
    unreadByCategory,
  };
}
