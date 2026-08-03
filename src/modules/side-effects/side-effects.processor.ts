import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, type OnModuleInit } from '@nestjs/common';
import type { Job } from 'bullmq';
import { AppConfigService } from '../app/app-config.service';
import { MOH_SIDE_EFFECTS_QUEUE, type SideEffectName } from './side-effects.constants';
import { SideEffectsRegistry } from './side-effects.registry';

/**
 * Worker for the side-effects queue.
 *
 * Deliberately has no dispatch table: it looks the handler up in `SideEffectsRegistry`, so
 * adding a new side effect never requires editing this file. Job names ARE effect names.
 */
@Processor(MOH_SIDE_EFFECTS_QUEUE)
export class SideEffectsProcessor extends WorkerHost implements OnModuleInit {
  private readonly logger = new Logger(SideEffectsProcessor.name);

  constructor(
    private readonly registry: SideEffectsRegistry,
    private readonly appConfig: AppConfigService,
  ) {
    super();
  }

  /**
   * BullMQ reads concurrency from the options passed at Worker construction, and we can't read
   * AppConfigService at decorator-evaluation time — so set it once the worker exists (same
   * approach as MarvinProcessor).
   */
  onModuleInit(): void {
    const concurrency = this.appConfig.sideEffectsQueueConcurrency();
    try {
      this.worker.concurrency = concurrency;
      this.logger.log(
        `[side-effects] worker concurrency=${concurrency}, handlers=[${this.registry.names().join(', ')}]`,
      );
    } catch (err) {
      this.logger.warn(
        `[side-effects] could not set worker concurrency=${concurrency}: ${(err as Error).message}. Using BullMQ default.`,
      );
    }
  }

  override async process(job: Job): Promise<unknown> {
    const name = String(job.name ?? '') as SideEffectName;
    const handler = this.registry.get(name);
    if (!handler) {
      // Don't retry: a missing handler won't appear on the next attempt. Most likely cause is
      // a job enqueued by a newer deploy being picked up by an older worker.
      this.logger.warn(`[side-effects] No handler registered for "${name}"; discarding job ${job.id}.`);
      return { ok: false, reason: 'unknown_side_effect' };
    }

    const startedAt = Date.now();
    try {
      await handler(job.data ?? {});
      return { ok: true };
    } finally {
      this.logger.debug(`[side-effects] ${name} done (${Date.now() - startedAt}ms)`);
    }
  }
}
