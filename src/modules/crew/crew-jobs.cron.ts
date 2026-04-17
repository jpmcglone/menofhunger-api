import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { AppConfigService } from '../app/app-config.service';
import { JobsService } from '../jobs/jobs.service';
import { JOBS } from '../jobs/jobs.constants';
import { CrewInvitesService } from './crew-invites.service';
import { CrewTransferService } from './crew-transfer.service';

/**
 * Schedules and executes Crew background jobs:
 *  - `crew.invitesExpire` — flips stale pending invites past 14d to `expired`.
 *  - `crew.transferVotesExpire` — closes open transfer votes past 7d.
 *  - `crew.inactiveOwnerAutoTransfer` — rotates ownership when an owner has no
 *    UserDailyActivity rows for 30+ days.
 *
 * All run hourly; invite expiry is cheap and idempotent so we keep the cadence tight.
 */
@Injectable()
export class CrewJobsCron {
  private readonly logger = new Logger(CrewJobsCron.name);

  constructor(
    private readonly appConfig: AppConfigService,
    private readonly jobs: JobsService,
    private readonly invites: CrewInvitesService,
    private readonly transfer: CrewTransferService,
  ) {}

  private dayKey(d = new Date()): string {
    return d.toISOString().slice(0, 13); // hourly granularity for dedupe
  }

  @Cron('7 * * * *')
  async scheduleHourly(): Promise<void> {
    if (!this.appConfig.runSchedulers()) return;
    const key = this.dayKey();
    try {
      await this.jobs.enqueueCron(JOBS.crewInvitesExpire, {}, `cron-crewInvitesExpire-${key}`);
    } catch {}
    try {
      await this.jobs.enqueueCron(
        JOBS.crewTransferVotesExpire,
        {},
        `cron-crewTransferVotesExpire-${key}`,
      );
    } catch {}
  }

  @Cron('37 */6 * * *')
  async scheduleInactiveOwner(): Promise<void> {
    if (!this.appConfig.runSchedulers()) return;
    const key = this.dayKey();
    try {
      await this.jobs.enqueueCron(
        JOBS.crewInactiveOwnerAutoTransfer,
        {},
        `cron-crewInactiveOwnerAutoTransfer-${key}`,
      );
    } catch {}
  }

  async runExpireInvites(): Promise<void> {
    const count = await this.invites.expirePendingInvites();
    if (count > 0) this.logger.log(`[crew] expired ${count} invites`);
  }

  async runExpireTransferVotes(): Promise<void> {
    const count = await this.transfer.expireOpenVotes();
    if (count > 0) this.logger.log(`[crew] expired ${count} transfer votes`);
  }

  async runInactiveOwnerAutoTransfer(): Promise<void> {
    const rotated = await this.transfer.autoTransferInactiveOwners();
    if (rotated > 0) this.logger.log(`[crew] rotated ${rotated} inactive-owner crews`);
  }
}
