import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { JobsService } from '../jobs/jobs.service';
import { JOBS } from '../jobs/jobs.constants';
import { AppConfigService } from '../app/app-config.service';
import { DailyContentService } from './daily-content.service';
import {
  easternDayKey,
  easternMinuteOfDay,
} from '../../common/time/eastern-day-key';

@Injectable()
export class DailyContentCron {
  private readonly logger = new Logger(DailyContentCron.name);

  constructor(
    private readonly jobs: JobsService,
    private readonly appConfig: AppConfigService,
    private readonly dailyContent: DailyContentService,
  ) {}

  /**
   * Every 5 minutes: enqueue publish jobs for word (09:00 ET) and quote (09:30 ET)
   * if they haven't been published yet for today.
   */
  @Cron('*/5 * * * *')
  async schedulePublish(): Promise<void> {
    if (!this.appConfig.runSchedulers()) return;
    const now = new Date();
    const minuteOfDay = easternMinuteOfDay(now);
    const dayKey = easternDayKey(now);

    // Word publishes at 09:00 ET.
    if (minuteOfDay >= 9 * 60) {
      try {
        await this.jobs.enqueueCron(
          JOBS.dailyContentPublishWord,
          { item: 'word', dayKey },
          `cron:dailyContentPublishWord:${dayKey}`,
          { attempts: 3, backoff: { type: 'exponential', delay: 60_000 } },
        );
      } catch {
        // Duplicate jobId — already queued for today; treat as no-op.
      }
    }

    // Quote publishes at 09:30 ET.
    if (minuteOfDay >= 9 * 60 + 30) {
      try {
        await this.jobs.enqueueCron(
          JOBS.dailyContentPublishQuote,
          { item: 'quote', dayKey },
          `cron:dailyContentPublishQuote:${dayKey}`,
          { attempts: 3, backoff: { type: 'exponential', delay: 60_000 } },
        );
      } catch {
        // Duplicate jobId.
      }
    }
  }

  async runPublishWord(data: { item: string; dayKey: string }): Promise<void> {
    const dayKey = String(data?.dayKey ?? '');
    if (!dayKey) {
      this.logger.warn('[daily-content] runPublishWord called without dayKey');
      return;
    }
    const { published } = await this.dailyContent.publish({ item: 'word', dayKey });
    if (published) {
      this.logger.log(`[daily-content] word published for ${dayKey}`);
      try {
        await this.jobs.enqueueCron(
          JOBS.dailyContentFanoutWord,
          { item: 'word', dayKey },
          `cron:dailyContentFanoutWord:${dayKey}`,
          { attempts: 3, backoff: { type: 'exponential', delay: 30_000 } },
        );
      } catch {
        // Already queued — safe no-op.
      }
    }
  }

  async runPublishQuote(data: { item: string; dayKey: string }): Promise<void> {
    const dayKey = String(data?.dayKey ?? '');
    if (!dayKey) {
      this.logger.warn('[daily-content] runPublishQuote called without dayKey');
      return;
    }
    const { published } = await this.dailyContent.publish({ item: 'quote', dayKey });
    if (published) {
      this.logger.log(`[daily-content] quote published for ${dayKey}`);
      try {
        await this.jobs.enqueueCron(
          JOBS.dailyContentFanoutQuote,
          { item: 'quote', dayKey },
          `cron:dailyContentFanoutQuote:${dayKey}`,
          { attempts: 3, backoff: { type: 'exponential', delay: 30_000 } },
        );
      } catch {
        // Already queued — safe no-op.
      }
    }
  }
}
