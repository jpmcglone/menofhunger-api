import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { AdminGuard } from '../admin/admin.guard';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfigService } from '../app/app-config.service';
import { sealSecret } from '../../common/crypto/secret-box';
import { PARTNER_SCOPES, PARTNER_EVENTS } from './partner.constants';

const httpsUrl = z.string().url().refine(v => { const u = new URL(v); return u.protocol === 'https:' && !u.username && !u.password && !u.hash; }, 'Use a registered HTTPS URL.');
const createSchema = z.object({ name: z.string().trim().min(1).max(100), platform: z.enum(['pickax']).optional(), redirectUris: z.array(httpsUrl).min(1).max(10), logoutRedirectUris: z.array(httpsUrl).max(10).default([]), scopes: z.array(z.enum(PARTNER_SCOPES)).min(1), authorizationStartUrl: httpsUrl.optional(), webhookUrl: httpsUrl.optional(), webhookEvents: z.array(z.enum(PARTNER_EVENTS)).default([]) }).strict();
@ApiExcludeController()
@UseGuards(AdminGuard)
@Controller('admin/partners')
export class AdminPartnersController {
  constructor(private readonly prisma: PrismaService, private readonly cfg: AppConfigService) {}
  @Get()
  async list() {
    return { data: await this.prisma.partnerClient.findMany({ select: { id: true, name: true, platform: true, active: true, scopes: true, redirectUris: true, accountReadLimit: true, clientReadLimit: true, webhookUrl: true, authorizationStartUrl: true, webhookEvents: true } }) };
  }
  @Post()
  async create(@Body() body: unknown) {
    const input = createSchema.parse(body);
    const key = this.cfg.partner().encryptionKey;
    if (key.length < 32) throw new Error('Partner encryption is not configured.');
    const secret = randomBytes(32).toString('base64url');
    const webhookSecret = randomBytes(32).toString('base64url');
    const { id } = await this.prisma.partnerClient.create({ data: { ...input, secretEnc: sealSecret(secret, key), webhookSecretEnc: sealSecret(webhookSecret, key), accountReadLimit: input.platform === 'pickax' ? 300 : 120, clientReadLimit: input.platform === 'pickax' ? 6000 : 1200 } });
    return { data: { clientId: id, clientSecret: secret, webhookSecret } };
  }
  @Patch(':id')
  async update(@Param('id') id: string, @Body() body: unknown) {
    const data = z.object({ active: z.boolean().optional(), accountReadLimit: z.number().int().min(1).max(10000).optional(), clientReadLimit: z.number().int().min(1).max(100000).optional(), authorizationStartUrl: httpsUrl.nullable().optional(), webhookUrl: httpsUrl.nullable().optional(), webhookEvents: z.array(z.enum(PARTNER_EVENTS)).optional() }).strict().parse(body);
    await this.prisma.partnerClient.update({ where: { id }, data });
    return { data: { updated: true } };
  }
  @Post(':id/webhook-secret')
  async rotateWebhookSecret(@Param('id') id: string) {
    const existing = await this.prisma.partnerClient.findUniqueOrThrow({ where: { id } });
    const secret = randomBytes(32).toString('base64url');
    await this.prisma.partnerClient.update({ where: { id }, data: { previousWebhookSecretEnc: existing.webhookSecretEnc,
      webhookSecretEnc: sealSecret(secret, this.cfg.partner().encryptionKey) } });
    return { data: { webhookSecret: secret } };
  }
  @Post(':id/webhook-secret/retire-previous')
  async retireWebhookSecret(@Param('id') id: string) {
    await this.prisma.partnerClient.update({ where: { id }, data: { previousWebhookSecretEnc: null } });
    return { data: { retired: true } };
  }
  @Get(':id/deliveries')
  async deliveries(@Param('id') clientId: string) { return { data: await this.prisma.partnerWebhookDelivery.findMany({ where: { clientId }, orderBy: { createdAt: 'desc' }, take: 100 }) }; }
  @Post(':id/deliveries/:deliveryId/replay')
  async replay(@Param('id') clientId: string, @Param('deliveryId') id: string) {
    const result = await this.prisma.partnerWebhookDelivery.updateMany({ where: { id, clientId, status: { in: ['failed', 'delivered'] } }, data: { status: 'pending', nextAttemptAt: new Date() } });
    return { data: { queued: result.count > 0 } };
  }
}
