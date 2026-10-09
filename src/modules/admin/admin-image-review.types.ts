import { createHash } from 'node:crypto';
import { decodeJsonCursor, encodeJsonCursor } from '../../common/pagination/json-cursor';

export type UserRef = {
  userId: string;
  username: string | null;
  name: string | null;
  premium: boolean;
  premiumPlus: boolean;
  verifiedStatus: string | null;
  isAvatar: boolean;
  isBanner: boolean;
};

export type PublicationRef = {
  id: string;
  title: string;
  status: string;
  isInline: boolean;
};

export type PostRef = {
  postMediaId: string;
  postId: string;
  postCreatedAt: string;
  postVisibility: string;
  authorId: string;
  authorUsername: string | null;
  deletedAt: string | null;
  /** true when this key is a video poster frame (thumbnailR2Key), not the main asset */
  isThumbnail: boolean;
};

export type PollRef = {
  pollOptionId: string;
  pollId: string;
  postId: string;
};

export type MessageRef = {
  messageMediaId: string;
  messageId: string;
  conversationId: string;
  isThumbnail: boolean;
  sentAt: string;
  senderId: string;
  senderUsername: string | null;
  senderName: string | null;
  channelId?: string;
  channelName?: string;
  channelPrivacy?: string;
  groupId?: string;
  groupName?: string;
  groupSlug?: string;
};

export type GroupRef = {
  groupId: string;
  slug: string;
  name: string;
  isAvatar: boolean;
  isCover: boolean;
};

export type CrewRef = {
  crewId: string;
  slug: string;
  name: string | null;
  isAvatar: boolean;
  isCover: boolean;
};

export type ChannelUploadRef = {
  uploadId: string;
  channelId: string;
  userId: string;
  username: string | null;
  channelName: string;
  groupId: string;
  groupName: string;
  groupSlug: string;
  expiresAt: string;
};

export type AssetPrimaryType =
  | "post"
  | "post_thumbnail"
  | "message"
  | "message_thumbnail"
  | "user"
  | "group"
  | "crew"
  | "poll"
  | "article"
  | "article_inline"
  | "announcement"
  | "newsletter"
  | "channel_upload"
  | "orphan";

export type ArticleRef = {
  articleId: string;
  slug: string;
  title: string | null;
  authorId: string;
  /** Cover thumbnail (Article.thumbnailR2Key) vs TipTap body embed. */
  isInline: boolean;
};

export type CursorToken = { lm: string; id: string };

export type AssetRefs = {
  channelUploads: ChannelUploadRef[];
  posts: PostRef[];
  messages: MessageRef[];
  users: UserRef[];
  groups: GroupRef[];
  crews: CrewRef[];
  polls: PollRef[];
  articles: ArticleRef[];
  announcements: PublicationRef[];
  newsletters: PublicationRef[];
  primaryType: AssetPrimaryType;
};

export function referencesToken(refs: AssetRefs): string {
  const { primaryType, ...lists } = refs;
  const canonical = Object.keys(lists)
    .sort()
    .map((key) => [
      key,
      (lists as Record<string, unknown[]>)[key]
        .map((item) => JSON.stringify(item))
        .sort(),
    ]);
  return createHash("sha256")
    .update(JSON.stringify([primaryType, canonical]))
    .digest("hex")
    .slice(0, 32);
}

export function encodeCursor(c: CursorToken): string {
  return encodeJsonCursor(c);
}

export function emptyAssetRefs(): AssetRefs {
  return {
    channelUploads: [],
    posts: [],
    messages: [],
    users: [],
    groups: [],
    crews: [],
    polls: [],
    articles: [],
    announcements: [],
    newsletters: [],
    primaryType: "orphan",
  };
}

export function decodeCursor(token: string | null): CursorToken | null {
  const parsed = decodeJsonCursor(token);
  const lm = typeof parsed?.lm === "string" ? parsed.lm : "";
  const id = typeof parsed?.id === "string" ? parsed.id : "";
  return lm && id ? { lm, id } : null;
}
