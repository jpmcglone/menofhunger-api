import { limitQuery } from '../../common/pagination/cursor-query.schema';
import { z } from 'zod';

export const updatePreferencesSchema = z.object({
  preferredMode: z.enum(['auto', 'fast', 'regular', 'smart']).optional(),
  aiConsent: z.boolean().optional(),
});

export const catchUpBodySchema = z.object({
  mode: z.enum(['auto', 'fast', 'regular', 'smart']).optional(),
  refresh: z.boolean().optional(),
  cacheOnly: z.boolean().optional(),
  includeImages: z.boolean().optional(),
});

export const adminUsersQuerySchema = z.object({
  q: z.string().trim().max(80).optional(),
  cursor: z.string().trim().max(64).optional(),
  limit: limitQuery(50),
});

export const myUsageQuerySchema = z.object({
  cursor: z.string().trim().max(64).optional(),
  limit: limitQuery(50),
});

export const adminUsageQuerySchema = z.object({
  userId: z.string().trim().max(64).optional(),
  source: z.enum(['public_thread', 'private_session', 'catch_up', 'admin_console']).optional(),
  cursor: z.string().trim().max(64).optional(),
  limit: limitQuery(100),
});

export const adminCostQuerySchema = z.object({
  sinceDays: z.coerce.number().int().min(1).max(90).optional(),
});

export const adminConfigPatchSchema = z.object({
  enabled: z.boolean().optional(),
  fastCost: z.union([z.number().min(0), z.null()]).optional(),
  regularCost: z.union([z.number().min(0), z.null()]).optional(),
  smartCost: z.union([z.number().min(0), z.null()]).optional(),
  fastModel: z.union([z.string().trim().min(1).max(80), z.null()]).optional(),
  regularModel: z.union([z.string().trim().min(1).max(80), z.null()]).optional(),
  smartModel: z.union([z.string().trim().min(1).max(80), z.null()]).optional(),
});
