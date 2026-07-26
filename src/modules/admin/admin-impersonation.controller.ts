import { Body, Controller, Post, Req, Res, UnauthorizedException, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AdminGuard, type AdminRequest } from './admin.guard';
import { ImpersonationService } from '../auth/impersonation.service';

const startSchema = z.object({
  username: z.string().min(1).max(64),
});

/**
 * Admin impersonation ("log in as another user").
 *
 * Only `start` lives here. Once impersonation is active the effective session belongs to
 * the target user, who is not a site admin, so `AdminGuard` would 404 any stop endpoint.
 * Stopping therefore lives on `POST /auth/impersonate/stop`, gated on the session itself
 * carrying `impersonatedByUserId`.
 */
@ApiTags('Admin')
@UseGuards(AdminGuard)
@Controller('admin/impersonate')
export class AdminImpersonationController {
  constructor(private readonly impersonation: ImpersonationService) {}

  @ApiOperation({
    summary: 'Start impersonating a user (site admin only); swaps this client’s session cookie',
  })
  @Post()
  async start(
    @Req() req: AdminRequest,
    @Res({ passthrough: true }) res: Response,
    @Body() body: unknown,
  ) {
    const adminUserId = req.user?.id;
    if (!adminUserId) throw new UnauthorizedException();
    const parsed = startSchema.parse(body);
    const result = await this.impersonation.start(adminUserId, parsed.username, res);
    return { data: result };
  }
}
