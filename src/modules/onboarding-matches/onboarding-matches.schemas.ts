import { z } from 'zod';

export const bodySchema = z.object({ intent: z.string().trim().max(300).optional() }).strict();
