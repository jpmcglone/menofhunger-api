import { z } from 'zod';

const TOKEN_MAX = 64;
const PATH_MAX = 200;

function token(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cleaned = raw.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, TOKEN_MAX);
  return cleaned || null;
}

function landingPath(raw: string | null | undefined): string | null {
  if (!raw || !raw.startsWith('/')) return null;
  const path = raw.toLowerCase().split(/[?#]/)[0].replace(/[^a-z0-9/_\-.]/g, '').slice(0, PATH_MAX);
  return path || null;
}

function hostname(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const host = raw.toLowerCase().replace(/[^a-z0-9.-]/g, '').slice(0, 253);
  return host || null;
}

const field = z.string().max(400).optional().nullable();

export const signupAttributionSchema = z
  .object({
    src: field,
    utmSource: field,
    utmMedium: field,
    utmCampaign: field,
    landingPath: field,
    referrerHost: field,
  })
  .optional()
  .nullable();

export type SignupAttributionInput = z.infer<typeof signupAttributionSchema>;

export type SignupAttribution = {
  signupSource: string | null;
  signupMedium: string | null;
  signupCampaign: string | null;
  signupLandingPath: string | null;
  signupReferrerHost: string | null;
};

/**
 * Normalizes client-supplied attribution into the write-once User columns.
 * `src` wins over `utm_source`; a recruiter with no explicit source defaults to `invite`.
 * Values are free-form (no allowlist) so Marketing can add sources without a deploy.
 */
export function resolveSignupAttribution(
  input: SignupAttributionInput,
  opts: { referralApplied: boolean },
): SignupAttribution {
  const source = token(input?.src) ?? token(input?.utmSource) ?? (opts.referralApplied ? 'invite' : null);
  return {
    signupSource: source,
    signupMedium: token(input?.utmMedium),
    signupCampaign: token(input?.utmCampaign),
    signupLandingPath: landingPath(input?.landingPath),
    signupReferrerHost: hostname(input?.referrerHost),
  };
}
