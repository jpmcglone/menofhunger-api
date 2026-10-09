import { PARTNER_EVENTS, PARTNER_SCOPES } from './partner.constants';
import { z } from 'zod';

export const httpsUrl = z
  .string()
  .url()
  .refine((v) => {
    const u = new URL(v);
    return u.protocol === 'https:' && !u.username && !u.password && !u.hash;
  }, 'Use a registered HTTPS URL.');

export const createSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    platform: z.enum(['pickax']).optional(),
    redirectUris: z.array(httpsUrl).min(1).max(10),
    logoutRedirectUris: z.array(httpsUrl).max(10).default([]),
    scopes: z.array(z.enum(PARTNER_SCOPES)).min(1),
    authorizationStartUrl: httpsUrl.optional(),
    webhookUrl: httpsUrl.optional(),
    webhookEvents: z.array(z.enum(PARTNER_EVENTS)).default([]),
  })
  .strict();
