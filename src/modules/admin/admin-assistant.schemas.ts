import { z } from 'zod';

export const messageSchema = z.object({ id: z.string().uuid(), message: z.string().trim().min(1).max(6000) }).strict();

export const decisionSchema = z.object({ decision: z.enum(['confirm', 'cancel']) }).strict();
