import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { AdminGuard } from './admin.guard';
import { PagesService } from '../pages/pages.service';
import { createPageSchema } from './admin-pages.schemas';

@UseGuards(AdminGuard)
@Controller('admin/pages')
export class AdminPagesController {
  constructor(private readonly pages: PagesService) {}

  @Post()
  async create(@Body() body: unknown) {
    const parsed = createPageSchema.parse(body);
    const data = await this.pages.createPage(parsed);
    return { data };
  }
}
