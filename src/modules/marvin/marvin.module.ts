import { Module } from '@nestjs/common';
import { AppConfigModule } from '../app/app-config.module';
import { AuthModule } from '../auth/auth.module';
import { MessagesModule } from '../messages/messages.module';
import { PostsModule } from '../posts/posts.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { RedisModule } from '../redis/redis.module';
import { AdminGuard } from '../admin/admin.guard';
import { MarvinController } from './marvin.controller';
import { MarvinIdentityModule } from './marvin-identity.module';
import { MarvinCannedRepliesService } from './services/marvin-canned-replies.service';
import { MarvinCreditService } from './services/marvin-credit.service';
import { MarvinMentionDetectorService } from './services/marvin-mention-detector.service';
import { MarvinPromptBuilderService } from './services/marvin-prompt-builder.service';
import { MarvinRoutingService } from './services/marvin-routing.service';
import { MarvinUsageService } from './services/marvin-usage.service';
import { MarvinAIService } from './services/marvin-ai.service';
import { MarvinToolHandlersService } from './services/marvin-tool-handlers.service';
import { MarvinNonPremiumRepliesService } from './services/marvin-non-premium-replies.service';
import { MarvinPrivateCannedRepliesService } from './services/marvin-private-canned-replies.service';
import { MarvinAdminService } from './services/marvin-admin.service';
import { MarvinContextCardService } from './services/marvin-context-card.service';
import { MarvinThreadSummaryService } from './services/marvin-thread-summary.service';
import { MarvinPublicReplyProcessor } from './jobs/marvin-public-reply.processor';
import { MarvinPrivateReplyProcessor } from './jobs/marvin-private-reply.processor';
import { MarvinContextCardsCron } from './jobs/marvin-context-cards.cron';
import { MarvinContextCardsProcessor } from './jobs/marvin-context-cards.processor';
import { MarvinSummarizeThreadProcessor } from './jobs/marvin-summarize-thread.processor';
import { MarvinCostRollupCron } from './jobs/marvin-cost-rollup.cron';
import { MarvinCostRollupProcessor } from './jobs/marvin-cost-rollup.processor';
import { MarvinProcessor } from './marvin.processor';
import { LinkMetadataModule } from '../link-metadata/link-metadata.module';

/**
 * Marv (AI helper) module.
 *
 * Exports the services other modules need (mention detector, identity) so PostsService
 * and MessagesService can detect @marv mentions and enqueue jobs without a circular dep.
 *
 * Marv has its own dedicated BullMQ queue (`MOH_MARVIN_QUEUE`) handled by `MarvinProcessor`
 * with concurrency tuned via `MARV_QUEUE_CONCURRENCY` (default 8). This isolates AI reply
 * latency from the cron-heavy shared background queue.
 *
 * AdminGuard is locally provided so the admin sub-controller can be 404-gated without
 * pulling in the full AdminModule (which would create a cycle via PostsModule).
 */
@Module({
  imports: [AppConfigModule, AuthModule, RealtimeModule, PostsModule, MessagesModule, RedisModule, MarvinIdentityModule, LinkMetadataModule],
  controllers: [MarvinController],
  providers: [
    AdminGuard,
    MarvinMentionDetectorService,
    MarvinCreditService,
    MarvinRoutingService,
    MarvinPromptBuilderService,
    MarvinAIService,
    MarvinToolHandlersService,
    MarvinUsageService,
    MarvinCannedRepliesService,
    MarvinNonPremiumRepliesService,
    MarvinPrivateCannedRepliesService,
    MarvinAdminService,
    MarvinContextCardService,
    MarvinThreadSummaryService,
    MarvinPublicReplyProcessor,
    MarvinPrivateReplyProcessor,
    MarvinContextCardsCron,
    MarvinContextCardsProcessor,
    MarvinSummarizeThreadProcessor,
    MarvinCostRollupCron,
    MarvinCostRollupProcessor,
    MarvinProcessor,
  ],
  exports: [
    MarvinMentionDetectorService,
    MarvinCreditService,
    MarvinRoutingService,
    MarvinPromptBuilderService,
    MarvinAIService,
    MarvinToolHandlersService,
    MarvinUsageService,
    MarvinCannedRepliesService,
    MarvinNonPremiumRepliesService,
    MarvinPrivateCannedRepliesService,
    MarvinAdminService,
    MarvinContextCardService,
    MarvinThreadSummaryService,
    MarvinPublicReplyProcessor,
    MarvinPrivateReplyProcessor,
    MarvinContextCardsProcessor,
    MarvinSummarizeThreadProcessor,
    MarvinCostRollupProcessor,
  ],
})
export class MarvinModule {}
