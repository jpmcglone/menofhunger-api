/**
 * Ensures word_of_the_day and quote_of_the_day are in EMAIL_EXCLUDED_KINDS
 * so bulk fan-out notifications never trigger nudge/instant emails.
 */

import { EMAIL_EXCLUDED_KINDS } from './notification-read-state.service';

describe('EMAIL_EXCLUDED_KINDS', () => {
  it('excludes word_of_the_day', () => {
    expect(EMAIL_EXCLUDED_KINDS).toContain('word_of_the_day');
  });

  it('excludes quote_of_the_day', () => {
    expect(EMAIL_EXCLUDED_KINDS).toContain('quote_of_the_day');
  });

  it('still excludes message (pre-existing)', () => {
    expect(EMAIL_EXCLUDED_KINDS).toContain('message');
  });
});
