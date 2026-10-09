import { cursorPageQuerySchema, limitQuery } from '../../common/pagination/cursor-query.schema';
import { queryBoolean } from '../../common/validation/query-boolean';
import { z } from 'zod';

export const feedQuerySchema = cursorPageQuerySchema().extend({
  
  sort: z.enum(['new', 'trending']).optional(),
  topLevelOnly: queryBoolean().optional(),
});

export const mediaQuerySchema = cursorPageQuerySchema().extend({
  
  sort: z.enum(['new', 'trending']).optional(),
});

export const myHubFeedQuerySchema = feedQuerySchema.extend({
  groupId: z.string().trim().min(1).max(40).optional(),
});

export const membersQuerySchema = cursorPageQuerySchema().extend({
  
  q: z.string().trim().max(80).optional(),
});

export const createGroupSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(160),
  rules: z.string().trim().max(8000).nullish(),
  coverImageUrl: z.string().trim().max(2000).nullish(),
  avatarImageUrl: z.string().trim().max(2000).nullish(),
  joinPolicy: z.enum(['open', 'approval']),
});

export const updateGroupSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().min(1).max(160).optional(),
  rules: z.string().trim().max(8000).nullish(),
  coverImageUrl: z.string().trim().max(2000).nullish(),
  avatarImageUrl: z.string().trim().max(2000).nullish(),
  joinPolicy: z.enum(['open', 'approval']).optional(),
  isFeatured: z.boolean().optional(),
  featuredOrder: z.coerce.number().int().min(0).max(9999).optional(),
});

export const sendInviteSchema = z.object({
  inviteeUserId: z.string().trim().min(1),
  message: z.string().trim().max(500).nullish(),
});

export const invitableUsersSchema = z.object({
  q: z.string().trim().max(80).optional(),
  limit: limitQuery(50),
});

export const boolFlag = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .optional()
  .transform((v) => v === true || v === 'true' || v === '1');

export const groupSearchSchema = z.object({
  q: z.string().trim().min(1).max(80),
  limit: limitQuery(30),
  cursor: z.string().trim().min(1).max(200).optional(),
  excludeMine: boolFlag,
});

export const exploreQuerySchema = z.object({
  excludeMine: boolFlag,
  limit: limitQuery(60),
  cursor: z.string().trim().min(1).max(200).optional(),
});
