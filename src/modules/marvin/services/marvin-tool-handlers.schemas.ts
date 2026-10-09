import { z } from 'zod';

export const RECENT_MESSAGES_DEFAULT = 10;
export const RECENT_MESSAGES_MAX = 30;
export const SIMILAR_MEMBERS_DEFAULT = 5;
export const SIMILAR_MEMBERS_MAX = 8;
export const SIMILAR_CANDIDATE_LIMIT = 60;
export const CARD_SNIPPET_MAX = 280;
export const PREFETCH_MEMBER_CARD_MAX = 8;

export const handleSchema = z
  .string()
  .min(1)
  .max(50)
  .transform((s) => s.trim().replace(/^@/, ''));
/** Empty / placeholders mean the general lodge — models often send those instead of leaving the field off. */
export const optionalLodgeHandleSchema = z.preprocess((value) => {
  if (value == null) return undefined;
  if (typeof value !== 'string') return value;
  const trimmed = value.trim().replace(/^@/, '');
  if (
    !trimmed
    || /^(all|feed|everyone|anybody|anyone|lodge|omit|none|null|empty|undefined|n\/a|-)$/i.test(trimmed)
  ) {
    return undefined;
  }
  return trimmed;
}, handleSchema.optional());
export const getUserBasicInfoSchema = z.object({ username: handleSchema });
export const getUserContextCardSchema = z.object({ username: handleSchema });
export const findMembersByNameSchema = z.object({
  name: z.string().trim().min(2).max(80),
  limit: z.coerce.number().int().min(1).max(8).optional(),
});
export const getPostSchema = z.object({ postId: z.string().min(1).max(50) });
export const PUBLIC_POSTS_DEFAULT = 5;
export const PUBLIC_POSTS_MAX = 8;
export const listPublicPostsSchema = z.object({
  username: optionalLodgeHandleSchema,
  limit: z.coerce.number().int().min(1).max(PUBLIC_POSTS_MAX).optional(),
});
export const listLimitSchema = z.object({
  limit: z.coerce.number().int().min(1).max(PUBLIC_POSTS_MAX).optional(),
});
export const searchGroupChannelsSchema = z.object({
  query: z.string().trim().min(1).max(200),
});
export const getPostThreadRecentMessagesSchema = z.object({
  rootPostId: z.string().min(1).max(50),
  limit: z.coerce.number().int().min(1).max(RECENT_MESSAGES_MAX).optional(),
});
export const getPostThreadSummarySchema = z.object({ rootPostId: z.string().min(1).max(50) });
export const getMyRecentChatMessagesSchema = z.object({
  limit: z.coerce.number().int().min(1).max(RECENT_MESSAGES_MAX).optional(),
});
export const fetchUrlContentSchema = z.object({ url: z.string().min(1).max(2_000) });
export const getBiblePassageSchema = z.object({ reference: z.string().min(1).max(120) });
export const findSimilarMembersSchema = z.object({
  query: z.string().trim().min(1).max(120).optional(),
  limit: z.coerce.number().int().min(1).max(SIMILAR_MEMBERS_MAX).optional(),
});

export const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'is', 'are',
  'was', 'were', 'be', 'been', 'i', 'me', 'my', 'we', 'our', 'you', 'your', 'he', 'she', 'they',
  'them', 'his', 'her', 'their', 'this', 'that', 'from', 'as', 'by', 'about', 'into', 'who',
]);

// Per-tool TTLs (seconds). Tuned so the model's tool loop sees consistent data across
// rounds, and a hot thread/user doesn't repeatedly hit Postgres while several premium
// users mention @marv inside a few minutes.
export const TTL_USER_BASIC = 300; // 5 min — premium/verified rarely flip
export const TTL_USER_CARD = 300; // 5 min — cards refresh on new public activity, not every tool call
export const TTL_POST = 30; // 30s — body edits should reflect quickly
export const TTL_PUBLIC_POSTS = 30; // 30s — the public lodge moves quickly
export const TTL_THREAD_RECENT = 30; // 30s — replies arrive frequently
export const TTL_THREAD_SUMMARY = 300; // 5 min — only updated by summarize job
export const TTL_CHAT_RECENT = 15; // 15s — keep tight, the user's own chat
export const TTL_URL_CONTENT = 3_600; // 1 hour — page content is stable enough
export const TTL_SIMILAR = 300; // 5 min — membership/interest churn is slow
export const TTL_NAME_SEARCH = 60; // 1 min — name lookups should pick up new members quickly
export const TTL_NEGATIVE = 60; // 1 min — dedupe "user_not_found"/"no_summary"/"fetch_failed" misses

export const MAX_URL_CONTENT_CHARS = 6_000; // Keeps the tool output inside the 8KB AI-layer cap
export const URL_FETCH_TIMEOUT_MS = 10_000;
