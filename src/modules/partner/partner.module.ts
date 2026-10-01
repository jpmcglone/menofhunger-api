import { PartnerWebhooksService } from './partner-webhooks.service';
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AdminGuard } from '../admin/admin.guard';
import { PartnerAccessService } from './partner-access.service';
import { PartnerRateService } from './partner-rate.service';
import { PartnerOAuthService } from './partner-oauth.service';
import { PartnerReadService } from './partner-read.service';
import { PartnerController, PartnerGuard } from './partner.controller';
import { PartnerConnectionsController } from './partner-connections.controller';
import { AdminPartnersController } from './admin-partners.controller';
@Module({
  imports: [AuthModule],
  providers: [PartnerWebhooksService, PartnerAccessService, PartnerRateService, PartnerOAuthService, PartnerReadService, PartnerGuard, AdminGuard],
  controllers: [PartnerController, PartnerConnectionsController, AdminPartnersController],
  exports: [PartnerOAuthService],
})
export class PartnerModule {}
