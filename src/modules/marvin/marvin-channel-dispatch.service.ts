import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { JobsService } from '../jobs/jobs.service';
import { JOBS } from '../jobs/jobs.constants';
import { PrismaService } from '../prisma/prisma.service';
import { SideEffectsRegistry } from '../side-effects/side-effects.registry';
import { MarvinBotIdentityService } from './services/marvin-bot-identity.service';

@Injectable()
export class MarvinChannelDispatchService implements OnModuleInit {
  private readonly logger = new Logger(MarvinChannelDispatchService.name);
  constructor(private readonly registry: SideEffectsRegistry, private readonly jobs: JobsService,
    private readonly prisma: PrismaService, private readonly identity: MarvinBotIdentityService) {}
  onModuleInit() {
    this.registry.register('channel.marv.request', async input => {
      // Marv takes part only where he is an active member of the group; the worker then checks channel access.
      const botId = await this.identity.getMarvUserId().catch(() => null);
      if (!botId || botId === input.requesterId) return;
      const membership = await this.prisma.communityGroupMember.findUnique({ where: { groupId_userId: { groupId: input.groupId, userId: botId } }, select: { status: true } });
      if (membership?.status !== 'active') return;
      const job = await this.jobs.enqueue(JOBS.marvinReplyChannel, input, { jobId: `channel-marv-${input.messageId}`, attempts: 3, backoff: { type: 'exponential', delay: 5000 } });
      this.logger.debug(`[marv] channel reply queued message=${input.messageId} job=${job.id}`);
    });
  }
}
