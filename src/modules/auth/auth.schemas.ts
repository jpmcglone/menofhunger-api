import { OTP_CODE_LENGTH } from './auth.constants';
import { signupAttributionSchema } from './signup-attribution';
import { z } from 'zod';

export const startSchema = z.object({
  phone: z.string().min(1),
});

export const existsQuerySchema = z.object({
  phone: z.string().min(1),
});

export const browserHandoffSchema = z.object({
  destination: z.string().max(2048).optional(),
});

export const browserHandoffRedeemSchema = z.object({
  code: z.string().min(1).max(256),
});

export const verifySchema = z.object({
  phone: z.string().min(1),
  code: z
    .string()
    .min(OTP_CODE_LENGTH)
    .max(OTP_CODE_LENGTH)
    .regex(/^\d+$/, 'Code must be numeric'),
  referralCode: z.string().max(50).optional().nullable(),
  attribution: signupAttributionSchema,
});
