import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, OnModuleDestroy } from '@nestjs/common';
import type { Job, Queue } from 'bullmq';
import { QueueEvents } from 'bullmq';
import { MOH_BACKGROUND_QUEUE, MOH_MARVIN_QUEUE } from './jobs.constants';
import { MOH_SIDE_EFFECTS_QUEUE } from '../side-effects/side-effects.constants';
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

/** Depth + liveness readout for one BullMQ queue. */
export type QueueHealth = {
  name: string;
  /** Consumers currently registered with Redis for this queue. Zero means nothing is draining it. */
  workers: number;
  waiting: number;
  active: number;
  delayed: number;
  failed: number;
  paused: boolean;
  /** Set when the readout itself failed (Redis down); the counts are then all zero. */
  error: string | null;
};

export type QueuesHealth = {
  queues: QueueHealth[];
  /** False when any queue has no registered worker — the one question this endpoint exists to answer. */
  allQueuesHaveWorkers: boolean;
};

@Injectable()
export class JobsStatusService implements OnModuleDestroy {
  private readonly backgroundEvents: QueueEvents;
  private readonly marvinEvents: QueueEvents;

  constructor(
    @InjectQueue(MOH_BACKGROUND_QUEUE) private readonly backgroundQueue: Queue,
    @InjectQueue(MOH_MARVIN_QUEUE) private readonly marvinQueue: Queue,
    @InjectQueue(MOH_SIDE_EFFECTS_QUEUE) private readonly sideEffectsQueue: Queue,
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

  /**
   * Per-queue worker count and backlog depth.
   *
   * "Is a worker actually running?" used to be answerable only by reading deploy config and
   * guessing. `getWorkers()` asks Redis which consumers have registered for the queue, so a
   * `RUN_JOB_CONSUMERS=false` misconfiguration shows up as `workers: 0` instead of as
   * notifications quietly never arriving. Rising `waiting` or `failed` is the other half:
   * a worker that is alive but losing.
   */
  async getQueuesHealth(): Promise<QueuesHealth> {
    const queues: Queue[] = [this.backgroundQueue, this.marvinQueue, this.sideEffectsQueue];
    const readouts = await Promise.all(queues.map((q) => this.readQueueHealth(q)));
    return {
      queues: readouts,
      allQueuesHaveWorkers: readouts.every((q) => q.workers > 0),
    };
  }

  private async readQueueHealth(queue: Queue): Promise<QueueHealth> {
    const name = queue.name;
    try {
      const [workers, waiting, active, delayed, failed, paused] = await Promise.all([
        queue.getWorkers(),
        queue.getWaitingCount(),
        queue.getActiveCount(),
        queue.getDelayedCount(),
        queue.getFailedCount(),
        queue.isPaused(),
      ]);
      return {
        name,
        workers: workers.length,
        waiting,
        active,
        delayed,
        failed,
        paused,
        error: null,
      };
    } catch (err) {
      return {
        name,
        workers: 0,
        waiting: 0,
        active: 0,
        delayed: 0,
        failed: 0,
        paused: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
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

