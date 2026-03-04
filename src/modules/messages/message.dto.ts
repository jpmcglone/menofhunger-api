import type { Message, MessageConversation, MessageMedia, MessageParticipantStatus, MessageParticipantRole } from '@prisma/client';
import { toUserListDto, type UserListDto, type UserListRow } from '../../common/dto';
import { publicAssetUrl } from '../../common/assets/public-asset-url';

export type MessageParticipantDto = {
  user: UserListDto;
  status: MessageParticipantStatus;
  role: MessageParticipantRole;
  acceptedAt: string | null;
  lastReadAt: string | null;
  banned: boolean;
};

export type MessageReactionSummaryDto = {
  reactionId: string;
  emoji: string;
  count: number;
  reactedByMe: boolean;
  reactors: { id: string; username: string | null; avatarUrl: string | null }[];
};

export type MessageReplySnippetDto = {
  id: string;
  senderUsername: string | null;
  bodyPreview: string;
  /** Thumbnail URL of the first media item on the replied-to message, if any. */
  mediaThumbnailUrl: string | null;
};

export type MessageMediaDto = {
  id: string;
  kind: MessageMedia['kind'];
  source: MessageMedia['source'];
  url: string;
  mp4Url: string | null;
  thumbnailUrl: string | null;
  width: number | null;
  height: number | null;
  durationSeconds: number | null;
  alt: string | null;
};

export type MessageDto = {
  id: string;
  createdAt: string;
  body: string;
  conversationId: string;
  sender: UserListDto;
  reactions: MessageReactionSummaryDto[];
  deletedForMe: boolean;
  /** True when the sender deleted this message for all participants. */
  deletedForAll: boolean;
  /** ISO string of when the message was last edited, or null. */
  editedAt: string | null;
  replyTo: MessageReplySnippetDto | null;
  media: MessageMediaDto[];
};

export type MessageConversationDto = {
  id: string;
  type: MessageConversation['type'];
  title: string | null;
  createdAt: string;
  updatedAt: string;
  lastMessageAt: string | null;
  lastMessage: { id: string; body: string; createdAt: string; senderId: string } | null;
  participants: MessageParticipantDto[];
  viewerStatus: MessageParticipantStatus;
  unreadCount: number;
  /** True when the viewer has muted notifications for this conversation. */
  isMuted: boolean;
  /** True when a block exists in either direction between the viewer and the other participant (direct chats only). */
  isBlockedWith?: boolean;
};

type MessageReactionRow = {
  id: string;
  reactionId: string;
  emoji: string;
  userId: string;
  user: { id: string; username: string | null; avatarKey: string | null; avatarUpdatedAt: Date | null };
};

type MessageWithRelations = Message & {
  sender: UserListRow;
  reactions?: MessageReactionRow[];
  deletions?: { userId: string }[];
  replyTo?: (Message & { sender: { username: string | null }; media?: MessageMedia[] }) | null;
  media?: MessageMedia[];
  editedAt?: Date | null;
  deletedForAll?: boolean;
  deletedForAllAt?: Date | null;
};

function buildReactionSummaries(
  reactions: MessageReactionRow[],
  viewerUserId: string,
  publicBaseUrl: string | null,
): MessageReactionSummaryDto[] {
  const byReactionId = new Map<string, MessageReactionSummaryDto>();
  for (const r of reactions) {
    let group = byReactionId.get(r.reactionId);
    if (!group) {
      group = { reactionId: r.reactionId, emoji: r.emoji, count: 0, reactedByMe: false, reactors: [] };
      byReactionId.set(r.reactionId, group);
    }
    group.count++;
    if (r.userId === viewerUserId) group.reactedByMe = true;
    const avatarUrl =
      r.user.avatarKey && publicBaseUrl
        ? `${publicBaseUrl}/${r.user.avatarKey}`
        : null;
    group.reactors.push({ id: r.user.id, username: r.user.username, avatarUrl });
  }
  return [...byReactionId.values()];
}

function toMessageMediaDto(m: MessageMedia, publicBaseUrl: string | null): MessageMediaDto {
  const url =
    m.source === 'upload'
      ? (publicAssetUrl({ publicBaseUrl, key: m.r2Key }) ?? '')
      : (m.url ?? '');
  const thumbnailUrl =
    m.source === 'upload' && m.thumbnailR2Key
      ? (publicAssetUrl({ publicBaseUrl, key: m.thumbnailR2Key }) ?? null)
      : null;
  return {
    id: m.id,
    kind: m.kind,
    source: m.source,
    url,
    mp4Url: m.mp4Url ?? null,
    thumbnailUrl,
    width: m.width ?? null,
    height: m.height ?? null,
    durationSeconds: m.durationSeconds ?? null,
    alt: m.alt ?? null,
  };
}

export function toMessageDto(params: {
  message: MessageWithRelations;
  publicBaseUrl: string | null;
  viewerUserId?: string;
}): MessageDto {
  const { message, publicBaseUrl, viewerUserId = '' } = params;
  return {
    id: message.id,
    createdAt: message.createdAt.toISOString(),
    body: message.body,
    conversationId: message.conversationId,
    sender: toUserListDto(message.sender, publicBaseUrl),
    reactions: buildReactionSummaries(message.reactions ?? [], viewerUserId, publicBaseUrl),
    deletedForMe: (message.deletions ?? []).some((d) => d.userId === viewerUserId),
    deletedForAll: Boolean(message.deletedForAll),
    editedAt: message.editedAt ? message.editedAt.toISOString() : null,
    replyTo: message.replyTo
      ? (() => {
          const rm = (message.replyTo.media ?? [])[0] ?? null;
          let mediaThumbnailUrl: string | null = null;
          if (rm) {
            if (rm.source === 'upload') {
              // For videos prefer the thumbnail key; images use r2Key directly.
              const key = rm.kind === 'video' ? (rm.thumbnailR2Key ?? rm.r2Key) : rm.r2Key;
              mediaThumbnailUrl = key ? (publicAssetUrl({ publicBaseUrl, key }) ?? null) : null;
            } else {
              // Giphy — url is already a CDN URL we can use directly.
              mediaThumbnailUrl = rm.url ?? null;
            }
          }
          return {
            id: message.replyTo.id,
            senderUsername: message.replyTo.sender.username,
            bodyPreview: message.replyTo.body.slice(0, 200) || (rm ? '📷 Photo' : ''),
            mediaThumbnailUrl,
          };
        })()
      : null,
    media: (message.media ?? []).map((m) => toMessageMediaDto(m, publicBaseUrl)),
  };
}

export function toMessageParticipantDto(params: {
  user: UserListRow & { bannedAt?: Date | null };
  status: MessageParticipantStatus;
  role: MessageParticipantRole;
  acceptedAt: Date | null;
  lastReadAt: Date | null;
  publicBaseUrl: string | null;
}): MessageParticipantDto {
  const { user, status, role, acceptedAt, lastReadAt, publicBaseUrl } = params;
  return {
    user: toUserListDto(user, publicBaseUrl),
    status,
    role,
    acceptedAt: acceptedAt ? acceptedAt.toISOString() : null,
    lastReadAt: lastReadAt ? lastReadAt.toISOString() : null,
    banned: Boolean(user.bannedAt),
  };
}
