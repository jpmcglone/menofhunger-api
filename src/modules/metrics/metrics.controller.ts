import { Controller, Get } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { ActiveUsersMetricsDto } from '../../common/dto/metrics.dto';

@Controller('metrics')
export class MetricsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('active-users')
  async getActiveUsers() {
    const now = new Date();
    const maxWindowDays = 30;
    // Use UTC-midnight windows so “days” are stable and consistent.
    const todayUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

    // If the app hasn't been around for 30 days yet, use the available number of days.
    // We define "available" as the span from the earliest recorded activity day → today.
    const minDayRow = await this.prisma.$queryRaw<Array<{ min_day: Date | null }>>`
      SELECT MIN("day") AS min_day
      FROM "UserDailyActivity"
    `;
    const minDay = minDayRow?.[0]?.min_day ?? null;

    if (!minDay) {
      const data: ActiveUsersMetricsDto = {
        dau: 0,
        mau: 0,
        dauWindowDays: 0,
        mauWindowDays: 0,
        asOf: now.toISOString(),
      };
      return { data };
    }

    const minDayUtc = new Date(Date.UTC(minDay.getUTCFullYear(), minDay.getUTCMonth(), minDay.getUTCDate()));
    const daysAvailable = Math.max(1, Math.floor((todayUtc.getTime() - minDayUtc.getTime()) / (24 * 60 * 60 * 1000)) + 1);
    const windowDays = Math.min(maxWindowDays, daysAvailable);
    const startUtc = new Date(todayUtc.getTime() - (windowDays - 1) * 24 * 60 * 60 * 1000);

    // Average DAU over the last N days, including zero-activity days.
    // We use generate_series to ensure zeros are included.
    const dauAvgRow = await this.prisma.$queryRaw<Array<{ dau_avg: number | null }>>`
      WITH days AS (
        SELECT (DATE_TRUNC('day', ${todayUtc}::timestamptz) - (n * INTERVAL '1 day')) AS day
        FROM generate_series(0, ${windowDays - 1}) AS n
      ),
      counts AS (
        SELECT "day", COUNT(DISTINCT "userId")::float AS c
        FROM "UserDailyActivity"
        WHERE "day" >= ${startUtc}::timestamptz
        GROUP BY "day"
      )
      SELECT AVG(COALESCE(counts.c, 0)) AS dau_avg
      FROM days
      LEFT JOIN counts ON counts.day = days.day
    `;
    const dauAvgExact = dauAvgRow?.[0]?.dau_avg ?? 0;
    const dau = Math.max(0, Math.round(Number(dauAvgExact) || 0));

    // MAU = rolling unique actives over the same N-day window.
    const mauRow = await this.prisma.$queryRaw<Array<{ mau: number }>>`
      SELECT COUNT(DISTINCT "userId")::int AS mau
      FROM "UserDailyActivity"
      WHERE "day" >= ${startUtc}::timestamptz
    `;
    const mau = Math.max(0, Number(mauRow?.[0]?.mau ?? 0) || 0);

    const data: ActiveUsersMetricsDto = {
      dau,
      mau,
      dauWindowDays: windowDays,
      mauWindowDays: windowDays,
      asOf: now.toISOString(),
    };

    return { data };
  }
}

