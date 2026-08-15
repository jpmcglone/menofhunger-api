import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { CurrentUserId } from '../users/users.decorator';
import { AnnouncementsService } from '../announcements/announcements.service';
import { AdminGuard } from './admin.guard';

const writeSchema = z.object({
  title: z.string().trim().max(120).optional().nullable(),
  body: z.string().trim().max(2000).optional().nullable(),
  isAd: z.boolean().optional(),
  placement: z.enum(['overlay', 'inline']).optional(),
  ctaLabel: z.string().trim().max(40).optional().nullable(),
  ctaHref: z.string().trim().max(500).optional().nullable(),
  endsAt: z.string().datetime().optional().nullable(),
  imageKey: z.string().trim().max(500).optional().nullable(),
});

@UseGuards(AdminGuard)
@Controller('admin/announcements')
export class AdminAnnouncementsController {
  constructor(private readonly announcements: AnnouncementsService) {}

  @Get()
  async list() {
    return { data: await this.announcements.listAdmin() };
  }

  @Get(':id')
  async get(@Param('id') id: string) {
    return { data: await this.announcements.getAdmin(id) };
  }

  @Post()
  async create(@CurrentUserId() adminUserId: string, @Body() body: unknown) {
    const parsed = writeSchema.parse(body);
    return {
      data: await this.announcements.create(adminUserId, toWriteInput(parsed)),
    };
  }

  @Patch(':id')
  async update(@Param('id') id: string, @Body() body: unknown) {
    const parsed = writeSchema.parse(body);
    return {
      data: await this.announcements.update(id, toWriteInput(parsed)),
    };
  }

  @Post(':id/publish')
  async publish(@Param('id') id: string) {
    return { data: await this.announcements.publish(id) };
  }

  @Post(':id/unpublish')
  async unpublish(@Param('id') id: string) {
    return { data: await this.announcements.unpublish(id) };
  }

  @Post(':id/archive')
  async archive(@Param('id') id: string) {
    return { data: await this.announcements.archive(id) };
  }

  @Post(':id/reset')
  async reset(@Param('id') id: string) {
    return { data: await this.announcements.reset(id) };
  }
}

function toWriteInput(parsed: z.infer<typeof writeSchema>) {
  return {
    title: parsed.title,
    body: parsed.body,
    isAd: parsed.isAd,
    placement: parsed.placement,
    ctaLabel: parsed.ctaLabel,
    ctaHref: parsed.ctaHref,
    imageKey: parsed.imageKey,
    endsAt: parsed.endsAt === undefined ? undefined : parsed.endsAt ? new Date(parsed.endsAt) : null,
  };
}
