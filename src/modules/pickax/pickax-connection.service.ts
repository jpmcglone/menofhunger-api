import { PickaxOAuthClient } from './pickax-oauth.client';
import { RedisService } from '../redis/redis.service';
import { randomBytes } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { PickaxConnection } from '@prisma/client';
import { AppConfigService } from '../app/app-config.service';
import { PrismaService } from '../prisma/prisma.service';
import { PublicProfileCacheService } from '../users/public-profile-cache.service';
import { UsersMeRealtimeService } from '../users/users-me-realtime.service';
import { UsersPublicRealtimeService } from '../users/users-public-realtime.service';
import { normalizeSocialHandle } from '../users/social-handles';
import { PickaxApiClient, PickaxApiError, type PickaxTokenPair } from './pickax-api.client';
import {
  fetchPickaxProfileTexts,
  profileMatchesIdentity,
  profileVerificationCode,
  readTokenClaimKeys,
  readTokenIdentity,
} from './pickax-identity';
import { openSecret, sealSecret } from '../../common/crypto/secret-box';
import { USER_REF_SELECT } from '../../common/prisma-selects/user.select';

export type PickaxConnectionStatus = {
  available: boolean;
  oauthAvailable: boolean;
  connected: boolean;
  username: string | null;
  needsAttention: boolean;
  /** Latest failure Pickax reported for a cross-post, cleared by the next success. */
  lastError: string | null;
};

export type PickaxConnectResult =
  | { needsUsername: false; verificationCode: null; status: PickaxConnectionStatus }
  | { needsUsername: true; verificationCode: string | null; status: PickaxConnectionStatus };

/** Refresh slightly early so an in-flight request never carries an expired token. */
const EXPIRY_SKEW_MS = 90_000;

