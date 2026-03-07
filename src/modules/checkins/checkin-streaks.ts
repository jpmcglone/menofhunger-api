export interface CheckinStreakStats {
  currentStreakDays: number;
  longestStreakDays: number;
  lastCheckinDayKey: string | null;
}

function utcNoonMs(dayKey: string): number {
  return new Date(`${dayKey}T12:00:00Z`).getTime();
}

function diffDays(a: string, b: string): number {
  return Math.round((utcNoonMs(a) - utcNoonMs(b)) / 86_400_000);
}

/**
 * Compute current + longest streak from ET day keys.
 * - `dayKeys` should be unique ET day keys in ascending order.
 * - Current streak is only active when last day is today or yesterday.
 */
export function computeCheckinStreakStats(params: {
  dayKeys: string[];
  todayKey: string;
  yesterdayKey: string;
}): CheckinStreakStats {
  const dayKeys = (params.dayKeys ?? []).filter(Boolean);
  if (dayKeys.length === 0) {
    return { currentStreakDays: 0, longestStreakDays: 0, lastCheckinDayKey: null };
  }

  let longest = 1;
  let run = 1;
  for (let i = 1; i < dayKeys.length; i++) {
    run = diffDays(dayKeys[i]!, dayKeys[i - 1]!) === 1 ? run + 1 : 1;
    if (run > longest) longest = run;
  }

  const last = dayKeys[dayKeys.length - 1] ?? null;
  let tail = 1;
  for (let i = dayKeys.length - 1; i > 0; i--) {
    if (diffDays(dayKeys[i]!, dayKeys[i - 1]!) === 1) tail++;
    else break;
  }

  const currentActive = last === params.todayKey || last === params.yesterdayKey;
  const current = currentActive ? tail : 0;

  return {
    currentStreakDays: current,
    longestStreakDays: Math.max(longest, current),
    lastCheckinDayKey: last,
  };
}
