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

export type MessageDto = {
  id: string;
  createdAt: string;
  body: string;
  conversationId: string;
  sender: UserListDto;
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

export function toMessageDto(params: {
  message: Message & { sender: UserListRow };
  publicBaseUrl: string | null;
}): MessageDto {
  const { message, publicBaseUrl } = params;
  return {
    id: message.id,
    createdAt: message.createdAt.toISOString(),
    body: message.body,
    conversationId: message.conversationId,
    sender: toUserListDto(message.sender, publicBaseUrl),
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
