import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { AppConfigService } from '../app/app-config.service';
import { JobsService } from '../jobs/jobs.service';
import { JOBS } from '../jobs/jobs.constants';
import { AccountDeletionService } from './account-deletion.service';

@Injectable()
export class AccountDeletionFinalizeCron {
  private readonly logger = new Logger(AccountDeletionFinalizeCron.name);
  private running = false;

  constructor(
    private readonly accountDeletion: AccountDeletionService,
    private readonly jobs: JobsService,
    private readonly appConfig: AppConfigService,
  ) {}

  /**
   * Finalize self-service account deletions after their 30-day grace period.
   * Safe to run repeatedly; only pending rows past deletionScheduledAt are processed.
   */
  @Cron('0 */6 * * *')
  async finalizeDueAccountDeletions() {
    if (!this.appConfig.runSchedulers()) return;
    try {
      await this.jobs.enqueueCron(JOBS.accountDeletionFinalize, {}, 'cron-accountDeletionFinalize', {
        attempts: 2,
        backoff: { type: 'exponential', delay: 5 * 60_000 },
      });
    } catch {
      // likely duplicate jobId while previous run is active; treat as no-op
    }
  }

  async runFinalizeDueAccountDeletions() {
    if (this.running) return;
    this.running = true;
    const startedAt = Date.now();
    try {
      const { finalized } = await this.accountDeletion.finalizeDueDeletions();
      const ms = Date.now() - startedAt;
      if (finalized > 0) {
        this.logger.log(`Account deletion finalize: finalized=${finalized} (${ms}ms)`);
      }
    } catch (err) {
      this.logger.warn(`Account deletion finalize failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
