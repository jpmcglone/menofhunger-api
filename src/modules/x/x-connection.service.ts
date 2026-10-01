import { xCapabilities } from "./integration-capabilities";
import type { IntegrationCapabilityDto } from "../../common/dto/integrations.dto";
import { IntegrationBudgetService } from "./integration-budget.service";
import {
  integrationLimits,
  X_REFERENCE_PRICES,
} from "./integration-budget.policy";
import type { IntegrationAllowanceDto } from "../../common/dto/integrations.dto";
import { XUsageService } from "./x-usage.service";
import type { XMonthlyAllowanceDto } from "../partner/partner.dto";
import { randomBytes } from "crypto";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from "@nestjs/common";
import type { XConnection } from "@prisma/client";
import { openSecret, sealSecret } from "../../common/crypto/secret-box";
import {
  X_LINK_COST_MICROS,
  X_NATIVE_COST_MICROS,
} from "../../common/crosspost/crosspost-eligibility";
import { AppConfigService } from "../app/app-config.service";
import { PrismaService } from "../prisma/prisma.service";
import { RedisService } from "../redis/redis.service";
import { PublicProfileCacheService } from "../users/public-profile-cache.service";
import { UsersMeRealtimeService } from "../users/users-me-realtime.service";
import { UsersPublicRealtimeService } from "../users/users-public-realtime.service";
import {
  XApiClient,
  XApiError,
  hasRequiredXScopes,
  isXUsername,
  pkceChallenge,
  pkceVerifier,
  type XTokenPair,
} from "./x-api.client";

export type XAllowance = {
  linkPostsLeft: number;
  nativePostsLeft: number;
};

export type XConnectionStatus = {
  available: boolean;
  connected: boolean;
  username: string | null;
  /** Actual verification is required to publish; connecting remains free. */
  canPost: boolean;
  needsAttention: boolean;
  lastError: string | null;
  allowance: XAllowance | XMonthlyAllowanceDto;
  integrationAllowance?: IntegrationAllowanceDto;
  linksEnabled?: boolean;
  capabilities?: IntegrationCapabilityDto[];
};

const EXPIRY_SKEW_MS = 90_000;
const STATE_TTL_SECONDS = 10 * 60;

type OAuthState = { userId: string; operatorUserId: string; verifier: string };

function stateKey(state: string): string {
  return `x:oauth:${state}`;
}

