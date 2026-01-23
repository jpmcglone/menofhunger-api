import { z } from 'zod';

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z
    .string()
    .optional()
    .refine((v) => (v ? !Number.isNaN(Number(v)) : true), 'PORT must be a number'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  // Comma-separated list of allowed web origins for CORS (must be explicit when using cookies).
  // Examples:
  // - http://localhost:3000
  // - https://menofhunger.com
  ALLOWED_ORIGINS: z.string().optional().default('http://localhost:3000'),

  // Secrets (recommended in all envs; required in production)
  OTP_HMAC_SECRET: z.string().optional(),
  SESSION_HMAC_SECRET: z.string().optional(),

  // Cookie domain. In production you likely want `.menofhunger.com`.
  COOKIE_DOMAIN: z.string().optional(),

  // Twilio (production only)
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_FROM_NUMBER: z.string().optional(),
}).superRefine((env, ctx) => {
  if (env.NODE_ENV !== 'production') return;

  if (!env.OTP_HMAC_SECRET || env.OTP_HMAC_SECRET.length < 16) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['OTP_HMAC_SECRET'],
      message: 'OTP_HMAC_SECRET is required in production (min 16 chars)',
    });
  }

  if (!env.SESSION_HMAC_SECRET || env.SESSION_HMAC_SECRET.length < 16) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['SESSION_HMAC_SECRET'],
      message: 'SESSION_HMAC_SECRET is required in production (min 16 chars)',
    });
  }

  for (const key of ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM_NUMBER'] as const) {
    if (!env[key]) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [key],
        message: `${key} is required in production`,
      });
    }
  }
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

