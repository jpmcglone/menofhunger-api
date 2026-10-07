import { Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfigService } from '../app/app-config.service';
import { sealSecret } from '../../common/crypto/secret-box';
import type { Prisma } from '@prisma/client';

@Injectable()
export class AdminPartnersService {
  constructor(private readonly prisma: PrismaService, private readonly cfg: AppConfigService) {}

  list() {
    return this.prisma.partnerClient.findMany({ select: { id: true, name: true, platform: true, active: true, scopes: true, redirectUris: true, accountReadLimit: true, clientReadLimit: true, webhookUrl: true, authorizationStartUrl: true, webhookEvents: true } });
  }

  async create(input: Omit<Prisma.PartnerClientCreateInput, 'secretEnc' | 'webhookSecretEnc' | 'accountReadLimit' | 'clientReadLimit'> & { platform?: string }) {
    const key = this.cfg.partner().encryptionKey;
    if (key.length < 32) throw new Error('Partner encryption is not configured.');
    const secret = randomBytes(32).toString('base64url');
    const webhookSecret = randomBytes(32).toString('base64url');
    const { id } = await this.prisma.partnerClient.create({ data: { ...input, secretEnc: sealSecret(secret, key), webhookSecretEnc: sealSecret(webhookSecret, key), accountReadLimit: input.platform === 'pickax' ? 300 : 120, clientReadLimit: input.platform === 'pickax' ? 6000 : 1200 } });
    return { clientId: id, clientSecret: secret, webhookSecret };
  }

  async update(id: string, data: Prisma.PartnerClientUpdateInput) {
    await this.prisma.partnerClient.update({ where: { id }, data });
  }

  async rotateWebhookSecret(id: string) {
    const existing = await this.prisma.partnerClient.findUniqueOrThrow({ where: { id } });
    const secret = randomBytes(32).toString('base64url');
    await this.prisma.partnerClient.update({ where: { id }, data: { previousWebhookSecretEnc: existing.webhookSecretEnc,
      webhookSecretEnc: sealSecret(secret, this.cfg.partner().encryptionKey) } });
    return secret;
  }

  async retireWebhookSecret(id: string) {
    await this.prisma.partnerClient.update({ where: { id }, data: { previousWebhookSecretEnc: null } });
  }

  deliveries(clientId: string) {
    return this.prisma.partnerWebhookDelivery.findMany({ where: { clientId }, orderBy: { createdAt: 'desc' }, take: 100 });
  }

  async replay(clientId: string, id: string) {
    const result = await this.prisma.partnerWebhookDelivery.updateMany({ where: { id, clientId, status: { in: ['failed', 'delivered'] } }, data: { status: 'pending', nextAttemptAt: new Date() } });
    return result.count > 0;
  }
}
