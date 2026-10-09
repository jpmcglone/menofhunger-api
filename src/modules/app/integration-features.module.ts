import { Module } from '@nestjs/common';
import { AdminModule } from '../admin/admin.module';
import { McpModule } from '../mcp/mcp.module';
import { PartnerModule } from '../partner/partner.module';
import { PickaxModule } from '../pickax/pickax.module';
import { XModule } from '../x/x.module';
import { ProfileLinksModule } from '../profile-links/profile-links.module';
import { SlackModule } from '../../common/slack/slack.module';
import { PosthogModule } from '../../common/posthog/posthog.module';
import { MetricsModule } from '../metrics/metrics.module';
import { HealthModule } from '../health/health.module';
import { TypeSafeModule } from '../typesafe/typesafe.module';
import { AiUtilityModule } from '../ai/ai-utility.module';
import { MarvinIdentityModule } from '../marvin/marvin-identity.module';
import { MarvinModule } from '../marvin/marvin.module';

/** Aggregate wiring for admin, Marv/AI, partner, and third-party integrations. Imports only; providers stay scoped to their own modules. */
@Module({
  imports: [
    AdminModule,
    McpModule,
    PartnerModule,
    PickaxModule,
    XModule,
    ProfileLinksModule,
    SlackModule,
    PosthogModule,
    MetricsModule,
    HealthModule,
    TypeSafeModule,
    AiUtilityModule,
    MarvinIdentityModule,
    MarvinModule,
  ],
})
export class IntegrationFeaturesModule {}
