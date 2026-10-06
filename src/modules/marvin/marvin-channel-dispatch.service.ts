import { Injectable, type OnModuleInit } from '@nestjs/common';
import { JobsService } from '../jobs/jobs.service';
import { JOBS } from '../jobs/jobs.constants';
import { SideEffectsRegistry } from '../side-effects/side-effects.registry';

@Injectable()
export class MarvinChannelDispatchService implements OnModuleInit {
  constructor(private readonly registry: SideEffectsRegistry, private readonly jobs: JobsService) {}
  onModuleInit() {
    this.registry.register('channel.marv.request', async input => {
      await this.jobs.enqueue(JOBS.marvinReplyChannel, input, { jobId: `channel-marv-${input.messageId}`, attempts: 3, backoff: { type: 'exponential', delay: 5000 } });
    });
  }
}
