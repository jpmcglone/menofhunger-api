import type { MessageConversation, PostMediaKind } from '@prisma/client';

export type MessageMediaInput =
  | {
      source: 'upload';
      kind: PostMediaKind;
      r2Key: string;
      thumbnailR2Key?: string | null;
      width?: number | null;
      height?: number | null;
      durationSeconds?: number | null;
      alt?: string | null;
    }
  | {
      source: 'giphy';
      kind: 'gif';
      url: string;
      mp4Url?: string | null;
      width?: number | null;
      height?: number | null;
      alt?: string | null;
    };

/** What the calls service needs to authorize a start/join without re-querying per field. */
export type CallConversationContext = {
  id: string;
  type: Exclude<MessageConversation['type'], 'channel'>;
  participants: Array<{
    userId: string;
    status: 'pending' | 'accepted';
    verified: boolean;
    siteAdmin: boolean;
    isBot: boolean;
    banned: boolean;
  }>;
  /**
   * Direct conversations only, and only when the other side hasn't accepted the thread yet:
   * the alternate ways a verified member may still call them (mutual follow, or they already
   * share a group chat). `null` when the check wasn't needed.
   */
  relationship: { mutualFollow: boolean; sharedGroupConversation: boolean } | null;
};

/**
 * Nested `createMany` does not populate `include: { media: true }` on the
 * returned row, so send/socket DTOs shipped empty `media` arrays. `create`
 * returns the nested rows so clients can render video/image immediately.
 */
export function messageMediaCreateData(media: MessageMediaInput[]) {
  return media.map((m) =>
    m.source === 'upload'
      ? {
          source: m.source,
          kind: m.kind,
          r2Key: m.r2Key,
          thumbnailR2Key: m.thumbnailR2Key ?? null,
          width: m.width ?? null,
          height: m.height ?? null,
          durationSeconds: m.durationSeconds ?? null,
          alt: m.alt ?? null,
        }
      : {
          source: m.source,
          kind: 'gif' as PostMediaKind,
          url: m.url,
          mp4Url: m.mp4Url ?? null,
          width: m.width ?? null,
          height: m.height ?? null,
          alt: m.alt ?? null,
        },
  );
}
