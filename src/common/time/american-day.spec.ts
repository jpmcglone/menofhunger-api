import { americanDay } from './american-day';

/** 16:00 UTC is the same Eastern calendar day in both standard time and daylight time. */
function et(isoDay: string): Date {
  return new Date(`${isoDay}T16:00:00.000Z`);
}

describe('american day', () => {
  it('uses the right line, and a holiday wins over Sunday', () => {
    expect(americanDay(et('2026-01-01'))?.line).toBe('Happy New Year.');
    expect(americanDay(et('2026-01-19'))?.line).toBe('In honor of Dr. King.');
    expect(americanDay(et('2026-04-03'))?.line).toBe('Good Friday.');
    expect(americanDay(et('2026-04-05'))?.line).toBe('He is risen.');
    expect(americanDay(et('2026-05-25'))?.line).toBe('We remember the fallen.');
    expect(americanDay(et('2026-07-04'))?.line).toBe('Happy Independence Day.');
    expect(americanDay(et('2026-09-07'))?.line).toBe('Happy Labor Day.');
    expect(americanDay(et('2026-11-11'))?.line).toBe('Honor those who served.');
    expect(americanDay(et('2026-11-26'))?.line).toBe('Give thanks.');
    expect(americanDay(et('2026-12-25'))?.line).toBe('Merry Christmas.');
    expect(americanDay(et('2026-06-07'))?.line).toBe("Happy Lord's Day.");
    expect(americanDay(et('2026-06-09'))).toBeNull();
  });

  it('overrides the check-in on a holiday and leaves Sunday on the rotation', () => {
    expect(americanDay(et('2026-05-25'))?.prompt).toBe(
      'Who are you remembering today, and what does their life ask of you?',
    );
    expect(americanDay(et('2026-06-07'))?.prompt).toBeNull();
  });
});
