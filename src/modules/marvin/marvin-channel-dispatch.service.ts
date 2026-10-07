import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { JobsService } from '../jobs/jobs.service';
import { JOBS } from '../jobs/jobs.constants';
import { SideEffectsRegistry } from '../side-effects/side-effects.registry';

@Injectable()
export class MarvinChannelDispatchService implements OnModuleInit {
  private readonly logger = new Logger(MarvinChannelDispatchService.name);
  constructor(private readonly registry: SideEffectsRegistry, private readonly jobs: JobsService) {}
  onModuleInit() {
    this.registry.register('channel.marv.request', async input => {
      const job = await this.jobs.enqueue(JOBS.marvinReplyChannel, input, { jobId: `channel-marv-${input.messageId}`, attempts: 3, backoff: { type: 'exponential', delay: 5000 } });
      this.logger.debug(`[marv] channel reply queued message=${input.messageId} job=${job.id}`);
    });
  }
}
