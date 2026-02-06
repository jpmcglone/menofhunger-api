import { BadRequestException, Body, Controller, Get, Param, Patch, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { toVerificationRequestAdminDto } from '../../common/dto';
import { VerificationService } from '../verification/verification.service';
import { AdminGuard } from './admin.guard';
import { CurrentUserId } from '../users/users.decorator';

const listSchema = z.object({
  q: z.string().trim().max(200).optional(),
  status: z.enum(['pending', 'approved', 'rejected', 'cancelled']).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().optional(),
});

const approveSchema = z.object({
  adminNote: z.union([z.string().trim().max(2000), z.null()]).optional(),
});

const rejectSchema = z.object({
  rejectionReason: z.string().trim().min(1).max(2000),
  adminNote: z.union([z.string().trim().max(2000), z.null()]).optional(),
});

@UseGuards(AdminGuard)
@Controller('admin/verification')
export class AdminVerificationController {
  constructor(private readonly verification: VerificationService) {}

  @Get()
  async list(@Query() query: unknown) {
    const parsed = listSchema.parse(query);
    const limit = parsed.limit ?? 50;

    const { rows, nextCursor } = await this.verification.listAdmin({
      limit,
      cursor: parsed.cursor ?? null,
      status: parsed.status,
      q: parsed.q,
    });

    return {
      data: rows.map((row) => toVerificationRequestAdminDto(row)),
      pagination: { nextCursor },
    };
  }

  @Patch(':id/approve')
  async approve(@Param('id') id: string, @Body() body: unknown, @CurrentUserId() adminUserId?: string) {
    const parsed = approveSchema.parse(body ?? {});
    if (!adminUserId) throw new BadRequestException('Missing admin user.');

    const updated = await this.verification.approveAdmin({
      requestId: id,
      adminUserId,
      adminNote: parsed.adminNote ?? null,
    });

    return { data: toVerificationRequestAdminDto(updated) };
  }

  @Patch(':id/reject')
  async reject(@Param('id') id: string, @Body() body: unknown, @CurrentUserId() adminUserId?: string) {
    const parsed = rejectSchema.parse(body ?? {});
    if (!adminUserId) throw new BadRequestException('Missing admin user.');

    const updated = await this.verification.rejectAdmin({
      requestId: id,
      adminUserId,
      rejectionReason: parsed.rejectionReason,
      adminNote: parsed.adminNote ?? null,
    });

    return { data: toVerificationRequestAdminDto(updated) };
  }
}

