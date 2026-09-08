import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { JobsService } from '../jobs/jobs.service';
import { JOBS } from '../jobs/jobs.constants';
import { AppConfigService } from '../app/app-config.service';
import { DailyContentService } from './daily-content.service';
import { PresenceRealtimeService } from '../presence/presence-realtime.service';
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
    private readonly realtime: PresenceRealtimeService,
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
    await this.publishAndNotify('word', dayKey);
  }

  async runPublishQuote(data: { item: string; dayKey: string }): Promise<void> {
    const dayKey = String(data?.dayKey ?? '');
    if (!dayKey) {
      this.logger.warn('[daily-content] runPublishQuote called without dayKey');
      return;
    }
    await this.publishAndNotify('quote', dayKey);
  }

  private async publishAndNotify(item: 'word' | 'quote', dayKey: string): Promise<void> {
    await this.dailyContent.publish({ item, dayKey });
    // Also resume after a prior attempt committed but failed before enqueueing fan-out.
    if (!(await this.dailyContent.isPublished(item, dayKey))) {
      throw new Error(`[daily-content] ${item} is not ready for ${dayKey}`);
    }
    if (await this.dailyContent.isNotified(item, dayKey)) return;
    await this.realtime.emitDailyContentPublished(item, dayKey);
    const job = item === 'word' ? JOBS.dailyContentFanoutWord : JOBS.dailyContentFanoutQuote;
    // BullMQ deduplicates job IDs. Real enqueue failures must propagate for retry.
    await this.jobs.enqueueCron(
      job, { item, dayKey },
      `cron:dailyContentFanout${item === 'word' ? 'Word' : 'Quote'}:${dayKey}`,
      { attempts: 3, backoff: { type: 'exponential', delay: 30_000 } },
    );
  }
}
