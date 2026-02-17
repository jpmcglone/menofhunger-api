import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, OnModuleDestroy } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { QueueEvents } from 'bullmq';
import { MOH_BACKGROUND_QUEUE } from './jobs.constants';
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
  private readonly queueEvents: QueueEvents;

  constructor(
    @InjectQueue(MOH_BACKGROUND_QUEUE) private readonly queue: Queue,
    cfg: AppConfigService,
  ) {
    // QueueEvents is used only for optional admin `wait=true` flows.
    this.queueEvents = new QueueEvents(MOH_BACKGROUND_QUEUE, {
      connection: { url: cfg.redisUrl() },
    });
  }

  async onModuleDestroy() {
    await this.queueEvents.close().catch(() => undefined);
  }

  async getStatus(jobId: string): Promise<JobStatus> {
    const j = await this.queue.getJob(jobId);
    if (!j) return { status: 'not_found' };

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
    const j = await this.queue.getJob(jobId);
    if (!j) return { ok: false, reason: 'not_found' };
    try {
      const result = await j.waitUntilFinished(this.queueEvents, timeoutMs);
      return { ok: true, result };
    } catch (err) {
      return { ok: false, reason: (err as Error)?.message ?? 'wait_failed' };
    }
  }
}

