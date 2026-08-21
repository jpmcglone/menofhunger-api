import type { FitnessShareSnapshotDto } from '../../common/dto/fitness.dto';

export function vo2maxShareSnapshot(params: {
  latest: { id: string; weightKg: number; measuredAt: Date };
  first: { id: string; weightKg: number; measuredAt: Date } | null;
}): FitnessShareSnapshotDto {
  const { latest, first } = params;
  const start = first && first.id !== latest.id ? first : null;
  return {
    type: 'vo2max',
    data: {
      vo2maxMlKgMin: latest.weightKg,
      measuredAt: latest.measuredAt.toISOString(),
      startVo2maxMlKgMin: start?.weightKg ?? null,
      startedAt: start?.measuredAt.toISOString() ?? null,
      deltaMlKgMin: start ? latest.weightKg - start.weightKg : null,
    },
  };
}
