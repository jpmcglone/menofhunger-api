import { z } from 'zod';

export const createPageSchema = z.object({
  username: z.string().trim().min(1),
  name: z.string().trim().min(1).max(50),
  isOrganization: z.boolean().optional().default(false),
  operatorUserId: z.string().min(1),
});
