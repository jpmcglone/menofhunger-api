import { z } from 'zod';

export const id = z.string().trim().min(1).max(128);

export const sequence = z.coerce.number().int().positive();

export const create = z.object({ name: z.string().min(1).max(81).optional(), displayName: z.string().max(200).nullable().optional(), topic: z.string().trim().max(500).optional(), icon: z.string().max(16).nullable().optional(), privacy: z.enum(['normal', 'private']).default('normal') }).strict();

export const update = z.object({ name: z.string().min(1).max(81).optional(), displayName: z.string().max(200).nullable().optional(), topic: z.string().trim().max(500).optional(), icon: z.string().max(16).nullable().optional(), archived: z.boolean().optional() }).strict();
