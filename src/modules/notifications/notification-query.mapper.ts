import { toAvatarVideoDto } from "../../common/dto/avatar-video.dto";
import { type NotificationKind, type VerifiedStatus } from "@prisma/client";
import { publicAssetUrl } from "../../common/assets/public-asset-url";
import { notificationCategory } from "./notification-category";
import type { NotificationActorDto, NotificationDto, SubjectPostPreviewDto, SubjectArticlePreviewDto, SubjectPostVisibility, SubjectTier } from "./notification.dto";
import type { PostDto } from "../../common/dto/post.dto";

export function notificationPostId(n: {
  kind: NotificationKind;
  actorPostId?: string | null;
  subjectPostId?: string | null;
}): string | null {
  if (
    n.kind === "followed_post" ||
    n.kind === "checkin_post" ||
    n.kind === "community_group_post"
  )
    return (n.subjectPostId ?? "").trim() || null;
  if (n.kind === "comment") return (n.actorPostId ?? "").trim() || null;
  if (n.kind === "mention") return (n.actorPostId ?? "").trim() || null;
  if (n.kind === "repost")
    return (n.actorPostId ?? n.subjectPostId ?? "").trim() || null;
  // marv_not_in_group navigates via actorPostId on the DTO; no embedded post row.
  return null;
}

export function toNotificationDto(
  n: {
    id: string;
    createdAt: Date;
    kind: NotificationKind;
    subjectPost?: {
      parentId: string | null;
      id?: string;
      kind?: string;
      rootId?: string | null;
    } | null;
    actorPost?: {
      parentId: string | null;
      id: string;
      kind: string;
      rootId: string | null;
    } | null;
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
    actionPath?: string | null;
    subjectSpaceId?: string | null;
    title: string | null;
    body: string | null;
    actor: {
      id: string;
      username: string | null;
      name: string | null;
      avatarKey: string | null;
      avatarVideoKey?: string | null;
      avatarVideoDurationMs?: number | null;
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
  subjectGroupAvatarUrl: string | null = null,
  subjectCrewInviteStatus: NotificationDto["subjectCrewInviteStatus"] = null,
  subjectCrewName: string | null = null,
  subjectCommunityGroupInviteStatus: NotificationDto["subjectCommunityGroupInviteStatus"] = null,
  post: PostDto | null = null,
  subjectSpaceOwnerUsername: string | null = null,
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
      avatarVideo: toAvatarVideoDto(n.actor, publicBaseUrl),
      premium: n.actor.premium,
      isOrganization: Boolean(n.actor.isOrganization),
      verifiedStatus: n.actor.verifiedStatus,
    };
  }
  return {
    id: n.id,
    createdAt: n.createdAt.toISOString(),
    kind: n.kind,
    category: notificationCategory(
      n.kind,
      n.subjectPost?.parentId ?? post?.parentId,
    ),
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
    subjectGroupAvatarUrl,
    subjectCrewId: n.subjectCrewId ?? null,
    subjectCrewInviteId: n.subjectCrewInviteId ?? null,
    subjectCrewInviteStatus: subjectCrewInviteStatus ?? null,
    subjectCrewName: subjectCrewName ?? null,
    subjectCommunityGroupInviteId: n.subjectCommunityGroupInviteId ?? null,
    subjectCommunityGroupInviteStatus:
      subjectCommunityGroupInviteStatus ?? null,
    subjectConversationId: n.subjectConversationId ?? null,
    actionPath: n.actionPath ?? null,
    subjectSpaceId: n.subjectSpaceId ?? null,
    subjectSpaceOwnerUsername: subjectSpaceOwnerUsername ?? null,
    title: n.title,
    body: n.body,
    subjectPostPreview: subjectPostPreview ?? null,
    post: post ?? null,
    subjectArticlePreview: subjectArticlePreview ?? null,
    subjectPostVisibility,
    subjectTier,
    ...boardNotificationRefs(n.actorPost ?? null, n.subjectPost ?? null),
  };
}

type BoardRefPost = {
  id?: string;
  parentId: string | null;
  kind?: string;
  rootId?: string | null;
} | null;

/** Board thread/comment ids when the causing or subject post lives on the Board. */
export function boardNotificationRefs(
  actorPost: BoardRefPost,
  subjectPost: BoardRefPost,
): Pick<NotificationDto, "boardThreadId" | "boardCommentId"> {
  const ref = [actorPost, subjectPost].find((p) => p?.kind === "board" && p.id);
  if (!ref?.id) return {};
  const threadId = ref.parentId ? (ref.rootId ?? ref.parentId) : ref.id;
  const commentPost =
    actorPost?.kind === "board" && actorPost.parentId
      ? actorPost
      : ref.parentId
        ? ref
        : null;
  return { boardThreadId: threadId, boardCommentId: commentPost?.id ?? null };
}
