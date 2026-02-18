export type CheckinRewardInput = {
  todayKey: string;
  yesterdayKey: string;
  lastCheckinDayKey: string | null;
  currentStreakDays: number;
};

export type CheckinRewardOutput = {
  nextStreakDays: number;
  coinsAdd: number;
  multiplier: 1 | 2 | 3 | 4;
};

export function computeCheckinRewards(input: CheckinRewardInput): CheckinRewardOutput {
  const todayKey = (input.todayKey ?? '').trim();
  const yesterdayKey = (input.yesterdayKey ?? '').trim();
  const lastKey = (input.lastCheckinDayKey ?? '').trim() || null;
  const currentStreakDays = Number.isFinite(input.currentStreakDays) ? Math.max(0, Math.floor(input.currentStreakDays)) : 0;

  if (!todayKey) throw new Error('todayKey is required');
  if (!yesterdayKey) throw new Error('yesterdayKey is required');
  if (lastKey && lastKey === todayKey) throw new Error('already_checked_in_today');

  const nextStreakDays = lastKey && lastKey === yesterdayKey ? currentStreakDays + 1 : 1;
  const multiplier = (nextStreakDays >= 22 ? 4 : nextStreakDays >= 15 ? 3 : nextStreakDays >= 8 ? 2 : 1) as 1 | 2 | 3 | 4;
  const coinsAdd = multiplier;
  return { nextStreakDays, coinsAdd, multiplier };
}

