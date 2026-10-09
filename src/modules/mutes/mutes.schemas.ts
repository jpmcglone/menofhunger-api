import { z } from 'zod';

export const muteUserSchema = z.object({ user_id: z.string().trim().min(1) });
