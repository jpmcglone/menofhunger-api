import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AdminGuard } from './admin.guard';
import { AdminHashtagsService } from './admin-hashtags.service';

const backfillSchema = z.object({
  /** Existing run id. If omitted, a new run is started. */
  runId: z.string().trim().min(1).optional(),
  /** Cursor post id (createdAt/id cursor). If omitted, uses stored run cursor. */
  cursor: z.string().trim().min(1).optional(),
  /** Batch size (posts per request). */
  batchSize: z.coerce.number().int().min(10).max(5_000).optional(),
  /** When true and starting a new run, reset hashtag tables before scanning. */
  reset: z.coerce.boolean().optional(),
});

@UseGuards(AdminGuard)
@Controller('admin/hashtags')
export class AdminHashtagsController {
  constructor(private readonly adminHashtags: AdminHashtagsService) {}

  @Get('backfill')
  async backfillStatus() {
    return await this.adminHashtags.getBackfillStatus();
  }

  @Post('backfill')
  async backfill(@Body() body: unknown) {
    const parsed = backfillSchema.parse(body ?? {});
    return await this.adminHashtags.runBackfillBatch({
      runId: parsed.runId ?? null,
      cursor: parsed.cursor ?? null,
      batchSize: parsed.batchSize ?? 500,
      reset: Boolean(parsed.reset),
    });
  }
}

