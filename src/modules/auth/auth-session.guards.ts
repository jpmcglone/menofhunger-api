import { ForbiddenException } from '@nestjs/common';
import type { SessionResult } from './auth.service';

/**
 * Irreversible account-level actions are refused while a site admin is impersonating.
 * An admin debugging someone's account must never be able to delete it or sign them out
 * of all their devices.
 */
export function assertNotImpersonating(session: SessionResult | null, action: string): void {
  if (!session?.impersonatedByUserId) return;
  throw new ForbiddenException({
    message: `You are signed in as another user. Exit impersonation before trying to ${action}.`,
    error: 'impersonation_forbidden',
  });
}
