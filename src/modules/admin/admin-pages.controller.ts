import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AdminGuard } from './admin.guard';
import { PagesService } from '../pages/pages.service';

const createPageSchema = z.object({
  username: z.string().trim().min(1),
  name: z.string().trim().min(1).max(50),
  isOrganization: z.boolean().optional().default(false),
  operatorUserId: z.string().min(1),
});

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
