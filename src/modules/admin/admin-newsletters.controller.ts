import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { CurrentUserId } from '../users/users.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { newsletterAudienceFiltersSchema } from '../newsletters/newsletter-audience';
import { NewslettersService } from '../newsletters/newsletters.service';
import { AdminGuard } from './admin.guard';

const writeSchema = z.object({
  subject: z.string().max(200).optional().nullable(),
  preheader: z.string().max(200).optional().nullable(),
  bodyJson: z.string().max(100_000).optional().nullable(),
  ctaLabel: z.string().trim().max(40).optional().nullable(),
  ctaHref: z.string().trim().max(500).optional().nullable(),
  imageKey: z.string().trim().max(500).optional().nullable(),
  audienceFilters: newsletterAudienceFiltersSchema.optional(),
});

const audienceCountSchema = z.object({
  audienceFilters: newsletterAudienceFiltersSchema.optional(),
});

const previewSchema = writeSchema.extend({
  firstName: z.string().trim().max(80).optional(),
  name: z.string().trim().max(120).optional(),
  username: z.string().trim().max(40).optional(),
});

const scheduleSchema = z.object({
  scheduledAt: z.string().datetime({ offset: true }).or(z.string().datetime()),
});

@UseGuards(AdminGuard)
@Controller('admin/newsletters')
export class AdminNewslettersController {
  constructor(
    private readonly newsletters: NewslettersService,
    private readonly prisma: PrismaService,
  ) {}

  @Get()
  async list() {
    return { data: await this.newsletters.listAdmin() };
  }

  @Post('preview')
  async preview(@Body() body: unknown) {
    const parsed = previewSchema.parse(body ?? {});
    return {
      data: await this.newsletters.preview({
        subject: parsed.subject,
        preheader: parsed.preheader,
        bodyJson: parsed.bodyJson,
        ctaLabel: parsed.ctaLabel,
        ctaHref: parsed.ctaHref,
        imageKey: parsed.imageKey,
        vars:
          parsed.firstName || parsed.name || parsed.username
            ? {
                firstName: parsed.firstName || 'James',
                name: parsed.name || parsed.firstName || 'James',
                username: parsed.username || 'james',
              }
            : undefined,
      }),
    };
  }

  @Post('audience-count')
  async audienceCount(@Body() body: unknown) {
    const parsed = audienceCountSchema.parse(body ?? {});
    return { data: await this.newsletters.countAudience(parsed.audienceFilters ?? []) };
  }

  @Post()
  async create(@CurrentUserId() adminUserId: string) {
    return { data: await this.newsletters.create(adminUserId) };
  }

  @Get(':id')
  async get(@Param('id') id: string) {
    return { data: await this.newsletters.getAdmin(id) };
  }

  @Patch(':id')
  async update(@Param('id') id: string, @Body() body: unknown) {
    const parsed = writeSchema.parse(body ?? {});
    return { data: await this.newsletters.update(id, parsed) };
  }

  @Post(':id/preview-send')
  async previewSend(@Param('id') id: string, @CurrentUserId() adminUserId: string) {
    const admin = await this.prisma.user.findUnique({
      where: { id: adminUserId },
      select: { id: true, email: true, emailVerifiedAt: true, name: true, username: true },
    });
    if (!admin) {
      return { data: { sent: false, reason: 'admin_not_found' } };
    }
    return { data: await this.newsletters.sendPreviewToAdmin(id, admin) };
  }

  @Post(':id/schedule')
  async schedule(@Param('id') id: string, @Body() body: unknown) {
    const parsed = scheduleSchema.parse(body ?? {});
    return { data: await this.newsletters.schedule(id, new Date(parsed.scheduledAt)) };
  }

  @Post(':id/unschedule')
  async unschedule(@Param('id') id: string) {
    return { data: await this.newsletters.unschedule(id) };
  }

  @Post(':id/send')
  async send(@Param('id') id: string) {
    return { data: await this.newsletters.sendNow(id) };
  }

  @Post(':id/duplicate')
  async duplicate(@Param('id') id: string, @CurrentUserId() adminUserId: string) {
    return { data: await this.newsletters.duplicate(id, adminUserId) };
  }
}
