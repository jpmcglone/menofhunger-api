import { cursorPageQuerySchema } from '../../common/pagination/cursor-query.schema';
import { queryBoolean } from '../../common/validation/query-boolean';
import { z } from 'zod';

export const listQuerySchema = cursorPageQuerySchema().extend({
  
  unreadOnly: queryBoolean().optional(),
  boardCommentsOnly: queryBoolean().optional(),
  collapseByRoot: queryBoolean().optional(),
  collapseMode: z.enum(['root', 'parent']).optional(),
  prefer: z.enum(['reply', 'root']).optional(),
  kind: z.enum([
    'comment', 'boost', 'repost', 'follow', 'followed_post',
    'followed_article', 'mention', 'nudge', 'coin_transfer',
    'poll_results_ready', 'generic', 'message',
    'community_group_post',
    'group_join_request',
    'community_group_member_joined',
    'community_group_join_approved',
    'community_group_join_rejected',
    'community_group_member_removed',
    'community_group_disbanded',
    'community_group_invite_received',
    'community_group_invite_accepted',
    'community_group_invite_declined',
    'community_group_invite_cancelled',
    'crew_invite_received',
    'crew_invite_accepted',
    'crew_invite_declined',
    'crew_invite_cancelled',
    'crew_member_joined',
    'crew_member_left',
    'crew_member_kicked',
    'crew_disbanded',
    'crew_owner_transferred',
    'crew_owner_transfer_vote',
    'crew_wall_mention',
    'word_of_the_day',
    'quote_of_the_day',
    'account_verified',
    'premium_started',
    'premium_ended',
    'status_update',
    'checkin_post',
    'board',
    'articles',
    'other',
  ]).optional(),
});

export const lockScreenClearBodySchema = z.object({
  section: z.enum(['inbox', 'groups']),
});

export const markReadBodySchema = z.object({
  post_id: z.string().trim().min(1).optional(),
  user_id: z.string().trim().min(1).optional(),
  article_id: z.string().trim().min(1).optional(),
  crew_id: z.string().trim().min(1).optional(),
  group_id: z.string().trim().min(1).optional(),
  board_thread_id: z.string().trim().min(1).optional(),
  filter: z.enum(['board', 'articles']).optional(),
}).refine(
  (d) => d.post_id ?? d.user_id ?? d.article_id ?? d.crew_id ?? d.group_id ?? d.board_thread_id ?? d.filter,
  { message: 'At least one of post_id, user_id, article_id, crew_id, group_id, board_thread_id, or filter is required' },
);

export const pushSubscribeBodySchema = z.object({
  endpoint: z.string().trim().min(1),
  keys: z.object({
    p256dh: z.string().trim().min(1),
    auth: z.string().trim().min(1),
  }),
  user_agent: z.string().trim().optional(),
});

export const pushUnsubscribeBodySchema = z.object({
  endpoint: z.string().trim().min(1),
});

export const apnsRegisterBodySchema = z.object({
  token: z.string().trim().min(1),
  environment: z.enum(['production', 'sandbox']).optional(),
  /** `voip` = PushKit token for incoming-call rings; defaults to a regular alert token. */
  kind: z.enum(['alert', 'voip']).optional(),
});

export const apnsUnregisterBodySchema = z.object({
  token: z.string().trim().min(1),
});
