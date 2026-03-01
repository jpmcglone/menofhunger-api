import type { Message, MessageConversation, MessageParticipantStatus, MessageParticipantRole } from '@prisma/client';
import { toUserListDto, type UserListDto, type UserListRow } from '../../common/dto';

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
};

export type MessageDto = {
  id: string;
  createdAt: string;
  body: string;
  conversationId: string;
  sender: UserListDto;
  reactions: MessageReactionSummaryDto[];
  deletedForMe: boolean;
  replyTo: MessageReplySnippetDto | null;
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
  replyTo?: (Message & { sender: { username: string | null } }) | null;
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
    replyTo: message.replyTo
      ? {
          id: message.replyTo.id,
          senderUsername: message.replyTo.sender.username,
          bodyPreview: message.replyTo.body.slice(0, 200),
        }
      : null,
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
