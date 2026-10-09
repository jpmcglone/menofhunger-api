import type { OutboundService } from "../outbound/outbound.service";
import type { AppConfigService } from "../app/app-config.service";
import type { PostsReadService } from "../posts-read/posts-read.service";
import type { PostsWriteService } from "../posts-read/posts-write.service";
import type { PresenceRealtimeService } from "../presence/presence-realtime.service";
import type { PrismaService } from "../prisma/prisma.service";
import type { IntegrationBudgetService } from "./integration-budget.service";
import type { XApiClient } from "./x-api.client";
import type { XConnectionService } from "./x-connection.service";
import { XArticleSyncService } from "./x-crosspost-article-sync";
import { XCrosspostOutcomeService } from "./x-crosspost-outcome.service";
import { XCrosspostPublishService } from "./x-crosspost-publish";
import { XCrosspostService } from "./x-crosspost.service";
import type { XUsageService } from "./x-usage.service";

/** Wires XCrosspostService and its collaborators by hand for unit tests (the module does this through DI). */
export function makeXCrosspostService(
  prisma: PrismaService,
  outbound: OutboundService,
  usage: XUsageService,
  appConfig: AppConfigService,
  connections: XConnectionService,
  api: XApiClient,
  realtime: PresenceRealtimeService,
  budgets: IntegrationBudgetService,
  postsRead: PostsReadService,
  postsWrite: PostsWriteService,
): XCrosspostService {
  const outcome = new XCrosspostOutcomeService(prisma, usage, realtime, postsWrite);
  const publisher = new XCrosspostPublishService(outcome, api, appConfig, budgets, connections, postsWrite, prisma, usage);
  const articleSync = new XArticleSyncService(outcome, publisher, api, appConfig, budgets, connections, prisma, usage);
  return new XCrosspostService(prisma, outbound, appConfig, connections, postsRead, outcome, publisher, articleSync);
}
