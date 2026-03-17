import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { OptionalAuthGuard } from '../auth/optional-auth.guard';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUserId } from '../users/users.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { TaxonomyService } from './taxonomy.service';

const searchSchema = z.object({
  q: z.string().trim().max(120).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});

const preferenceSchema = z.object({
  termIds: z.array(z.string().trim().min(1)).max(30),
});

@UseGuards(OptionalAuthGuard)
@Controller('taxonomy')
export class TaxonomyController {
  constructor(
    private readonly taxonomy: TaxonomyService,
    private readonly prisma: PrismaService,
  ) {}

  @Get('search')
  async search(@Query() query: unknown) {
    const parsed = searchSchema.parse(query);
    const q = (parsed.q ?? '').trim();
    const limit = parsed.limit ?? 10;
    const data = await this.taxonomy.search({ q, limit });
    return { data };
  }

  @UseGuards(AuthGuard)
  @Get('me/preferences')
  async getPreferences(@CurrentUserId() userId: string) {
    const data = await this.taxonomy.getUserPreferences(userId);
    return { data };
  }

  @UseGuards(AuthGuard)
  @Post('me/preferences')
  async setPreferences(@CurrentUserId() userId: string, @Body() body: unknown) {
    const parsed = preferenceSchema.parse(body);
    const data = await this.taxonomy.setUserPreferences(userId, parsed.termIds);
    return { data };
  }

  @UseGuards(AuthGuard)
  @Post('backfill')
  async backfill(@CurrentUserId() userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { siteAdmin: true },
    });
    if (!user?.siteAdmin) return { data: { ok: false, reason: 'Admin only.' } };
    const data = await this.taxonomy.backfillAndSync();
    return { data };
  }
}
