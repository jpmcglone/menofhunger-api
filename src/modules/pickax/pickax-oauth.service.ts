import { BadRequestException, ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { PickaxOAuthClient } from './pickax-oauth.client';
import { PickaxConnectionService } from './pickax-connection.service';

type Journey = { userId: string; operatorUserId: string; verifier: string; expectedExternalId?: string; grantId?: string };
@Injectable()
export class PickaxOAuthService {
  constructor(private readonly prisma: PrismaService, private readonly redis: RedisService,
    private readonly client: PickaxOAuthClient, private readonly connections: PickaxConnectionService) {}
  private async assertAuthority(userId: string, operatorUserId: string) {
    const [user, operator] = await Promise.all([this.prisma.user.findUnique({ where: { id: userId } }), this.prisma.user.findUnique({ where: { id: operatorUserId } })]);
    if (!user || user.bannedAt || !operator || operator.bannedAt || operator.accountKind !== 'person') throw new UnauthorizedException();
    if (userId !== operatorUserId && !(user.accountKind === 'page' && await this.prisma.userPageOperator.findUnique({ where: { operatorUserId_pageUserId: { operatorUserId, pageUserId: userId } } }))) throw new UnauthorizedException();
  }
  async authorize(userId: string, operatorUserId: string, continuation?: string) {
    const c = this.client.config();
    let expectedExternalId: string | undefined, grantId: string | undefined;
    if (continuation) {
      const raw = await this.redis.getString(`partner:pickax:continue:${continuation}`);
      if (!raw) throw new BadRequestException('This connection request expired. Restart from Pickax.');
      const pending = JSON.parse(raw);
      const grant = await this.prisma.partnerGrant.findUnique({ where: { id: pending.grantId } });
      const partner = grant && await this.prisma.partnerClient.findUnique({ where: { id: grant.clientId } });
      if (!grant || grant.revokedAt || grant.expiresAt < new Date() || grant.operatorUserId !== operatorUserId || !partner?.active || partner.platform !== 'pickax') throw new UnauthorizedException();
      userId = grant.userId; grantId = grant.id; expectedExternalId = pending.externalAccountId;
      // Compare-and-delete prevents two browser tabs from consuming the same continuation.
      const consumed = await this.redis.raw().eval("if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end return 0", 1, `partner:pickax:continue:${continuation}`, raw);
      if (!consumed) throw new BadRequestException('This connection request has already been used.');
    }
    await this.assertAuthority(userId, operatorUserId);
    const verifier = randomBytes(32).toString('base64url'), state = randomBytes(32).toString('base64url');
    await this.redis.setJson(`pickax:oauth:${state}`, { userId, operatorUserId, verifier, expectedExternalId, grantId } satisfies Journey, { ttlSeconds: 600 });
    const url = new URL(`${c.issuer}/authorize`);
    for (const [key, value] of Object.entries({ client_id: c.clientId, redirect_uri: c.redirectUri, response_type: 'code', state,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', scope: 'account:read content:write offline_access' })) url.searchParams.set(key, value);
    return { url: url.href, accountId: userId };
  }
  async connect(operatorUserId: string, code: string, state: string) {
    const raw = await this.redis.raw().eval("local v=redis.call('GET',KEYS[1]); if v then redis.call('DEL',KEYS[1]) end return v", 1, `pickax:oauth:${state}`);
    if (typeof raw !== 'string') throw new BadRequestException('This connection request expired. Restart the incomplete step.');
    const journey = JSON.parse(raw) as Journey;
    if (journey.operatorUserId !== operatorUserId) throw new UnauthorizedException();
    await this.assertAuthority(journey.userId, operatorUserId);
    if (journey.grantId) {
      const grant = await this.prisma.partnerGrant.findUnique({ where: { id: journey.grantId } });
      if (!grant || grant.revokedAt || grant.expiresAt < new Date()) throw new UnauthorizedException();
    }
    const tokens = await this.client.tokens({ grant_type: 'authorization_code', code, code_verifier: journey.verifier, redirect_uri: this.client.config().redirectUri });
    const identity = await this.client.me(tokens.accessToken);
    if (journey.expectedExternalId && identity.id !== journey.expectedExternalId) throw new ConflictException('Pickax authorized a different account. Restart with the intended Pickax account.');
    await this.assertAuthority(journey.userId, operatorUserId);
    await this.connections.saveOAuth(journey.userId, operatorUserId, identity, tokens);
    const clientId = this.client.config().partnerClientId;
    const partner = clientId ? await this.prisma.partnerClient.findUnique({ where: { id: clientId } }) : null;
    const readConnectUrl = !journey.grantId && partner?.active && partner.platform === 'pickax' ? partner.authorizationStartUrl : null;
    return { accountId: journey.userId, readConnected: Boolean(journey.grantId), outwardConnected: true, readConnectUrl };

  }
}
