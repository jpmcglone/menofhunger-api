import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { AppConfigService } from '../app/app-config.service';
import { PrismaService } from '../prisma/prisma.service';
import { FitnessService } from './fitness.service';
import { runInBatches } from '../side-effects/batch';

/**
 * Every 6 hours: sync Strava for every user who has an active Strava connection.
 *
 * Uses the same `syncStrava(userId)` path as the manual button — which is already
 * incremental (only fetches activities since `lastSyncAt`). Connections synced in
 * the last 2 hours are skipped to avoid hammering Strava when a user also hits
 * "Sync now" manually shortly before the cron fires.
 *
 * Strava rate limit: 100 req/15 min, 1 000/day per app. Each sync paginates
 * activity lists, then enriches a bounded batch of details+streams. Remaining
 * incomplete raw payloads are filled on GET /fitness/activities/:id or the next sync.
 * Processing 3 users concurrently keeps us inside the limit for typical user counts.
 */
@Injectable()
export class FitnessCron {
  private readonly logger = new Logger(FitnessCron.name);

  private static readonly SKIP_IF_SYNCED_WITHIN_MS = 2 * 60 * 60 * 1000; // 2 h
  private static readonly SYNC_CONCURRENCY = 3;

  constructor(
    private readonly appConfig: AppConfigService,
    private readonly prisma: PrismaService,
    private readonly fitness: FitnessService,
  ) {}

  @Cron('47 */6 * * *')
  async syncAllStrava(): Promise<void> {
    if (!this.appConfig.runSchedulers()) return;

    const cutoff = new Date(Date.now() - FitnessCron.SKIP_IF_SYNCED_WITHIN_MS);

    const connections = await this.prisma.fitnessConnection.findMany({
      where: {
        provider: 'strava',
        status: 'active',
        OR: [{ lastSyncAt: null }, { lastSyncAt: { lt: cutoff } }],
      },
      select: { userId: true },
    });

    if (connections.length === 0) return;

    this.logger.log(`[fitness-cron] syncing ${connections.length} Strava connection(s)`);

    const { ok, failed } = await runInBatches(
      connections,
      FitnessCron.SYNC_CONCURRENCY,
      async ({ userId }) => {
        const result = await this.fitness.syncStrava(userId);
        if (result.inserted > 0) {
          this.logger.log(`[fitness-cron] userId=${userId} +${result.inserted} inserted, ${result.deduped} deduped`);
        }
      },
    );

    this.logger.log(`[fitness-cron] done — ok=${ok} failed=${failed}`);
  }
}
