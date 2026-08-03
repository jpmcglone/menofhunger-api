import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import type { JobsOptions, Queue } from 'bullmq';
import {
  MOH_SIDE_EFFECTS_QUEUE,
  type SideEffectName,
  type SideEffectPayloads,
} from './side-effects.constants';
import { SideEffectsRegistry } from './side-effects.registry';

/**
 * The one seam every mutation uses to hand off post-commit work.
 *
 * Contract for callers:
 *   - Call it AFTER the transaction commits, as the last thing before returning the envelope.
 *   - Never `await` it and never handle its errors — it is synchronous and cannot throw.
 *   - Assume the handler may run on a different process, seconds later, possibly twice.
 *
 * Why a queue instead of `setImmediate`: `setImmediate` work dies with the process, so every
 * deploy or restart silently drops whatever fan-out was in flight, with no retry and no
 * record. BullMQ gives durability across restarts, bounded concurrency so fan-out can't
 * starve live requests, retries with backoff, and queue depth you can actually observe.
 */
@Injectable()
export class SideEffectsService {
  private readonly logger = new Logger(SideEffectsService.name);

  /** Retried a few times with backoff; handlers must therefore be idempotent. */
  private static readonly DEFAULT_JOB_OPTS: JobsOptions = {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5_000 },
    removeOnComplete: true,
    // Keep a bounded tail of failures so the admin readout can show what's breaking.
    removeOnFail: { count: 500 },
  };

  constructor(
    @InjectQueue(MOH_SIDE_EFFECTS_QUEUE) private readonly queue: Queue,
    private readonly registry: SideEffectsRegistry,
  ) {}

  /**
   * Hand a side effect to the queue. Fire-and-forget by design: returns immediately and
   * swallows every error so a Redis hiccup can never fail a user's write.
   *
   * `opts.jobId` gives you dedupe (BullMQ rejects a duplicate id, which we treat as a no-op) —
   * use it when the same logical effect could be dispatched twice.
   */
  dispatch<K extends SideEffectName>(
    name: K,
    payload: SideEffectPayloads[K],
    opts?: Pick<JobsOptions, 'jobId' | 'delay' | 'attempts'>,
  ): void {
    void this.queue
      .add(name, payload, { ...SideEffectsService.DEFAULT_JOB_OPTS, ...(opts ?? {}) })
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        // A duplicate jobId is the intended dedupe outcome, not a failure.
        if (opts?.jobId && /already exists/i.test(message)) return;
        this.logger.warn(`[side-effects] Enqueue of "${name}" failed (${message}); running in-process instead.`);
        this.runLocally(name, payload);
      });
  }

  /**
   * Last-resort fallback when Redis is unreachable: run the handler in this process.
   *
   * This is strictly worse than the queue (no retry, dies with the process) but it is what the
   * whole app did before the queue existed, so degrading to it beats dropping the effect. It
   * only works because handlers live in domain modules and are therefore registered in the API
   * process too, not only in the worker.
   */
  private runLocally<K extends SideEffectName>(name: K, payload: SideEffectPayloads[K]): void {
    const handler = this.registry.get(name);
    if (!handler) {
      this.logger.error(`[side-effects] No handler registered for "${name}"; effect dropped.`);
      return;
    }
    setImmediate(() => {
      void handler(payload).catch((err) => {
        this.logger.error(
          `[side-effects] In-process fallback for "${name}" failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    });
  }

  /** Queue handle for the admin health readout. */
  queueRef(): Queue {
    return this.queue;
  }
}
