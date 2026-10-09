import { NOT_BANNED_USER_WHERE } from '../../common/prisma-selects/user.where';
import { XPublicSnapshotService } from "./x-public-snapshot.service";
import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { RedisService } from "../redis/redis.service";
import { AppConfigService } from "../app/app-config.service";
import { IntegrationBudgetService } from "./integration-budget.service";
import { X_REFERENCE_PRICES } from "./integration-budget.policy";
import { XApiClient } from "./x-api.client";
import { XConnectionService } from "./x-connection.service";
import type { XProfilePreviewDto, XProfileContextDto } from "../../common/dto/integrations.dto";

@Injectable()
export class XProfilePreviewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly config: AppConfigService,
    private readonly budget: IntegrationBudgetService,
    private readonly api: XApiClient,
    private readonly connections: XConnectionService,
    private readonly snapshots: XPublicSnapshotService,
  ) {}

  async context(
    viewerId: string,
    profileUserId: string,
  ): Promise<XProfileContextDto | null> {
    const policy = this.config.integrationBudget("reserve");
    if (!policy.profilePreviewEnabled || !policy.profileContextEnabled)
      return null;
    const profile = await this.get(viewerId, profileUserId);
    if (!profile) return null;
    const identity = { xUserId: profile.id };
    try {
      const viewer = await this.connections.getActiveConnection(viewerId);
      if (!viewer || viewer.xUserId === identity.xUserId) return null;
      const key = `x:profile-context:v1:${viewer.generation}:${viewer.xUserId}:${identity.xUserId}`;
      const cached = await this.redis.getJson<{
        context: XProfileContextDto | null;
      }>(key);
      if (
        cached &&
        (!cached.context || Date.parse(cached.context.expiresAt) > Date.now())
      )
        return cached.context;
      if (policy.priceVersion !== X_REFERENCE_PRICES.version) return null;
      return (
        (await this.redis.withLock(
          key + ":lock",
          { ttlMs: 60_000 },
          async () => {
            const coldKey = `x:profile-context-cold:${viewerId}:${new Date().toISOString().slice(0, 10)}`;
            const cold = Number(
              await this.redis
                .raw()
                .eval(
                  "local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],86400) end; return n",
                  1,
                  coldKey,
                ),
            );
            if (cold > 20) return null;
            const token = await this.connections.accessTokenFor(viewer);
            const id = `x:context:${viewer.xUserId}:${identity.xUserId}:${Math.floor(Date.now() / 900_000)}`;
            if (
              !(await this.budget.reserve(
                {
                  id,
                  provider: "x",
                  action: "userContextRead",
                  bucket: "reserve",
                  externalAccountId: identity.xUserId,
                  maximumMicros: X_REFERENCE_PRICES.userRead,
                },
                policy,
              ))
            )
              return null;
            await this.budget.settle(id, "uncertain");
            try {
              const context = await this.api.getProfileContext(
                token,
                identity.xUserId,
              );
              await this.budget.settle(id, "settled");
              await this.redis.setJson(
                key,
                { context },
                { ttlSeconds: context ? 900 : 300 },
              );
              return context;
            } catch {
              await this.redis.setJson(
                key,
                { context: null },
                { ttlSeconds: 300 },
              );
              return null;
            }
          },
        )) ?? null
      );
    } catch {
      return null;
    }
  }

  async get(
    viewerId: string,
    profileUserId: string,
  ): Promise<XProfilePreviewDto | null> {
    const policy = this.config.integrationBudget("reserve");
    if (!policy.profilePreviewEnabled) return null;
    // Only saved profile metadata may trigger a lookup; never arbitrary handles.
    const target = await this.prisma.user.findFirst({
      where: {
        id: profileUserId,
        ...NOT_BANNED_USER_WHERE,
        usernameIsSet: true,
        blocksInitiated: { none: { blockedId: viewerId } },
        blocksReceived: { none: { blockerId: viewerId } },
      },
      select: {
        xUsername: true,
        xConnection: {
          select: { xUserId: true, username: true, status: true },
        },
      },
    });
    const handle = target?.xUsername?.replace(/^@/, "").toLowerCase();
    if (!handle || !/^[a-z0-9_]{1,15}$/.test(handle)) return null;
    const knownId =
      target?.xConnection?.status === "active" &&
      target.xConnection.username.toLowerCase() === handle
        ? target.xConnection.xUserId
        : null;
    const aliasKey = `x:profile-id:v1:${handle}`;
    const negativeKey = `x:profile-negative:v1:${handle}`;
    try {
      const cachedProfile = async (): Promise<{
        found: boolean;
        profile: XProfilePreviewDto | null;
      }> => {
        if (await this.redis.getJson<boolean>(negativeKey))
          return { found: true, profile: null };
        const id = knownId ?? (await this.redis.getJson<string>(aliasKey));
        const cached = id
          ? await this.redis.getJson<{ profile: XProfilePreviewDto | null }>(
              `x:public-profile:v1:${id}`,
            )
          : null;
        if (
          cached &&
          (!cached.profile || Date.parse(cached.profile.expiresAt) > Date.now())
        ) {
          return {
            found: true,
            profile:
              cached.profile?.username.toLowerCase() === handle
                ? cached.profile
                : null,
          };
        }
        const durable = await this.snapshots.profile(knownId, handle);
        return { found: Boolean(durable), profile: durable };
      };
      const cached = await cachedProfile();
      if (cached.found) return cached.profile;
      const viewer = await this.connections.getActiveConnection(viewerId);
      if (!viewer || policy.priceVersion !== X_REFERENCE_PRICES.version)
        return null;
      return (
        (await this.redis.withLock(
          `x:profile-lock:v1:${handle}`,
          { ttlMs: 60_000 },
          async () => {
            const again = await cachedProfile();
            if (again.found) return again.profile;
            const coldKey = `x:profile-cold:${viewerId}:${new Date().toISOString().slice(0, 10)}`;
            const cold = Number(
              await this.redis
                .raw()
                .eval(
                  "local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],86400) end; return n",
                  1,
                  coldKey,
                ),
            );
            if (cold > 20) return null;
            const token = await this.connections.accessTokenFor(viewer);
            const identity =
              knownId ?? (await this.redis.getJson<string>(aliasKey));
            const id = `x:profile:${identity ?? `handle-${handle}`}:${new Date().toISOString().slice(0, 10)}`;
            if (
              !(await this.budget.reserve(
                {
                  id,
                  provider: "x",
                  action: "userRead",
                  bucket: "reserve",
                  externalAccountId: identity ?? undefined,
                  maximumMicros: X_REFERENCE_PRICES.userRead,
                },
                policy,
              ))
            )
              return null;
            await this.budget.settle(id, "uncertain");
            try {
              const profile = identity
                ? await this.api.getPublicProfile(token, identity)
                : await this.api.getPublicProfileByUsername(token, handle);
              await this.budget.settle(id, "settled");
              if (!profile || profile.username.toLowerCase() !== handle) {
                if (identity)
                  await this.snapshots.invalidate("x-profile", identity);
                await this.redis.setJson(negativeKey, true, {
                  ttlSeconds: 300,
                });
                return null;
              }
              await this.snapshots.saveProfile(profile);
              await this.redis.setJson(aliasKey, profile.id, {
                ttlSeconds: 86_400,
              });
              await this.redis.setJson(
                `x:public-profile:v1:${profile.id}`,
                { profile },
                { ttlSeconds: 86_400 },
              );
              return profile;
            } catch {
              await this.redis.setJson(negativeKey, true, { ttlSeconds: 300 });
              return null;
            }
          },
        )) ?? null
      );
    } catch {
      return this.snapshots.profile(knownId, handle).catch(() => null);
    } // Cache/lock outage must not become an unbounded paid fallback.
  }
}
