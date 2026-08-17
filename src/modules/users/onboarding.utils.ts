import { BadRequestException, ConflictException } from '@nestjs/common';
import { validateUsername } from './users.utils';

export const HEARD_ABOUT_US_VALUES = [
  'friend',
  'google',
  'x',
  'youtube',
  'nxr',
  'church',
  'podcast',
  'prefer_not',
  'other',
] as const;

export type HeardAboutUsValue = (typeof HEARD_ABOUT_US_VALUES)[number];

export const HEARD_ABOUT_US_OTHER_MAX = 80;

export function isFullyOnboarded(user: {
  usernameIsSet?: boolean | null;
  birthdate?: Date | string | null;
  interests?: unknown;
  menOnlyConfirmed?: boolean | null;
}): boolean {
  return Boolean(
    user.usernameIsSet
    && user.birthdate
    && Array.isArray(user.interests)
    && user.interests.length >= 1
    && user.menOnlyConfirmed,
  );
}

export function resolveHeardAboutUs(input: {
  heardAboutUs: HeardAboutUsValue;
  heardAboutUsOther?: string | null;
}): { heardAboutUs: HeardAboutUsValue; heardAboutUsOther: string | null } {
  if (input.heardAboutUs === 'other') {
    const other = (input.heardAboutUsOther ?? '').trim();
    if (!other) {
      throw new BadRequestException('Please tell us how you heard about us.');
    }
    return {
      heardAboutUs: 'other',
      heardAboutUsOther: other.slice(0, HEARD_ABOUT_US_OTHER_MAX),
    };
  }
  return { heardAboutUs: input.heardAboutUs, heardAboutUsOther: null };
}

export function resolveOnboardingUsername(input: {
  desired: string;
  currentUsername: string | null;
  usernameIsSet: boolean;
}): { username: string; usernameIsSet: true } | { username: string } | null {
  const desired = input.desired.trim();
  if (!desired) throw new BadRequestException('Username is required.');

  const current = (input.currentUsername ?? '').trim();
  const currentLower = current.toLowerCase();
  const desiredLower = desired.toLowerCase();

  if (input.usernameIsSet) {
    if (currentLower && currentLower === desiredLower) {
      return desired === current ? null : { username: desired };
    }
    throw new ConflictException('Username is already set.');
  }

  const validated = validateUsername(desired);
  if (!validated.ok) throw new BadRequestException(validated.error);
  return { username: validated.username, usernameIsSet: true };
}
