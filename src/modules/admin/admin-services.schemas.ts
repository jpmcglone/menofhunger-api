import { z } from 'zod';

export const querySchema = z.object({ refresh: z.enum(["true", "false"]).default("false") }).strict();
