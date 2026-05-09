import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, OnModuleDestroy } from '@nestjs/common';
import type { Job, Queue } from 'bullmq';
import { QueueEvents } from 'bullmq';
import { MOH_BACKGROUND_QUEUE, MOH_MARVIN_QUEUE } from './jobs.constants';
import { AppConfigService } from '../app/app-config.service';

export type JobStatus =
  | { status: 'not_found' }
  | {
      status: 'waiting' | 'delayed' | 'active' | 'completed' | 'failed' | 'paused';
      jobId: string;
      name: string;
      attemptsMade: number;
      processedOn: number | null;
      finishedOn: number | null;
      failedReason: string | null;
      returnValue: unknown | null;
    };

@Injectable()
export class JobsStatusService implements OnModuleDestroy {
  private readonly backgroundEvents: QueueEvents;
  private readonly marvinEvents: QueueEvents;

  constructor(
    @InjectQueue(MOH_BACKGROUND_QUEUE) private readonly backgroundQueue: Queue,
    @InjectQueue(MOH_MARVIN_QUEUE) private readonly marvinQueue: Queue,
    cfg: AppConfigService,
  ) {
    // QueueEvents is used only for optional admin `wait=true` flows.
    this.backgroundEvents = new QueueEvents(MOH_BACKGROUND_QUEUE, {
      connection: { url: cfg.redisUrl() },
    });
    this.marvinEvents = new QueueEvents(MOH_MARVIN_QUEUE, {
      connection: { url: cfg.redisUrl() },
    });
  }

  async onModuleDestroy() {
    await Promise.all([
      this.backgroundEvents.close().catch(() => undefined),
      this.marvinEvents.close().catch(() => undefined),
    ]);
  }

  /** Look up a job by id across both queues; returns the queue + job that owns it (if any). */
  private async findJob(jobId: string): Promise<{ queue: Queue; events: QueueEvents; job: Job } | null> {
    const fromBg = await this.backgroundQueue.getJob(jobId);
    if (fromBg) return { queue: this.backgroundQueue, events: this.backgroundEvents, job: fromBg };
    const fromMarvin = await this.marvinQueue.getJob(jobId);
    if (fromMarvin) return { queue: this.marvinQueue, events: this.marvinEvents, job: fromMarvin };
    return null;
  }

  async getStatus(jobId: string): Promise<JobStatus> {
    const found = await this.findJob(jobId);
    if (!found) return { status: 'not_found' };
    const j = found.job;

    const state = await j.getState();
    return {
      status: state as any,
      jobId: String(j.id ?? jobId),
      name: String(j.name ?? ''),
      attemptsMade: j.attemptsMade ?? 0,
      processedOn: typeof j.processedOn === 'number' ? j.processedOn : null,
      finishedOn: typeof j.finishedOn === 'number' ? j.finishedOn : null,
      failedReason: j.failedReason ? String(j.failedReason) : null,
      returnValue: (j as any).returnvalue ?? null,
    };
  }

  async waitForCompletion(jobId: string, timeoutMs: number): Promise<{ ok: true; result: unknown } | { ok: false; reason: string }> {
    const found = await this.findJob(jobId);
    if (!found) return { ok: false, reason: 'not_found' };
    try {
      const result = await found.job.waitUntilFinished(found.events, timeoutMs);
      return { ok: true, result };
    } catch (err) {
      return { ok: false, reason: (err as Error)?.message ?? 'wait_failed' };
    }
  }
}

