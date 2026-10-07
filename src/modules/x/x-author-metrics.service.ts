import { XPublicSnapshotService } from "./x-public-snapshot.service";
import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { RedisService } from "../redis/redis.service";
import { AppConfigService } from "../app/app-config.service";
import { IntegrationBudgetService } from "./integration-budget.service";
import { X_REFERENCE_PRICES } from "./integration-budget.policy";
import { XApiClient } from "./x-api.client";
import { XConnectionService } from "./x-connection.service";
import type { XAuthorMetricsDto } from "../../common/dto/integrations.dto";

import { PostsReadService } from '../posts-read/posts-read.service';
@Injectable()
export class XAuthorMetricsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly config: AppConfigService,
    private readonly budgets: IntegrationBudgetService,
    private readonly api: XApiClient,
    private readonly connections: XConnectionService,
    private readonly snapshots: XPublicSnapshotService,
    private readonly postsRead: PostsReadService,
  ) {}

  async get(userId: string, postId: string): Promise<XAuthorMetricsDto | null> {
    const post = await this.postsRead.read.findFirst({
      where: {
        id: postId,
        userId,
        deletedAt: null,
        visibility: "public",
        isDraft: false,
      },
      select: { id: true },
    });
    if (!post) return null;
    const copy = await this.prisma.xCrosspost.findUnique({
      where: { kind_localId: { kind: "post", localId: postId } },
    });
    if (!copy?.remoteId || copy.userId !== userId || copy.lastError)
      return null;
    const key = `x:public-post-metrics:v1:${copy.remoteId}`;
    try {
      const cached = await this.redis.getJson<XAuthorMetricsDto>(key);
      if (cached && Date.parse(cached.expiresAt) > Date.now()) return cached;
      const durable = await this.snapshots.metrics(copy.remoteId, postId);
      if (durable) return durable;
      const recent = await this.prisma.xCrosspost.findMany({
        where: { userId, kind: "post", remoteId: { not: null } },
        orderBy: { createdAt: "desc" },
        take: 20,
        select: { id: true },
      });
      if (!recent.some((row) => row.id === copy.id)) return null;
      const conn = await this.connections.getActiveConnection(userId);
      const policy = this.config.integrationBudget();
      if (!conn || policy.priceVersion !== X_REFERENCE_PRICES.version)
        return null;
      return await this.redis.withLock(
        key + ":lock",
        { ttlMs: 60_000 },
        async () => {
          const cached = await this.redis.getJson<XAuthorMetricsDto>(key);
          if (cached && Date.parse(cached.expiresAt) > Date.now())
            return cached;
          const token = await this.connections.accessTokenFor(conn);
          const id = `x:analytics:${copy.remoteId}:${new Date().toISOString().slice(0, 10)}`;
          if (
            !(await this.budgets.reserve(
              {
                id,
                userId,
                externalAccountId: conn.xUserId,
                provider: "x",
                action: "analytics",
                bucket: "regular",
                maximumMicros: X_REFERENCE_PRICES.postRead,
              },
              policy,
            ))
          )
            return null;
          await this.budgets.settle(id, "uncertain");
          const metrics = await this.api.getPublicPostMetrics(
            token,
            copy.remoteId!,
          );
          await this.budgets.settle(id, "settled");
          if (!metrics) {
            await this.snapshots.invalidate("x-metrics", copy.remoteId!);
            return null;
          }
          const now = new Date();
          const result: XAuthorMetricsDto = {
            postId,
            externalUrl: `https://x.com/i/status/${copy.remoteId}`,
            fetchedAt: now.toISOString(),
            expiresAt: new Date(now.getTime() + 86_400_000).toISOString(),
            ...metrics,
          };
          await this.snapshots.saveMetrics(copy.remoteId!, result);
          await this.redis.setJson(key, result, { ttlSeconds: 86_400 });
          return result;
        },
      );
    } catch {
      return this.snapshots.metrics(copy.remoteId, postId).catch(() => null);
    }
  }
}