@Injectable()
export class PickaxConnectionService {
  private readonly logger = new Logger(PickaxConnectionService.name);
  private readonly inflightTokens = new Map<string, Promise<string>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly appConfig: AppConfigService,
    private readonly api: PickaxApiClient,
    private readonly publicProfileCache: PublicProfileCacheService<{ id: string; username: string | null }>,
    private readonly usersPublicRealtime: UsersPublicRealtimeService,
    private readonly usersMeRealtime: UsersMeRealtimeService,
    private readonly oauth: PickaxOAuthClient,
    private readonly redis: RedisService,
  ) {}

  isAvailable(): boolean {
    return this.appConfig.pickaxSecretEncryptionKey() !== null;
  }

  async getStatus(userId: string): Promise<PickaxConnectionStatus> {
    const conn = await this.prisma.pickaxConnection.findUnique({ where: { userId } });
    return this.toStatus(conn);
  }

  /** Reauthenticate an already verified connection without sending its secrets to the client. */
  async reconnect(userId: string, operatorUserId = userId): Promise<PickaxConnectionStatus> {
    const key = this.requireKey();
    const conn = await this.prisma.pickaxConnection.findUnique({ where: { userId } });
    if (!conn) throw new BadRequestException('Connect Pickax before reconnecting.');
    if (conn.authKind !== 'credentials') throw new BadRequestException('Authorize your Pickax account again.');
    let tokens: PickaxTokenPair;
    try {
      tokens = await this.api.exchangeCredentials(conn.clientId, openSecret(conn.clientSecretEnc, key));
    } catch (err) {
      if (err instanceof PickaxApiError && (err.isAuthFailure || err.status === 400 || err.status === 422)) {
        throw new BadRequestException('Pickax rejected the saved key. Disconnect, then connect with a new key.');
      }
      throw new ServiceUnavailableException('Could not reach Pickax. Try again in a moment.');
    }
    const identity = readTokenIdentity(tokens.accessToken);
    if ((identity.userId && conn.pickaxUserId && identity.userId !== conn.pickaxUserId)
      || (identity.handle && identity.handle.toLowerCase() !== conn.username.toLowerCase())) {
      throw new ConflictException('The saved key no longer matches your connected Pickax account. Disconnect before connecting another account.');
    }
    // Ownership was verified when these credentials were saved. Do not require the
    // temporary bio code again, or recreate a connection disconnected during this call.
    const updated = await this.prisma.pickaxConnection.updateMany({
      where: { userId, generation: conn.generation, clientSecretEnc: conn.clientSecretEnc },
      data: {
        accessTokenEnc: sealSecret(tokens.accessToken, key),
        refreshTokenEnc: tokens.refreshToken ? sealSecret(tokens.refreshToken, key) : null,
        accessTokenExpiresAt: new Date(Date.now() + tokens.expiresInSeconds * 1000),
        authorizedByUserId: operatorUserId, status: 'active', lastError: null,
      },
    });
    if (!updated.count) throw new ConflictException('Your Pickax connection changed. Refresh and try again.');
    await this.afterProfileChange(userId);
    return this.getStatus(userId);
  }

  async connect(
    userId: string,
    input: { clientId: string; clientSecret: string; username?: string | null },
    operatorUserId = userId,
  ): Promise<PickaxConnectResult> {
    const key = this.requireKey();

    let tokens: PickaxTokenPair;
    try {
      tokens = await this.api.exchangeCredentials(input.clientId, input.clientSecret);
    } catch (err) {
      if (err instanceof PickaxApiError && (err.isAuthFailure || err.status === 400 || err.status === 422)) {
        throw new BadRequestException('Pickax rejected that Client ID and Client Secret.');
      }
      throw new ServiceUnavailableException('Could not reach Pickax. Try again in a moment.');
    }

    const identity = readTokenIdentity(tokens.accessToken);
    const suppliedHandle = input.username?.trim() ? normalizeSocialHandle('pickax', input.username) : null;
    const handle = identity.handle ?? suppliedHandle;

    const tokenNamesAccount = Boolean(identity.handle || identity.userId);
    if (!tokenNamesAccount) {
      this.logger.warn(
        `Pickax token carried no identity. response keys=${tokens.responseKeys.join(',')} claim keys=${
          readTokenClaimKeys(tokens.accessToken)?.join(',') ?? 'not-a-jwt'
        }`,
      );
    }
    if (!handle) return { needsUsername: true, verificationCode: null, status: this.toStatus(null) };

    const texts = await fetchPickaxProfileTexts(handle);
    if (tokenNamesAccount) {
      const verified = texts.some((t) => profileMatchesIdentity(t, { handle, userId: identity.userId }));
      if (!verified) {
        throw new BadRequestException(`We could not confirm that @${handle} is the account this key belongs to.`);
      }
    } else {
      const code = profileVerificationCode(userId, handle, key);
      if (!texts.some((t) => t.toLowerCase().includes(code))) {
        return { needsUsername: true, verificationCode: code, status: this.toStatus(null) };
      }
    }

    const current = await this.prisma.pickaxConnection.findUnique({ where: { userId } });
    if (current && (current.pickaxUserId ? current.pickaxUserId !== identity.userId : current.username.toLowerCase() !== handle.toLowerCase())) {
      throw new ConflictException('Disconnect your current Pickax account before connecting another.');
    }
    const taken = await this.prisma.pickaxConnection.findFirst({
      where: { username: { equals: handle, mode: 'insensitive' }, userId: { not: userId } },
      select: { id: true },
    });
    if (taken) throw new ConflictException(`@${handle} on Pickax is already connected to another account.`);

    const data = {
      authKind: 'credentials',
      pickaxUserId: identity.userId,
      username: handle,
      authorizedByUserId: operatorUserId,
      clientId: input.clientId,
      clientSecretEnc: sealSecret(input.clientSecret, key),
      accessTokenEnc: sealSecret(tokens.accessToken, key),
      refreshTokenEnc: tokens.refreshToken ? sealSecret(tokens.refreshToken, key) : null,
      accessTokenExpiresAt: new Date(Date.now() + tokens.expiresInSeconds * 1000),
      // The credentials API does not currently assert an account ID. Bio verification
      // above remains the supported ownership proof; do not require proposed OAuth.
      // A fresh generation prevents existing deliveries from following replacement keys.
      ...(!identity.userId && current?.clientId !== input.clientId ? { generation: randomBytes(20).toString('hex') } : {}),
      status: 'active',
      lastError: null,
    };
    const [conn] = await this.prisma.$transaction([
      this.prisma.pickaxConnection.upsert({ where: { userId }, create: { userId, ...data }, update: data }),
      this.prisma.user.update({ where: { id: userId }, data: { pickaxUsername: handle }, select: { id: true } }),
    ]);
    await this.afterProfileChange(userId);
    return { needsUsername: false, verificationCode: null, status: this.toStatus(conn) };
  }

  async saveOAuth(userId: string, operatorUserId: string, identity: { id: string; username: string }, tokens: PickaxTokenPair) {
    const current = await this.prisma.pickaxConnection.findUnique({ where: { userId } });
    if (current?.pickaxUserId && current.pickaxUserId !== identity.id) throw new ConflictException('Disconnect the existing Pickax account before switching identities.');
    const key = this.requireKey();
    const data = { username: identity.username, pickaxUserId: identity.id, authKind: 'oauth', authorizedByUserId: operatorUserId,
      clientId: this.oauth.config().clientId, clientSecretEnc: '', accessTokenEnc: sealSecret(tokens.accessToken, key),
      refreshTokenEnc: tokens.refreshToken ? sealSecret(tokens.refreshToken, key) : null,
      accessTokenExpiresAt: new Date(Date.now() + tokens.expiresInSeconds * 1000), status: 'active', lastError: null };
    await this.prisma.$transaction([
      this.prisma.pickaxConnection.upsert({ where: { userId }, create: { userId, ...data }, update: data }),
      this.prisma.user.update({ where: { id: userId }, data: { pickaxUsername: identity.username } }),
    ]);
    await this.afterProfileChange(userId);
  }

  async disconnect(userId: string): Promise<PickaxConnectionStatus> {
    const connection = await this.prisma.pickaxConnection.findUnique({ where: { userId } });
    const clients = await this.prisma.partnerClient.findMany({ where: { platform: 'pickax' }, select: { id: true } });
    await this.prisma.$transaction(async tx => {
      const removed = await tx.pickaxConnection.deleteMany({ where: { userId, generation: connection?.generation ?? 'no-connection-at-disconnect' } });
      await tx.partnerGrant.updateMany({ where: { userId, clientId: { in: clients.map(c => c.id) }, revokedAt: null }, data: { revokedAt: new Date() } });
      // A concurrent reconnect must not have its public handle cleared by an old disconnect.
      if (removed.count) await tx.user.update({ where: { id: userId }, data: { pickaxUsername: null }, select: { id: true } });
    });
    await this.afterProfileChange(userId);
    if (connection?.authKind === 'oauth' && connection.refreshTokenEnc) {
      try { await this.oauth.revoke(openSecret(connection.refreshTokenEnc, this.requireKey())); }
      catch { this.logger.warn('Pickax token revocation was not confirmed; local access is disconnected.'); }
    }
    return this.getStatus(userId);
  }

  /** Connection for cross-posting, or null when absent or in need of a new key. */
  async getActiveConnection(userId: string): Promise<PickaxConnection | null> {
    const conn = await this.prisma.pickaxConnection.findUnique({ where: { userId } });
    return conn && conn.status === 'active' ? conn : null;
  }

  async clearError(userId: string, generation: string): Promise<void> {
    await this.prisma.pickaxConnection.updateMany({ where: { userId, generation, lastError: { not: null } }, data: { lastError: null } });
  }

  async markError(userId: string, message: string, needsNewKey: boolean, generation: string): Promise<void> {
    await this.prisma.pickaxConnection.updateMany({
      where: { userId, generation },
      data: { lastError: message.slice(0, 500), ...(needsNewKey ? { status: 'error' } : {}) },
    });
  }

  /** A valid access token, refreshing (or re-exchanging the stored key) when it has expired. */
  async accessTokenFor(conn: PickaxConnection): Promise<string> {
    const key = this.requireKey();
    if (conn.accessTokenEnc && conn.accessTokenExpiresAt && conn.accessTokenExpiresAt.getTime() - EXPIRY_SKEW_MS > Date.now()) {
      return openSecret(conn.accessTokenEnc, key);
    }
    const pending = this.inflightTokens.get(conn.generation);
    if (pending) return pending;
    const next = this.renewLocked(conn, key).finally(() => this.inflightTokens.delete(conn.generation));
    this.inflightTokens.set(conn.generation, next);
    return next;
  }

  /** Discard a token Pickax rejected so the next call renews it. */
  async invalidateAccessToken(userId: string, generation: string): Promise<void> {
    await this.prisma.pickaxConnection.updateMany({ where: { userId, generation }, data: { accessTokenExpiresAt: null } });
  }

  private async renewLocked(conn: PickaxConnection, key: string): Promise<string> {
    const lockKey = `pickax:refresh:${conn.generation}`, lock = randomBytes(20).toString('hex');
    if (!await this.redis.setString(lockKey, lock, { onlyIfAbsent: true, ttlSeconds: 60 })) throw new PickaxApiError(429, 'refresh_in_progress', 'Pickax connection is refreshing. Retry shortly.', 1);
    try {
      const latest = await this.getActiveConnection(conn.userId);
      if (!latest || latest.generation !== conn.generation) throw new ConflictException('This Pickax connection was disconnected.');
      if (latest.accessTokenEnc && latest.accessTokenExpiresAt && latest.accessTokenExpiresAt.getTime() - EXPIRY_SKEW_MS > Date.now()) return openSecret(latest.accessTokenEnc, key);
      return await this.renewTokens(latest, key);
    } finally {
      await this.redis.raw().eval("if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end return 0", 1, lockKey, lock);
    }
  }

  private async renewTokens(conn: PickaxConnection, key: string): Promise<string> {
    let tokens: PickaxTokenPair | null = null;
    if (conn.refreshTokenEnc) {
      try {
        tokens = conn.authKind === 'oauth' ? await this.oauth.tokens({ grant_type: 'refresh_token', refresh_token: openSecret(conn.refreshTokenEnc, key) }) : await this.api.refresh(openSecret(conn.refreshTokenEnc, key));
      } catch (err) {
        this.logger.debug(`Pickax refresh failed for ${conn.userId}; re-exchanging stored key (${String(err)})`);
      }
    }
    if (!tokens) {
      if (conn.authKind === 'oauth') throw new ServiceUnavailableException('Reconnect Pickax to renew outward sharing.');
      tokens = await this.api.exchangeCredentials(conn.clientId, openSecret(conn.clientSecretEnc, key));
    }
    await this.prisma.pickaxConnection.updateMany({
      where: { userId: conn.userId, generation: conn.generation },
      data: {
        accessTokenEnc: sealSecret(tokens.accessToken, key),
        refreshTokenEnc: tokens.refreshToken ? sealSecret(tokens.refreshToken, key) : null,
        accessTokenExpiresAt: new Date(Date.now() + tokens.expiresInSeconds * 1000),
      },
    });
    return tokens.accessToken;
  }

  private requireKey(): string {
    const key = this.appConfig.pickaxSecretEncryptionKey();
    if (!key) throw new ServiceUnavailableException('Pickax connections are not available right now.');
    return key;
  }

  private toStatus(conn: PickaxConnection | null): PickaxConnectionStatus {
    return {
      available: this.isAvailable(),
      oauthAvailable: this.oauth.available(),
      connected: Boolean(conn),
      username: conn?.username ?? null,
      needsAttention: Boolean(conn && conn.status !== 'active'),
      lastError: conn?.lastError ?? null,
    };
  }

  private async afterProfileChange(userId: string): Promise<void> {
    try {
      const user = await this.prisma.user.findUnique({ where: { id: userId }, select: USER_REF_SELECT });
      if (user) await this.publicProfileCache.invalidateForUser({ id: user.id, username: user.username ?? null });
      await this.usersPublicRealtime.emitPublicProfileUpdated(userId);
      void this.usersMeRealtime.emitMeUpdated(userId, 'pickax_changed');
    } catch (err) {
      this.logger.warn(`Pickax profile refresh failed for ${userId}: ${String(err)}`);
    }
  }
}
