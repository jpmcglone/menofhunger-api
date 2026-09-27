import { easternYmd } from './eastern-day-key';

export type AmericanDay = {
  /** One quiet line for the top of the site and the app. */
  line: string;
  /** Replaces the rotating check-in prompt. Sunday without a holiday does not. */
  prompt: string | null;
};

function easterSunday(year: number): { month: number; day: number } {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return { month, day };
}

function nthWeekday(year: number, month: number, weekday: number, n: number): number {
  const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  return 1 + ((weekday - first + 7) % 7) + (n - 1) * 7;
}

function lastWeekday(year: number, month: number, weekday: number): number {
  const last = new Date(Date.UTC(year, month, 0));
  return last.getUTCDate() - ((last.getUTCDay() - weekday + 7) % 7);
}

function sameDay(month: number, day: number, targetMonth: number, targetDay: number): boolean {
  return month === targetMonth && day === targetDay;
}

/** Civic and church days on the Eastern calendar. A holiday wins over Sunday. */
export function americanDay(now: Date): AmericanDay | null {
  const { year, month, day } = easternYmd(now);
  const easter = easterSunday(year);
  const goodFriday = new Date(Date.UTC(year, easter.month - 1, easter.day) - 2 * 86_400_000);

  if (sameDay(month, day, 1, 1)) {
    return {
      line: 'Happy New Year.',
      prompt: 'What will you stop negotiating with yourself about this year?',
    };
  }
  if (sameDay(month, day, 1, nthWeekday(year, 1, 1, 3))) {
    return {
      line: 'In honor of Dr. King.',
      prompt: 'Where did you tell the truth today when it would have been easier to stay quiet?',
    };
  }
  if (sameDay(month, day, goodFriday.getUTCMonth() + 1, goodFriday.getUTCDate())) {
    return {
      line: 'Good Friday.',
      prompt: 'What did you owe someone today that you have not yet made right?',
    };
  }
  if (sameDay(month, day, easter.month, easter.day)) {
    return {
      line: 'He is risen.',
      prompt: 'Where do you need a new beginning, and what is the first thing you will do about it?',
    };
  }
  if (sameDay(month, day, 5, lastWeekday(year, 5, 1))) {
    return {
      line: 'We remember the fallen.',
      prompt: 'Who are you remembering today, and what does their life ask of you?',
    };
  }
  if (sameDay(month, day, 7, 4)) {
    return {
      line: 'Happy Independence Day.',
      prompt: 'What does this country ask of you, and did you do any of it today?',
    };
  }
  if (sameDay(month, day, 9, nthWeekday(year, 9, 1, 1))) {
    return {
      line: 'Happy Labor Day.',
      prompt: 'What work did you finish today that someone at home will feel?',
    };
  }
  if (sameDay(month, day, 11, 11)) {
    return {
      line: 'Honor those who served.',
      prompt: 'Who served so you could live this life, and how will you honor that today?',
    };
  }
  if (sameDay(month, day, 11, nthWeekday(year, 11, 4, 4))) {
    return {
      line: 'Give thanks.',
      prompt: 'Name what you were given today that you did not earn.',
    };
  }
  if (sameDay(month, day, 12, 25)) {
    return {
      line: 'Merry Christmas.',
      prompt: 'How did you love your people today, in the ordinary hours?',
    };
  }
  if (new Date(Date.UTC(year, month - 1, day)).getUTCDay() === 0) {
    return { line: "Happy Lord's Day.", prompt: null };
  }
  return null;
}

export function holidayCheckinPrompts(): string[] {
  return [
    'What will you stop negotiating with yourself about this year?',
    'Where did you tell the truth today when it would have been easier to stay quiet?',
    'What did you owe someone today that you have not yet made right?',
    'Where do you need a new beginning, and what is the first thing you will do about it?',
    'Who are you remembering today, and what does their life ask of you?',
    'What does this country ask of you, and did you do any of it today?',
    'What work did you finish today that someone at home will feel?',
    'Who served so you could live this life, and how will you honor that today?',
    'Name what you were given today that you did not earn.',
    'How did you love your people today, in the ordinary hours?',
  ];
}
