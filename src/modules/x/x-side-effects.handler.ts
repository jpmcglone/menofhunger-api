import { XPublishingService } from "./x-publishing.service";
import { XPublicSnapshotService } from "./x-public-snapshot.service";
import { IntegrationBudgetService } from "./integration-budget.service";
import { X_REFERENCE_PRICES } from "./integration-budget.policy";
import { AppConfigService } from "../app/app-config.service";
import { RedisService } from "../redis/redis.service";
import { Injectable, OnModuleInit } from "@nestjs/common";
import { SideEffectsRegistry } from "../side-effects/side-effects.registry";
import {
  OutboundService,
  OutboundAttentionError,
} from "../outbound/outbound.service";
import { XCrosspostService } from "./x-crosspost.service";
import { XConnectionService } from "./x-connection.service";
import { XApiClient } from "./x-api.client";
import { PrismaService } from "../prisma/prisma.service";
@Injectable()
export class XSideEffectsHandler implements OnModuleInit {
  constructor(
    private readonly registry: SideEffectsRegistry,
    private readonly crosspost: XCrosspostService,
    private readonly outbound: OutboundService,
    private readonly connections: XConnectionService,
    private readonly api: XApiClient,
    private readonly prisma: PrismaService,
    private readonly budgets: IntegrationBudgetService,
    private readonly config: AppConfigService,
    private readonly redis: RedisService,
    private readonly snapshots: XPublicSnapshotService,
    private readonly publishing: XPublishingService,
  ) {}
  onModuleInit() {
    this.registry.register("x.post.sync", async (p) => {
      const mapping = await this.prisma.xCrosspost.findUnique({
        where: { kind_localId: { kind: "post", localId: p.postId } },
      });
      if (mapping)
        await this.outbound.ensure(
          mapping.userId,
          "x",
          "post",
          p.postId,
          mapping.mode,
        );
    });
    this.registry.register("x.article.sync", async (p) => {
      const mapping = await this.prisma.xCrosspost.findUnique({
        where: { kind_localId: { kind: "article", localId: p.articleId } },
      });
      if (mapping)
        await this.outbound.ensure(
          mapping.userId,
          "x",
          "article",
          p.articleId,
          mapping.mode,
        );
    });
    this.outbound.register("x", {
      send: async (row) => {
        const planned =
          row.resourceKind === "post" &&
          (await this.prisma.xCrosspost.findUnique({
            where: { kind_localId: { kind: "post", localId: row.resourceId } },
          }));
        if (planned && planned.deliveryPlan) {
          await this.publishing.send(row);
          return;
        }
        if (row.action === "update")
          throw new OutboundAttentionError(
            "X copies cannot be edited automatically.",
          );
        const kind = row.resourceKind as "post" | "article";
        await this.prisma.xCrosspost.upsert({
          where: { kind_localId: { kind, localId: row.resourceId } },
          create: {
            userId: row.userId,
            kind,
            localId: row.resourceId,
            mode: row.mode as "link" | "native",
          },
          update: {},
        });
        if (kind === "post")
          await this.crosspost.syncPost(
            row.resourceId,
            row.connectionGeneration,
          );
        else
          await this.crosspost.syncArticle(
            row.resourceId,
            row.connectionGeneration,
          );
      },
      remove: async (row) => {
        if (!row.remoteId) return;
        const connection = await this.connections.getActiveConnection(
          row.userId,
        );
        if (!connection || connection.generation !== row.connectionGeneration)
          throw new Error("Original connection unavailable.");
        const token = await this.connections.accessTokenFor(connection);
        const mapping = await this.prisma.xCrosspost.findUnique({
          where: {
            kind_localId: {
              kind: row.resourceKind as "post" | "article",
              localId: row.resourceId,
            },
          },
        });
        const ids = [...new Set([row.remoteId, ...(mapping?.remoteIds ?? [])])];
        const policy = this.config.integrationBudget("reserve");
        const operation = `x:remove:${row.id}:${row.attempts + 1}`;
        if (policy.enabled) {
          if (
            policy.priceVersion !== X_REFERENCE_PRICES.version ||
            !(await this.budgets.reserve(
              {
                id: operation,
                provider: "x",
                externalAccountId: connection.xUserId,
                action: "remove",
                bucket: "reserve",
                maximumMicros: X_REFERENCE_PRICES.manageContent * ids.length,
              },
              policy,
            ))
          ) {
            throw new OutboundAttentionError(
              "Remote removal needs funded operating capacity. Remove the copy on X or restore capacity.",
            );
          }
          await this.budgets.settle(operation, "uncertain");
        }
        for (const id of ids) {
          await this.api.deletePost(token, id);
          await this.snapshots.invalidate("x-metrics", id);
          await this.redis.raw().del(`x:public-post-metrics:v1:${id}`);
        }
        if (policy.enabled) await this.budgets.settle(operation, "settled");
        await this.snapshots.invalidate("x-metrics", row.remoteId);
        await this.redis.raw().del(`x:public-post-metrics:v1:${row.remoteId}`);
      },
    });
  }
}
