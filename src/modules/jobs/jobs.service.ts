import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import type { Job, JobsOptions, Queue } from 'bullmq';
import { JOBS, MOH_BACKGROUND_QUEUE, type JobName } from './jobs.constants';

@Injectable()
export class JobsService {
  constructor(@InjectQueue(MOH_BACKGROUND_QUEUE) private readonly queue: Queue) {}

  /**
   * Enqueue a job, optionally with a stable jobId for dedupe (best for crons).
   * If a job with the same jobId already exists, BullMQ throws; callers may treat as a no-op.
   */
  async enqueue<TPayload extends Record<string, any> = Record<string, any>>(
    name: JobName,
    payload: TPayload,
    opts?: JobsOptions,
  ): Promise<Job<TPayload, any, string>> {
    return await this.queue.add(name, payload, opts);
  }

  /**
   * Enqueue a periodic cron job with a stable dedupe ID.
   *
   * jobId rules (BullMQ v5):
   *   - No colons at all (e.g. "cron-postsPopularScoreRefresh")  ← preferred
   *   - OR exactly 3 colon-separated parts                       ← kept for date-keyed IDs
   * Any other colon usage throws at the BullMQ layer. We validate early to surface a clear
   * error instead of a silent swallow in the cron's catch block.
   */
  async enqueueCron(name: JobName, payload: Record<string, any> = {}, jobId: string, opts?: JobsOptions) {
    if (jobId.includes(':') && jobId.split(':').length !== 3) {
      throw new Error(
        `Invalid cron jobId "${jobId}": BullMQ v5 only permits colons in 3-part IDs ` +
          `(e.g. "cron:name:${new Date().toISOString().slice(0, 10)}"). Use dashes for static IDs (e.g. "cron-${name}").`,
      );
    }
    return await this.enqueue(name, payload, {
      jobId,
      removeOnComplete: true,
      removeOnFail: true,
      ...opts,
    });
  }

  jobNames() {
    return JOBS;
  }

  queueName() {
    return MOH_BACKGROUND_QUEUE;
  }
}

