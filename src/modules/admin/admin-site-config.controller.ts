import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service';
import { AdminGuard } from './admin.guard';

const updateSchema = z.object({
  postsPerWindow: z.coerce.number().int().min(1).max(100).optional(),
  windowSeconds: z.coerce.number().int().min(10).max(24 * 60 * 60).optional(),
});

@UseGuards(AdminGuard)
@Controller('admin/site-config')
export class AdminSiteConfigController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async get() {
    const cfg = await this.prisma.siteConfig.findUnique({ where: { id: 1 } });
    return {
      config: cfg ?? { id: 1, postsPerWindow: 5, windowSeconds: 300 },
    };
  }

  @Patch()
  async update(@Body() body: unknown) {
    const parsed = updateSchema.parse(body);
    const updated = await this.prisma.siteConfig.upsert({
      where: { id: 1 },
      create: { id: 1, postsPerWindow: parsed.postsPerWindow ?? 5, windowSeconds: parsed.windowSeconds ?? 300 },
      update: {
        ...(parsed.postsPerWindow !== undefined ? { postsPerWindow: parsed.postsPerWindow } : {}),
        ...(parsed.windowSeconds !== undefined ? { windowSeconds: parsed.windowSeconds } : {}),
      },
    });
    return { config: updated };
  }
}

