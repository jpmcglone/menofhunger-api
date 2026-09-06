import type { SessionResult } from '../auth/auth.service';

/** Administrator powers belong to the person's own session only. */
export function isOwnAdminSession(result: SessionResult | null): result is SessionResult {
  return Boolean(result?.user.siteAdmin && !result.impersonatedByUserId && !result.operatedByUserId);
}
