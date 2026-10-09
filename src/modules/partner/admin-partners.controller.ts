import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { z } from 'zod';
import { AdminGuard } from '../admin/admin.guard';
import { AdminPartnersService } from './admin-partners.service';
import { PARTNER_EVENTS } from './partner.constants';
import { httpsUrl, createSchema } from './admin-partners.schemas';

@ApiExcludeController()
@UseGuards(AdminGuard)
@Controller('admin/partners')
export class AdminPartnersController {
  constructor(private readonly partners: AdminPartnersService) {}
  @Get()
  async list() {
    return { data: await this.partners.list() };
  }
  @Post()
  async create(@Body() body: unknown) {
    return { data: await this.partners.create(createSchema.parse(body)) };
  }
  @Patch(':id')
  async update(@Param('id') id: string, @Body() body: unknown) {
    const data = z
      .object({
        active: z.boolean().optional(),
        accountReadLimit: z.number().int().min(1).max(10000).optional(),
        clientReadLimit: z.number().int().min(1).max(100000).optional(),
        authorizationStartUrl: httpsUrl.nullable().optional(),
        webhookUrl: httpsUrl.nullable().optional(),
        webhookEvents: z.array(z.enum(PARTNER_EVENTS)).optional(),
      })
      .strict()
      .parse(body);
    await this.partners.update(id, data);
    return { data: { updated: true } };
  }
  @Post(':id/webhook-secret')
  async rotateWebhookSecret(@Param('id') id: string) {
    return { data: { webhookSecret: await this.partners.rotateWebhookSecret(id) } };
  }
  @Post(':id/webhook-secret/retire-previous')
  async retireWebhookSecret(@Param('id') id: string) {
    await this.partners.retireWebhookSecret(id);
    return { data: { retired: true } };
  }
  @Get(':id/deliveries')
  async deliveries(@Param('id') clientId: string) {
    return { data: await this.partners.deliveries(clientId) };
  }
  @Post(':id/deliveries/:deliveryId/replay')
  async replay(@Param('id') clientId: string, @Param('deliveryId') id: string) {
    return { data: { queued: await this.partners.replay(clientId, id) } };
  }
}
