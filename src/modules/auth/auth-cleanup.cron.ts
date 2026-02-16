import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { JobsService } from '../jobs/jobs.service';
import { JOBS } from '../jobs/jobs.constants';
import { AppConfigService } from '../app/app-config.service';

@Injectable()
export class AuthCleanupCron {
  private readonly logger = new Logger(AuthCleanupCron.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobsService,
    private readonly appConfig: AppConfigService,
  ) {}

  /**
   * Housekeeping: remove expired auth records so tables don't grow forever.
   * Safe to run repeatedly.
   */
  @Cron('0 */6 * * *')
  async cleanupExpiredAuthRecords() {
    if (!this.appConfig.runSchedulers()) return;
    try {
      await this.jobs.enqueueCron(JOBS.authCleanup, {}, 'cron:authCleanup', {
        attempts: 2,
        backoff: { type: 'exponential', delay: 5 * 60_000 },
      });
    } catch {
      // likely duplicate jobId while previous run is active; treat as no-op
    }
  }

  async runCleanupExpiredAuthRecords() {
    if (this.running) return;
    this.running = true;
    const startedAt = Date.now();
    try {
      const now = new Date();

      const [sessions, otps] = await this.prisma.$transaction([
        this.prisma.session.deleteMany({ where: { expiresAt: { lt: now } } }),
        this.prisma.phoneOtp.deleteMany({ where: { expiresAt: { lt: now } } }),
      ]);

      const ms = Date.now() - startedAt;
      if ((sessions.count ?? 0) > 0 || (otps.count ?? 0) > 0) {
        this.logger.log(`Auth cleanup: sessions=${sessions.count} phoneOtps=${otps.count} (${ms}ms)`);
      }
    } catch (err) {
      this.logger.warn(`Auth cleanup failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}

