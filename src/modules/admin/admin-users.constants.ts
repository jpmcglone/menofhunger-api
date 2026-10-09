import { limitQuery } from '../../common/pagination/cursor-query.schema';
import { z } from "zod";
import { cursorPageQuerySchema } from '../../common/pagination/cursor-query.schema';

export const paginatedSearchSchema = z.object({
  q: z.string().optional(),
  limit: limitQuery(50),
  cursor: z.string().optional(),
});

export const adminUsernameSchema = z.object({
  username: z.string().optional(),
});

export const banSchema = z.object({
  reason: z.string().trim().max(500).optional(),
});

export const updateUserSchema = z.object({
  phone: z.string().trim().min(1).optional(),
  username: z.union([z.string().trim().min(1), z.null()]).optional(),
  name: z.string().trim().max(50).nullable().optional(),
  bio: z.string().trim().max(160).nullable().optional(),
  website: z.union([z.string().trim().max(200), z.literal("")]).optional(),
  rumbleUrl: z.string().trim().max(300).optional(),
  linkedinUrl: z.string().trim().max(300).optional(),
  youtubeUrl: z.string().trim().max(300).optional(),
  locationQuery: z.union([z.string().trim().max(80), z.literal("")]).optional(),
  isOrganization: z.boolean().optional(),
  verifiedStatus: z.enum(["none", "identity", "manual"]).optional(),
  featureToggles: z.array(z.string()).max(50).optional(),
});

export const adjustCoinsSchema = z.object({
  delta: z
    .number()
    .int()
    .refine((v) => v !== 0, "delta must be non-zero"),
  reason: z.string().trim().max(200).optional().nullable(),
});

export const usernameParamSchema = z.object({
  username: z.string().trim().min(1),
});

export const recentListSchema = cursorPageQuerySchema(100);
