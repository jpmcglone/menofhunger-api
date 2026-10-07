import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { AdminGuard } from './admin.guard';
import { AdminCrewsService } from './admin-crews.service';
import { CrewService } from '../crew/crew.service';
import { queryBoolean } from '../../common/validation/query-boolean';

const listSchema = z.object({
  q: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).max(10_000).optional(),
  includeDisbanded: queryBoolean().optional(),
});

const transferSchema = z.object({
  newOwnerUserId: z.string().trim().min(1),
});

@UseGuards(AdminGuard)
@Controller('admin/crews')
export class AdminCrewsController {
  constructor(
    private readonly crews: AdminCrewsService,
    private readonly crew: CrewService,
  ) {}

  @Get()
  async list(@Query() query: unknown) {
    return this.crews.list(listSchema.parse(query));
  }

  @Get(':id')
  async detail(@Param('id') id: string) {
    return this.crews.detail(id);
  }

  /** Disband any crew (admin override). */
  @Delete(':id')
  async disband(@Param('id') id: string) {
    await this.crew.adminForceDisband(id);
    return { data: {} };
  }

  /** Force ownership transfer regardless of current owner consent. */
  @Post(':id/transfer')
  async transferOwnership(@Param('id') id: string, @Body() body: unknown) {
    return this.crews.transferOwnership(id, transferSchema.parse(body));
  }
}
