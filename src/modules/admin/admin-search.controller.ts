import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AdminGuard } from './admin.guard';
import { AdminSearchService } from './admin-search.service';

const listSchema = z.object({
  q: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().optional(),
});

@UseGuards(AdminGuard)
@Controller('admin/searches')
export class AdminSearchController {
  constructor(private readonly searches: AdminSearchService) {}

  @Get()
  async list(@Query() query: unknown) {
    return this.searches.list(listSchema.parse(query));
  }
}
