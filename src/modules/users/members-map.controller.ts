import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { AuthGuard } from '../auth/auth.guard';
import { VerifiedGuard } from '../auth/verified.guard';
import { rateLimitLimit, rateLimitTtl } from '../../common/throttling/rate-limit.resolver';
import type { MembersMapSummaryDto, UserListDto } from '../../common/dto';
import { MembersMapService } from './members-map.service';

const membersQuerySchema = z.object({
  state: z
    .string()
    .trim()
    .regex(/^([A-Za-z]{2}|none)$/, 'State must be a two-letter code or "none".')
    .transform((s) => (s === 'none' ? 'none' : s.toUpperCase())),
  cursor: z.string().trim().regex(/^\d+$/).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

@Controller('users/map')
@UseGuards(AuthGuard, VerifiedGuard)
export class MembersMapController {
  constructor(private readonly membersMap: MembersMapService) {}

  @Throttle({ default: { limit: rateLimitLimit('publicRead', 60), ttl: rateLimitTtl('publicRead', 60) } })
  @Get()
  async summary(): Promise<{ data: MembersMapSummaryDto }> {
    return { data: await this.membersMap.summary() };
  }

  @Throttle({ default: { limit: rateLimitLimit('publicRead', 120), ttl: rateLimitTtl('publicRead', 60) } })
  @Get('members')
  async members(
    @Query() query: unknown,
  ): Promise<{ data: UserListDto[]; pagination: { nextCursor: string | null } }> {
    const { state, cursor, limit = 60 } = membersQuerySchema.parse(query);
    const result = await this.membersMap.members({ state, cursor: cursor ?? null, limit });
    return { data: result.users, pagination: { nextCursor: result.nextCursor } };
  }
}
