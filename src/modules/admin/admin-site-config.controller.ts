import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service';
import { PostsService } from '../posts/posts.service';
import { AdminGuard } from './admin.guard';

const updateSchema = z.object({
  postsPerWindow: z.coerce.number().int().min(1).max(100).optional(),
  windowSeconds: z.coerce.number().int().min(10).max(24 * 60 * 60).optional(),
  verifiedPostsPerWindow: z.coerce.number().int().min(1).max(100).optional(),
  verifiedWindowSeconds: z.coerce.number().int().min(10).max(24 * 60 * 60).optional(),
  premiumPostsPerWindow: z.coerce.number().int().min(1).max(100).optional(),
  premiumWindowSeconds: z.coerce.number().int().min(10).max(24 * 60 * 60).optional(),
});

@UseGuards(AdminGuard)
@Controller('admin/site-config')
export class AdminSiteConfigController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly posts: PostsService,
  ) {}

  @Get()
  async get() {
    const cfg = await this.prisma.siteConfig.findUnique({ where: { id: 1 } });
    return {
      data:
        cfg ??
        ({
          id: 1,
          postsPerWindow: 5,
          windowSeconds: 300,
          verifiedPostsPerWindow: 5,
          verifiedWindowSeconds: 300,
          premiumPostsPerWindow: 5,
          premiumWindowSeconds: 300,
        } as const),
    };
  }

  @Patch()
  async update(@Body() body: unknown) {
    const parsed = updateSchema.parse(body);
    const updated = await this.prisma.siteConfig.upsert({
      where: { id: 1 },
      create: {
        id: 1,
        postsPerWindow: parsed.postsPerWindow ?? 5,
        windowSeconds: parsed.windowSeconds ?? 300,
        verifiedPostsPerWindow: parsed.verifiedPostsPerWindow ?? 5,
        verifiedWindowSeconds: parsed.verifiedWindowSeconds ?? 300,
        premiumPostsPerWindow: parsed.premiumPostsPerWindow ?? 5,
        premiumWindowSeconds: parsed.premiumWindowSeconds ?? 300,
      },
      update: {
        ...(parsed.postsPerWindow !== undefined ? { postsPerWindow: parsed.postsPerWindow } : {}),
        ...(parsed.windowSeconds !== undefined ? { windowSeconds: parsed.windowSeconds } : {}),
        ...(parsed.verifiedPostsPerWindow !== undefined ? { verifiedPostsPerWindow: parsed.verifiedPostsPerWindow } : {}),
        ...(parsed.verifiedWindowSeconds !== undefined ? { verifiedWindowSeconds: parsed.verifiedWindowSeconds } : {}),
        ...(parsed.premiumPostsPerWindow !== undefined ? { premiumPostsPerWindow: parsed.premiumPostsPerWindow } : {}),
        ...(parsed.premiumWindowSeconds !== undefined ? { premiumWindowSeconds: parsed.premiumWindowSeconds } : {}),
      },
    });
    this.posts.invalidateSiteConfigCache();
    return { data: updated };
  }
}

