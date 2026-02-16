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
   * Convenience helpers (stronger call sites + consistent dedupe IDs).
   */
  async enqueueCron(name: JobName, payload: Record<string, any> = {}, jobId: string, opts?: JobsOptions) {
    return await this.enqueue(name, payload, {
      jobId,
      removeOnComplete: true,
      removeOnFail: false,
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

