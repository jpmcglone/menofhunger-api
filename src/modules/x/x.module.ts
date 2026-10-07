import { XPublishingService } from "./x-publishing.service";
import { IntegrationOperationsService } from "./integration-operations.service";
import { XPublicSnapshotService } from "./x-public-snapshot.service";
import { IntegrationAdminController } from "./integration-admin.controller";
import { IntegrationAdminService } from "./integration-admin.service";
import { XNewsService } from "./x-news.service";
import { XAuthorMetricsService } from "./x-author-metrics.service";
import { IntegrationBudgetService } from "./integration-budget.service";
import { XProfilePreviewService } from "./x-profile-preview.service";
import { XUsageService } from "./x-usage.service";
import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { PrismaModule } from "../prisma/prisma.module";
import { RealtimeModule } from "../realtime/realtime.module";
import { UsersModule } from "../users/users.module";
import { XApiClient } from "./x-api.client";
import { XConnectionService } from "./x-connection.service";
import { XCrosspostService } from "./x-crosspost.service";
import { XSideEffectsHandler } from "./x-side-effects.handler";
import { XController } from "./x.controller";

@Module({
  imports: [AuthModule, PrismaModule, RealtimeModule, UsersModule],
  controllers: [XController, IntegrationAdminController],
  providers: [
    XPublishingService,
    IntegrationOperationsService,
    XPublicSnapshotService,
    XNewsService,
    XAuthorMetricsService,
    IntegrationBudgetService,
    XProfilePreviewService,
    XUsageService,
    XApiClient,
    XConnectionService,
    XCrosspostService,
    XSideEffectsHandler,
    IntegrationAdminService,
  ],
  exports: [XCrosspostService, IntegrationAdminService],
})
export class XModule {}