export function monthStartUtc(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export function allowanceFromSpent(
  spentMicros: number,
  budgetCents: number,
): XAllowance {
  const remaining = Math.max(0, budgetCents * 10_000 - spentMicros);
  return {
    linkPostsLeft: Math.floor(remaining / X_LINK_COST_MICROS),
    nativePostsLeft: Math.floor(remaining / X_NATIVE_COST_MICROS),
  };
}

@Injectable()
export class XConnectionService {
  private readonly logger = new Logger(XConnectionService.name);
  private readonly inflightTokens = new Map<string, Promise<string>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly usage: XUsageService,
    private readonly appConfig: AppConfigService,
    private readonly api: XApiClient,
    private readonly redis: RedisService,
    private readonly publicProfileCache: PublicProfileCacheService<{
      id: string;
      username: string | null;
    }>,
    private readonly usersPublicRealtime: UsersPublicRealtimeService,
    private readonly usersMeRealtime: UsersMeRealtimeService,
    private readonly budgets: IntegrationBudgetService,
  ) {}

  isAvailable(): boolean {
    return this.appConfig.x() !== null;
  }

  redirectUri(): string {
    return `${(this.appConfig.frontendBaseUrl() ?? "https://menofhunger.com").replace(/\/+$/, "")}/settings/integrations`;
  }

  async getStatus(userId: string): Promise<XConnectionStatus> {
    const [conn, user, spent] = await Promise.all([
      this.prisma.xConnection.findUnique({ where: { userId } }),
      this.prisma.user.findUnique({
        where: { id: userId },
        select: {
          premium: true,
          premiumPlus: true,
          verifiedStatus: true,
          bannedAt: true,
        },
      }),
      this.spentThisMonth(userId),
    ]);
    const policy = this.appConfig.integrationBudget();
    const integrationAllowance = policy.enabled
      ? await this.budgets.allowance(userId, new Date(), conn?.xUserId)
      : undefined;
    let sharedAllowance: XMonthlyAllowanceDto | undefined;
    if (integrationAllowance) {
      const limits = integrationLimits({
        verified: Boolean(user && user.verifiedStatus !== "none"),
        premium: Boolean(user?.premium),
        premiumPlus: Boolean(user?.premiumPlus),
        banned: Boolean(user?.bannedAt),
      });
      const usage = await this.prisma.integrationUsageReservation.aggregate({
        where: {
          month: monthStartUtc(),
          provider: "x",
          status: { not: "released" },
          OR: [
            { userId },
            ...(conn ? [{ externalAccountId: conn.xUserId }] : []),
          ],
        },
        _sum: { publicationCount: true },
      });
      const totalRemaining = Math.max(
        0,
        limits.xPublications - (usage._sum.publicationCount ?? 0),
      );
      const linkRemaining = Math.min(
        totalRemaining,
        Math.floor(
          integrationAllowance.expensive.remainingMicros / X_LINK_COST_MICROS,
        ),
      );
      sharedAllowance = {
        totalLimit: limits.xPublications,
        totalRemaining,
        linkLimit: limits.expensive / X_LINK_COST_MICROS,
        linkRemaining,
        linkPostsLeft: linkRemaining,
        nativePostsLeft: Math.min(
          totalRemaining,
          user?.premium || user?.premiumPlus
            ? Math.floor(
                integrationAllowance.regular.remainingMicros /
                  X_NATIVE_COST_MICROS,
              )
            : totalRemaining,
        ),
        resetsAt: integrationAllowance.resetsAt,
      };
    }
    const budget = this.appConfig.x()?.monthlyBudgetCents ?? 0;
    const article = this.appConfig.xArticle();
    const advanced = this.appConfig.xPublishing();
    return {
      capabilities: xCapabilities({
        advanced: {
          ...advanced,
          account: advanced.accountIds.includes(conn?.xUserId ?? ""),
          quote: advanced.quoteAccountIds.includes(conn?.xUserId ?? ""),
          longText: advanced.longAccountIds.includes(conn?.xUserId ?? ""),
          edit: advanced.editAccountIds.includes(conn?.xUserId ?? ""),
        },
        connected: conn?.status === "active",
        scopes: conn?.scopes ?? "",
        article:
          article.maximumMicros !== undefined && article.priceVersion
            ? {
                enabled:
                  article.enabled &&
                  article.accountIds.includes(conn?.xUserId ?? "") &&
                  Boolean(user?.premium || user?.premiumPlus) &&
                  (article.bucket !== "expensive" ||
                    Boolean(user?.premiumPlus)),
                cost: article.maximumMicros,
                priceVersion: article.priceVersion,
                bucket: article.bucket,
              }
            : undefined,
        premiumPlus: Boolean(user?.premiumPlus),
        sharedBudget: policy.enabled,
        confirmedPrices: policy.priceVersion === X_REFERENCE_PRICES.version,
        imageUploadPriceKnown: policy.imageUploadMaxMicros !== undefined,
      }),
      available: this.isAvailable(),
      connected: Boolean(conn),
      username: conn?.username ?? null,
      canPost: user?.bannedAt
        ? false
        : policy.enabled || this.appConfig.partner().xCountAllowance
          ? Boolean(user && user.verifiedStatus !== "none")
          : Boolean(user?.premium || user?.premiumPlus),
      needsAttention: conn?.status === "error",
      lastError: conn?.lastError ?? null,
      ...(integrationAllowance
        ? {
            integrationAllowance,
            linksEnabled: Boolean(
              user?.premiumPlus &&
              policy.priceVersion === X_REFERENCE_PRICES.version,
            ),
          }
        : {}),
      allowance:
        sharedAllowance ??
        (this.appConfig.partner().xCountAllowance
          ? await this.usage.allowance(userId, conn?.xUserId)
          : allowanceFromSpent(spent, budget)),
    };
  }

  async authorize(
    userId: string,
    operatorUserId = userId,
  ): Promise<{ url: string }> {
    const config = this.requireConfig();
    await this.assertCanConnect(userId);
    const state = randomBytes(24).toString("base64url");
    const verifier = pkceVerifier();
    await this.redis.setJson(
      stateKey(state),
      { userId, operatorUserId, verifier } satisfies OAuthState,
      { ttlSeconds: STATE_TTL_SECONDS },
    );
    return {
      url: this.api.authorizeUrl({
        clientId: config.clientId,
        redirectUri: this.redirectUri(),
        state,
        codeChallenge: pkceChallenge(verifier),
      }),
    };
  }

  async connect(
    userId: string,
    input: { code: string; state: string },
    operatorUserId = userId,
  ): Promise<XConnectionStatus> {
    const config = this.requireConfig();
    await this.assertCanConnect(userId);
    const stored = await this.takeOAuthState(input.state);
    if (
      !stored ||
      stored.userId !== userId ||
      stored.operatorUserId !== operatorUserId ||
      !stored.verifier
    ) {
      throw new BadRequestException("That X sign-in expired. Try again.");
    }
    const tokens = await this.api.exchangeCode({
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      code: input.code,
      redirectUri: this.redirectUri(),
      codeVerifier: stored.verifier,
    });
    if (!tokens.refreshToken || !hasRequiredXScopes(tokens.scope)) {
      throw new BadRequestException(
        "X did not grant permission to post. Connect again and allow posting.",
      );
    }
    const account = await this.api.getMe(tokens.accessToken);
    if (!isXUsername(account.username)) {
      throw new BadRequestException(
        "X returned an account name Men of Hunger cannot store.",
      );
    }
    const taken = await this.prisma.xConnection.findUnique({
      where: { xUserId: account.id },
      select: { userId: true },
    });
    if (taken && taken.userId !== userId) {
      throw new ConflictException(
        "That X account is already connected to another member.",
      );
    }
    const current = await this.prisma.xConnection.findUnique({
      where: { userId },
    });
    if (current && current.xUserId !== account.id)
      throw new ConflictException(
        "Disconnect your current X account before connecting another.",
      );
    const key = config.encryptionKey;
    await this.prisma.$transaction([
      this.prisma.xConnection.upsert({
        where: { userId },
        create: {
          userId,
          authorizedByUserId: operatorUserId,
          xUserId: account.id,
          username: account.username,
          accessTokenEnc: sealSecret(tokens.accessToken, key),
          refreshTokenEnc: tokens.refreshToken
            ? sealSecret(tokens.refreshToken, key)
            : null,
          accessTokenExpiresAt: new Date(
            Date.now() + tokens.expiresInSeconds * 1000,
          ),
          scopes: tokens.scope,
          status: "active",
          lastError: null,
        },
        update: {
          authorizedByUserId: operatorUserId,
          xUserId: account.id,
          username: account.username,
          accessTokenEnc: sealSecret(tokens.accessToken, key),
          refreshTokenEnc: tokens.refreshToken
            ? sealSecret(tokens.refreshToken, key)
            : null,
          accessTokenExpiresAt: new Date(
            Date.now() + tokens.expiresInSeconds * 1000,
          ),
          scopes: tokens.scope,
          status: "active",
          lastError: null,
        },
      }),
      this.prisma.user.update({
        where: { id: userId },
        data: { xUsername: account.username },
      }),
    ]);
    await this.afterProfileChange(userId);
    return this.getStatus(userId);
  }

  async disconnect(userId: string): Promise<XConnectionStatus> {
    const conn = await this.prisma.xConnection.findUnique({
      where: { userId },
    });
    if (conn) {
      await this.prisma.$transaction(async (tx) => {
        const removed = await tx.xConnection.deleteMany({
          where: { userId, generation: conn.generation },
        });
        if (removed.count)
          await tx.user.update({
            where: { id: userId },
            data: { xUsername: null },
          });
      });
      await this.afterProfileChange(userId);
      const config = this.appConfig.x();
      if (config && conn.refreshTokenEnc) {
        try {
          await this.api.revoke({
            clientId: config.clientId,
            clientSecret: config.clientSecret,
            token: openSecret(conn.refreshTokenEnc, config.encryptionKey),
          });
        } catch {
          this.logger.warn(
            "X token revocation was not confirmed; local access is disconnected.",
          );
        }
      }
    }
    return this.getStatus(userId);
  }

  async getActiveConnection(userId: string): Promise<XConnection | null> {
    const conn = await this.prisma.xConnection.findUnique({
      where: { userId },
    });
    return conn?.status === "active" ? conn : null;
  }

  async accessTokenFor(conn: XConnection): Promise<string> {
    const key = this.requireConfig().encryptionKey;
    if (
      conn.accessTokenEnc &&
      conn.accessTokenExpiresAt &&
      conn.accessTokenExpiresAt.getTime() - Date.now() > EXPIRY_SKEW_MS
    ) {
      return openSecret(conn.accessTokenEnc, key);
    }
    const existing = this.inflightTokens.get(conn.generation);
    if (existing) return existing;
    const pending = this.renewLocked(conn).finally(() =>
      this.inflightTokens.delete(conn.generation),
    );
    this.inflightTokens.set(conn.generation, pending);
    return pending;
  }

  async invalidateAccessToken(userId: string): Promise<void> {
    await this.prisma.xConnection.updateMany({
      where: { userId },
      data: { accessTokenExpiresAt: new Date(0) },
    });
  }

  async markError(
    userId: string,
    message: string,
    authFailure: boolean,
  ): Promise<void> {
    await this.prisma.xConnection.updateMany({
      where: { userId },
      data: {
        lastError: message.slice(0, 500),
        ...(authFailure ? { status: "error" } : {}),
      },
    });
  }

  async clearError(userId: string): Promise<void> {
    await this.prisma.xConnection.updateMany({
      where: { userId, status: "active" },
      data: { lastError: null },
    });
  }

  async spentThisMonth(userId: string, now = new Date()): Promise<number> {
    const sum = await this.prisma.xCrosspost.aggregate({
      where: {
        userId,
        refundedAt: null,
        createdAt: { gte: monthStartUtc(now) },
      },
      _sum: { costMicros: true },
    });
    return sum._sum.costMicros ?? 0;
  }

  private async renewLocked(conn: XConnection): Promise<string> {
    const lockKey = `x:refresh:${conn.generation}`,
      lock = randomBytes(20).toString("hex");
    if (
      !(await this.redis.setString(lockKey, lock, {
        onlyIfAbsent: true,
        ttlSeconds: 60,
      }))
    )
      throw new XApiError(
        429,
        "refresh_in_progress",
        "X connection is refreshing. Retry shortly.",
      );
    try {
      const latest = await this.getActiveConnection(conn.userId);
      if (!latest || latest.generation !== conn.generation)
        throw new ConflictException("This X connection was disconnected.");
      if (
        latest.accessTokenEnc &&
        latest.accessTokenExpiresAt &&
        latest.accessTokenExpiresAt.getTime() - Date.now() > EXPIRY_SKEW_MS
      )
        return openSecret(
          latest.accessTokenEnc,
          this.requireConfig().encryptionKey,
        );
      return await this.renew(latest);
    } finally {
      await this.redis
        .raw()
        .eval(
          "if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end return 0",
          1,
          lockKey,
          lock,
        );
    }
  }

  private async renew(conn: XConnection): Promise<string> {
    const config = this.requireConfig();
    if (!conn.refreshTokenEnc) {
      await this.markError(
        userIdOf(conn),
        "X needs to be connected again.",
        true,
      );
      throw new XRenewError("X needs to be connected again.");
    }
    let tokens: XTokenPair;
    try {
      tokens = await this.api.refresh({
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        refreshToken: openSecret(conn.refreshTokenEnc, config.encryptionKey),
      });
    } catch (err) {
      await this.markError(conn.userId, "X needs to be connected again.", true);
      throw err;
    }
    await this.prisma.xConnection.updateMany({
      where: { userId: conn.userId, generation: conn.generation },
      data: {
        accessTokenEnc: sealSecret(tokens.accessToken, config.encryptionKey),
        refreshTokenEnc: tokens.refreshToken
          ? sealSecret(tokens.refreshToken, config.encryptionKey)
          : conn.refreshTokenEnc,
        accessTokenExpiresAt: new Date(
          Date.now() + tokens.expiresInSeconds * 1000,
        ),
        scopes: tokens.scope || conn.scopes,
        status: "active",
      },
    });
    return tokens.accessToken;
  }

  /** One read-and-delete. A second attempt with the same state cannot exchange the code. */
  private async takeOAuthState(state: string): Promise<OAuthState | null> {
    const key = stateKey(state);
    const result = await this.redis.raw().call("GETDEL", key);
    const raw = typeof result === "string" ? result : null;
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as OAuthState;
      if (
        !parsed ||
        typeof parsed.userId !== "string" ||
        typeof parsed.verifier !== "string"
      )
        return null;
      return parsed;
    } catch {
      return null;
    }
  }

  private async assertCanConnect(userId: string): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { premium: true, premiumPlus: true, verifiedStatus: true },
    });
    if (!user) {
      throw new ForbiddenException(
        "Verify your account, or join Premium, to connect X.",
      );
    }
  }

  private requireConfig() {
    const config = this.appConfig.x();
    if (!config)
      throw new ServiceUnavailableException(
        "X connections are not available right now.",
      );
    return config;
  }

  private async afterProfileChange(userId: string): Promise<void> {
    try {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, username: true },
      });
      if (user)
        await this.publicProfileCache.invalidateForUser({
          id: user.id,
          username: user.username ?? null,
        });
      await this.usersPublicRealtime.emitPublicProfileUpdated(userId);
      void this.usersMeRealtime.emitMeUpdated(userId, "x_changed");
    } catch (err) {
      this.logger.warn(
        `X profile refresh failed for ${userId}: ${String(err)}`,
      );
    }
  }
}

class XRenewError extends Error {}

function userIdOf(conn: XConnection): string {
  return conn.userId;
}
