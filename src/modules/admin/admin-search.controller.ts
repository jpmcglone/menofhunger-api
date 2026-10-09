import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AdminGuard } from './admin.guard';
import { AdminSearchService } from './admin-search.service';
import { listSchema } from './admin-search.schemas';

@UseGuards(AdminGuard)
@Controller('admin/searches')
export class AdminSearchController {
  constructor(private readonly searches: AdminSearchService) {}

  @Get()
  async list(@Query() query: unknown) {
    return this.searches.list(listSchema.parse(query));
  }
}
