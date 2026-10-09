import type { UserListDto } from './user.dto';
import type { MessageDto } from '../../modules/messages/message.dto';

export type GroupChannelCapabilitiesDto = {
  canSend: boolean; canReact: boolean; canManage: boolean; canInvite: boolean;
  canModerate: boolean; canArchive: boolean; canRename: boolean;
};
export type GroupChannelDto = {
  id: string; groupId: string; name: string; topic: string;
  /** A single emoji shown instead of "#"; null uses the default. */
  icon: string | null;
  /** Free-form title shown in the UI; null falls back to the handle in `name`. */
  displayName: string | null;
  privacy: 'normal' | 'private'; defaultPurpose: 'announcements' | 'general' | 'random' | null;
  archivedAt: string | null; revision: number;
  viewerUpdatedAt: string | null;
  readThrough: number;
  hasUnread: boolean; personalCount: number; preference: 'all' | 'mentions' | 'off';
  /** ISO time the viewer's mute ends; null when not muted. Far future means until turned back on. */
  mutedUntil: string | null;
  /** The viewer removed this channel from their list. */
  hidden: boolean;
  capabilities: GroupChannelCapabilitiesDto;
};
export type GroupChannelMemberDto = { role: 'owner' | 'moderator' | 'member'; user: UserListDto };
/** Recipient-filtered metadata for a stable ID token in a channel message body. */
export type GroupChannelReferenceDto = {
  token: string; channelId: string | null; name: string | null; displayName: string | null;
  privacy: 'normal' | 'private'; accessible: boolean;
};
/** Counts only, visible to the sender; never identifies readers. */
export type GroupChannelReceiptDto = { readCount: number; recipientCount: number };
export type GroupChannelMessageDto = MessageDto & {
  channelReferences?: GroupChannelReferenceDto[];
  receipt: GroupChannelReceiptDto | null;
  clientRequestId: string | null;
  revision: number;
  channelId: string; sequence: number; threadRootId: string | null;
  hiddenPreviews: string[];
  replyCount: number; lastReplyAt: string | null; following: boolean; pinned: boolean;
  /** Only on `kind: groupJoin` rows. `canWelcome` is false for the joiner, after the viewer welcomed, or when they cannot post. */
  joinWelcome: { canWelcome: boolean } | null;
  canEdit: boolean; canDelete: boolean;
};
export type GroupChannelAttentionDto = {
  channelId: string; messageId: string; threadRootId: string | null;
  mentioned: boolean; followedReply: boolean; createdAt: string;
  message: GroupChannelMessageDto;
};
export type GroupChannelChangedPayloadDto = {
  groupId: string; channelId?: string; revision?: number;
  reason: 'channel' | 'messages' | 'attention' | 'access';
};

/** Viewer-filtered canonical snapshots; clients merge by message ID and sequence. */
export type GroupChannelMessagesPayloadDto = {
  groupId: string;
  channel: GroupChannelDto;
  messages: GroupChannelMessageDto[];
};

export type GroupChannelViewerPayloadDto = {
  groupId: string;
  channel: GroupChannelDto;
  readMessageIds?: string[];
  readThrough?: number;
  threadRootId?: string;
  following?: boolean;
};

export type GroupChannelMarvStatusDto = {
  enabled: boolean;
  inGroup: boolean;
  participating: boolean;
  canManage: boolean;
  userId: string | null;
};
