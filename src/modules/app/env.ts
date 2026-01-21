import { z } from 'zod';

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z
    .string()
    .optional()
    .refine((v) => (v ? !Number.isNaN(Number(v)) : true), 'PORT must be a number'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv<TSchema extends z.ZodTypeAny>(schema: TSchema) {
  return (config: Record<string, unknown>) => {
    const parsed = schema.safeParse(config);
    if (!parsed.success) {
      // Nest expects thrown errors to abort bootstrap.
      throw new Error(
        `Invalid environment variables:\n${parsed.error.issues
          .map((i) => `- ${i.path.join('.')}: ${i.message}`)
          .join('\n')}`,
      );
    }
    return parsed.data;
  };
}

