import { z } from 'zod';

export const createRequestSchema = z
  .object({
    // Provider-agnostic for now; this is here so we can extend later without breaking clients.
    videoCallConsent: z.literal(true).optional(),
    providerHint: z.string().trim().min(1).max(50).optional(),
  })
  .partial();
