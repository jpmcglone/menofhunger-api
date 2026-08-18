import { ForbiddenException } from '@nestjs/common';
import { HeardAboutUs } from '@prisma/client';

/** Parked phones stay unavailable this long after a convert-to-page. */
export const PARKED_PHONE_DAYS = 90;

export const PARKED_PHONE_REASON_CONVERT = 'convert_to_page';

/** Satisfies client onboarding age gates without inventing a real birthday. */
export const PAGE_BIRTHDATE = new Date(Date.UTC(1990, 0, 1));

/** Satisfies `needsOnboarding` (non-empty interests). */
export const PAGE_ONBOARDING_INTERESTS = ['community'];

export const PAGE_HEARD_ABOUT_US = HeardAboutUs.prefer_not;

export function assertPersonAccount(accountKind: string | null | undefined): void {
  if (accountKind === 'page') {
    throw new ForbiddenException('Switch back to your personal account to do this.');
  }
}
