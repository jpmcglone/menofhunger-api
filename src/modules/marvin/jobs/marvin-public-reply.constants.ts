import { type MarvinMode } from '@prisma/client';

/**
 * How often to re-emit `posts:typing` while the AI call is in flight.
 * The web client expires the indicator after 7 000ms (`usePostTyping.TYPING_TTL_MS`),
 * so we heartbeat at half that to keep the indicator alive through long tool loops.
 */
export const TYPING_HEARTBEAT_MS = 3000;
/** Jev must put the chance the author wants an answer below this before a mention goes unanswered. */
export const MENTION_NO_REPLY_THRESHOLD = 0.05;
export const MENTION_GATE_MAX_CHARS = 240;

export type MarvinPublicReplyJobPayload = {
  postId: string;
  rootPostId: string;
  requestingUserId: string;
  /** Optional mode override (from `x-marv-mode` header on the post create call). */
  requestedMode?: MarvinMode | null;
  /** Snapshot of the original post body (used as Marv's question seed). */
  bodySnippet?: string;
  /** Visibility of the triggering post — informational; createPost mirrors parent visibility. */
  visibility?: string;
  /** Set when an untagged post was recognized as speaking to Marv, so the @mention check is waived. */
  addressedBy?: 'jev';
};
