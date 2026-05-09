import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, type OnModuleInit } from '@nestjs/common';
import type { Job } from 'bullmq';
import { JOBS, MOH_MARVIN_QUEUE } from '../jobs/jobs.constants';
import { MarvinPublicReplyProcessor } from './jobs/marvin-public-reply.processor';
import { MarvinPrivateReplyProcessor } from './jobs/marvin-private-reply.processor';
import { MarvinContextCardsProcessor } from './jobs/marvin-context-cards.processor';
import { MarvinSummarizeThreadProcessor } from './jobs/marvin-summarize-thread.processor';
import { MarvinCostRollupProcessor } from './jobs/marvin-cost-rollup.processor';
import { AppConfigService } from '../app/app-config.service';

/**
 * BullMQ worker for the dedicated Marv queue (`MOH_MARVIN_QUEUE`).
 *
 * Marv runs on its own queue + processor — separate from the cron-heavy
 * `moh_background` queue — so that AI reply latency is never gated by a slow
 * notifications-email or hashtag-cleanup sweep. Concurrency is tuned by
 * `MARV_QUEUE_CONCURRENCY` (default 8). Because Marv work is I/O-bound (waiting on
 * OpenAI), high concurrency is safe; the realistic ceiling is your OpenAI org's TPM.
 *
 * The actual work still lives in the per-job processor classes (`MarvinPublicReplyProcessor`,
 * etc.) — this class is a thin dispatch table so the per-job classes remain easy to
 * unit test in isolation.
 */
@Processor(MOH_MARVIN_QUEUE)
export class MarvinProcessor extends WorkerHost implements OnModuleInit {
  private readonly logger = new Logger(MarvinProcessor.name);

  constructor(
    private readonly appConfig: AppConfigService,
    private readonly publicReply: MarvinPublicReplyProcessor,
    private readonly privateReply: MarvinPrivateReplyProcessor,
    private readonly contextCards: MarvinContextCardsProcessor,
    private readonly summarizeThread: MarvinSummarizeThreadProcessor,
    private readonly costRollup: MarvinCostRollupProcessor,
  ) {
    super();
  }

  /**
   * BullMQ reads `worker.opts.concurrency` at construction time. Returning the configured
   * value here lets us tune concurrency via env without restructuring the decorator.
   * Nest's `@Processor` decorator picks this up via `getWorker()` lifecycle.
   */
  // BullMQ's Worker reads concurrency from the options passed at construction; @nestjs/bullmq
  // does this via the decorator's options bag. We can't read AppConfigService at decorator
  // evaluation time, so instead we set it programmatically once the worker is created.
  async onModuleInit(): Promise<void> {
    const concurrency = this.appConfig.marvLimits().queueConcurrency;
    try {
      // Worker exposes `concurrency` setter; this is the supported way to tune it post-construct.
      this.worker.concurrency = concurrency;
      this.logger.log(`[marv] worker concurrency set to ${concurrency}`);
    } catch (err) {
      this.logger.warn(
        `[marv] could not set worker concurrency=${concurrency}: ${(err as Error).message}. Defaulting to BullMQ default (1).`,
      );
    }
  }

  override async process(job: Job): Promise<unknown> {
    const name = String(job.name ?? '');
    const startedAt = Date.now();
    try {
      switch (name) {
        case JOBS.marvinReplyPublic:
          await this.publicReply.process(job.data ?? {});
          return { ok: true };
        case JOBS.marvinReplyPrivate:
          await this.privateReply.process(job.data ?? {});
          return { ok: true };
        case JOBS.marvinContextCardsRefresh:
          await this.contextCards.process();
          return { ok: true };
        case JOBS.marvinSummarizeThread:
          await this.summarizeThread.process(job.data ?? {});
          return { ok: true };
        case JOBS.marvinCostRollup:
          await this.costRollup.process();
          return { ok: true };
        default:
          this.logger.warn(`Unknown Marv job name: ${name}`);
          return { ok: false, reason: 'unknown_job' };
      }
    } finally {
      const ms = Date.now() - startedAt;
      this.logger.debug(`Marv job ${name} done (${ms}ms)`);
    }
  }
}
