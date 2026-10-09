import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { OptionalAuthGuard } from '../auth/auth-public-api';
import { AuthGuard } from '../auth/auth-public-api';
import { CurrentUserId } from '../users/users.decorator';
import { AdminGuard } from '../admin/admin.guard';
import { TaxonomyService } from './taxonomy.service';
import { searchSchema, preferenceSchema } from './taxonomy.schemas';

@UseGuards(OptionalAuthGuard)
@Controller('taxonomy')
export class TaxonomyController {
  constructor(
    private readonly taxonomy: TaxonomyService,
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

  @UseGuards(AdminGuard)
  @Post('backfill')
  async backfill() {
    const data = await this.taxonomy.backfillAndSync();
    return { data };
  }
}
