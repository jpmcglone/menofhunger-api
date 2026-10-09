import { limitQuery } from '../../common/pagination/cursor-query.schema';
import { z } from 'zod';

export const listTransfersQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: limitQuery(50),
});
