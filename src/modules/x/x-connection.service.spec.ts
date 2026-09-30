import { allowanceFromSpent, monthStartUtc } from './x-connection.service';
import { hasRequiredXScopes, isXUsername } from './x-api.client';
import { X_LINK_COST_MICROS, X_NATIVE_COST_MICROS } from '../../common/crosspost/crosspost-eligibility';

describe('X allowance', () => {
  it('turns a $3 budget into link and native counts', () => {
    expect(allowanceFromSpent(0, 300)).toEqual({ linkPostsLeft: 15, nativePostsLeft: 200 });
    expect(allowanceFromSpent(X_LINK_COST_MICROS, 300)).toEqual({ linkPostsLeft: 14, nativePostsLeft: 186 });
    expect(allowanceFromSpent(300 * 10_000, 300).linkPostsLeft).toBe(0);
    expect(allowanceFromSpent(300 * 10_000 - X_NATIVE_COST_MICROS, 300).nativePostsLeft).toBe(1);
  });

  it('starts the month on the first UTC day', () => {
    expect(monthStartUtc(new Date('2026-09-29T23:00:00.000Z')).toISOString()).toBe('2026-09-01T00:00:00.000Z');
  });
});

describe('X account checks', () => {
  it('requires every posting scope and a normal handle', () => {
    expect(hasRequiredXScopes('tweet.read tweet.write users.read media.write offline.access')).toBe(true);
    expect(hasRequiredXScopes('tweet.read users.read')).toBe(false);
    expect(hasRequiredXScopes('')).toBe(false);
    expect(isXUsername('TheMcGloneCode')).toBe(true);
    expect(isXUsername('bad name')).toBe(false);
    expect(isXUsername('waytoolonghandle1')).toBe(false);
  });
});
