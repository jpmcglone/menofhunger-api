import { limitQuery } from '../../common/pagination/cursor-query.schema';
import { z } from 'zod';

export const listSchema = z.object({
  q: z.string().trim().max(200).optional(),
  status: z.enum(['pending', 'approved', 'rejected', 'cancelled']).optional(),
  limit: limitQuery(100),
  cursor: z.string().optional(),
});

export const approveSchema = z.object({
  adminNote: z.union([z.string().trim().max(2000), z.null()]).optional(),
});

export const rejectSchema = z.object({
  rejectionReason: z.string().trim().min(1).max(2000),
  adminNote: z.union([z.string().trim().max(2000), z.null()]).optional(),
});
