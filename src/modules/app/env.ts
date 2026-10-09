import { z } from "zod";
import { coreEnvShape } from "./env-core.shape";
import { integrationsEnvShape } from "./env-integrations.shape";
import { marvEnvShape } from "./env-marv.shape";

export const envSchema = z
  .object({
    ...coreEnvShape,
    ...integrationsEnvShape,
    ...marvEnvShape,
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== "production") return;

    if (!env.OTP_HMAC_SECRET || env.OTP_HMAC_SECRET.length < 16) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["OTP_HMAC_SECRET"],
        message: "OTP_HMAC_SECRET is required in production (min 16 chars)",
      });
    }

    if (!env.SESSION_HMAC_SECRET || env.SESSION_HMAC_SECRET.length < 16) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["SESSION_HMAC_SECRET"],
        message: "SESSION_HMAC_SECRET is required in production (min 16 chars)",
      });
    }

    if (!env.REDIS_URL || !String(env.REDIS_URL).trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["REDIS_URL"],
        message: "REDIS_URL is required in production",
      });
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
          .map((i) => `- ${i.path.join(".")}: ${i.message}`)
          .join("\n")}`,
      );
    }
    return parsed.data;
  };
}
