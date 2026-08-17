import { BadRequestException, ConflictException } from '@nestjs/common';
import {
  isFullyOnboarded,
  resolveHeardAboutUs,
  resolveOnboardingUsername,
} from './onboarding.utils';

describe('isFullyOnboarded', () => {
  const complete = {
    usernameIsSet: true,
    birthdate: new Date('1990-01-15T00:00:00.000Z'),
    interests: ['strength_training'],
    menOnlyConfirmed: true,
  };

  it('is true only when all four required fields are set', () => {
    expect(isFullyOnboarded(complete)).toBe(true);
  });

  it.each([
    ['username', { usernameIsSet: false }],
    ['birthday', { birthdate: null }],
    ['interests', { interests: [] }],
    ['men confirm', { menOnlyConfirmed: false }],
  ])('is false when %s is missing', (_label, patch) => {
    expect(isFullyOnboarded({ ...complete, ...patch })).toBe(false);
  });

  it('does not require heardAboutUs (legacy members stay complete)', () => {
    expect(isFullyOnboarded(complete)).toBe(true);
  });
});

describe('resolveHeardAboutUs', () => {
  it('clears other text for a named source', () => {
    expect(resolveHeardAboutUs({ heardAboutUs: 'google', heardAboutUsOther: 'ignored' })).toEqual({
      heardAboutUs: 'google',
      heardAboutUsOther: null,
    });
  });

  it('requires other text when source is other', () => {
    expect(() => resolveHeardAboutUs({ heardAboutUs: 'other', heardAboutUsOther: '  ' })).toThrow(
      BadRequestException,
    );
  });

  it('trims and keeps other text', () => {
    expect(resolveHeardAboutUs({ heardAboutUs: 'other', heardAboutUsOther: '  Meetup  ' })).toEqual({
      heardAboutUs: 'other',
      heardAboutUsOther: 'Meetup',
    });
  });
});

describe('resolveOnboardingUsername', () => {
  it('sets a new username', () => {
    expect(
      resolveOnboardingUsername({
        desired: 'PeterFinn',
        currentUsername: null,
        usernameIsSet: false,
      }),
    ).toEqual({ username: 'PeterFinn', usernameIsSet: true });
  });

  it('allows a case-only change once set', () => {
    expect(
      resolveOnboardingUsername({
        desired: 'PeterFinn',
        currentUsername: 'peterfinn',
        usernameIsSet: true,
      }),
    ).toEqual({ username: 'PeterFinn' });
  });

  it('no-ops when the username is unchanged', () => {
    expect(
      resolveOnboardingUsername({
        desired: 'PeterFinn',
        currentUsername: 'PeterFinn',
        usernameIsSet: true,
      }),
    ).toBeNull();
  });

  it('rejects a different username once set', () => {
    expect(() =>
      resolveOnboardingUsername({
        desired: 'SomeoneElse',
        currentUsername: 'PeterFinn',
        usernameIsSet: true,
      }),
    ).toThrow(ConflictException);
  });
});
