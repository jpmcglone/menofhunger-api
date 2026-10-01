import { Injectable, OnModuleInit } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { z } from "zod";
import { AppConfigService } from "../app/app-config.service";
import { RedisService } from "../redis/redis.service";
import { SideEffectsRegistry } from "../side-effects/side-effects.registry";
import { SideEffectsService } from "../side-effects/side-effects.service";
import { IntegrationBudgetService } from "./integration-budget.service";
import { XConnectionService } from "./x-connection.service";
import { XApiClient } from "./x-api.client";
import type { XNewsDigestDto } from "../../common/dto/integrations.dto";

const DAY = 86_400_000;
const story = z.object({
  id: z.string().min(1).max(100),
  name: z.string().trim().min(1).max(500),
  summary: z.string().max(5000).optional(),
  disclaimer: z.string().max(2000).optional(),
  cluster_posts_results: z
    .array(z.object({ post_id: z.string().regex(/^\d+$/) }))
    .max(100)
    .optional(),
});

export function mapXNews(raw: unknown): XNewsDigestDto["items"] {
  const data = z.object({ data: z.array(z.unknown()).max(5) }).safeParse(raw);
  if (!data.success) return [];
  const seen = new Set<string>();
  return data.data.data.flatMap((item) => {
    const parsed = story.safeParse(item);
    if (!parsed.success) return [];
    const value = parsed.data;
    const postId = value.cluster_posts_results?.[0]?.post_id;
    if (!postId || seen.has(value.id)) return [];
    seen.add(value.id);
    return [
      {
        id: value.id,
        title: value.name,
        summary: value.summary ?? null,
        sourceUrl: `https://x.com/i/status/${postId}`,
        disclaimer: value.disclaimer ?? null,
      },
    ];
  });
}

@Injectable()
export class XNewsService implements OnModuleInit {
  constructor(
    private readonly config: AppConfigService,
    private readonly redis: RedisService,
    private readonly budgets: IntegrationBudgetService,
    private readonly connections: XConnectionService,
    private readonly api: XApiClient,
    private readonly registry: SideEffectsRegistry,
    private readonly effects: SideEffectsService,
  ) {}

  onModuleInit() {
    this.registry.register("x.news.refresh", ({ slot }) => this.refresh(slot));
  }

  private pilot(now = Date.now()) {
    const config = this.config.xNews();
    const start = Date.parse(config.pilotStart ?? "");
    if (
      !config.enabled ||
      !Number.isFinite(start) ||
      now < start ||
      now >= start + 7 * DAY ||
      !config.accountUserId ||
      !config.query ||
      config.requestMaxMicros === undefined ||
      !config.priceVersion
    )
      return null;
    // Slots are anchored to pilot start, giving exactly fourteen possible requests.
    return {
      ...config,
      start,
      end: start + 7 * DAY,
      slot: `${start}-${Math.floor((now - start) / (DAY / 2))}`,
    };
  }

  @Cron("*/5 * * * *")
  async schedule() {
    if (!this.config.runSchedulers()) return;
    const pilot = this.pilot();
    if (pilot)
      this.effects.dispatch(
        "x.news.refresh",
        { slot: pilot.slot },
        { jobId: `x-news-${pilot.slot}` },
      );
  }

  /** Viewing never schedules or triggers a paid read. */
  async get(): Promise<XNewsDigestDto | null> {
    const pilot = this.pilot();
    if (!pilot) return null;
    try {
      const digest = await this.redis.getJson<XNewsDigestDto>(
        `x:news:v1:${pilot.start}`,
      );
      return digest && Date.parse(digest.expiresAt) > Date.now()
        ? digest
        : null;
    } catch {
      return null;
    }
  }

  async refresh(slot: string): Promise<void> {
    const pilot = this.pilot();
    if (!pilot || slot !== pilot.slot) return;
    const reserve = this.config.integrationBudget("reserve");
    const policy = {
      ...reserve,
      priceVersion: pilot.priceVersion!,
      actionLifetimeMicros: Math.min(
        10_000_000,
        Math.floor(reserve.sharedMonthlyMicros / 10),
      ),
      actionLifetimeRequests: 14,
    };
    const key = `x:news:v1:${pilot.start}`;
    try {
      await this.redis.withLock(key + ":lock", { ttlMs: 60_000 }, async () => {
        const conn = await this.connections.getActiveConnection(
          pilot.accountUserId!,
        );
        if (!conn) return;
        const token = await this.connections.accessTokenFor(conn);
        const id = `x:news:${slot}`;
        if (
          !(await this.budgets.reserve(
            {
              id,
              provider: "x",
              action: `news:${pilot.start}`,
              bucket: "reserve",
              maximumMicros: pilot.requestMaxMicros!,
            },
            policy,
          ))
        )
          return;
        await this.budgets.settle(id, "uncertain");
        const raw = await this.api.getNews(token, pilot.query!);
        await this.budgets.settle(id, "settled");
        const now = Date.now();
        const expires = Math.min(now + DAY, pilot.end);
        const digest: XNewsDigestDto = {
          items: mapXNews(raw),
          fetchedAt: new Date(now).toISOString(),
          expiresAt: new Date(expires).toISOString(),
        };
        await this.redis.setJson(key, digest, { ttlMs: expires - now });
      });
    } catch {
      /* The durable hold prevents unbounded retries after a provider/cache failure. */
    }
  }
}
