import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AuthGuard } from '../auth/auth-public-api';
import { OptionalAuthGuard } from '../auth/auth-public-api';
import { VerifiedGuard } from '../auth/auth-public-api';
import { UserLookupService } from '../user-lookup/user-lookup.service';
import { rateLimitLimit, rateLimitTtl } from '../../common/throttling/rate-limit.resolver';
import type { MembersMapSummaryDto, UserListDto } from '../../common/dto';
import { MembersMapService } from './members-map.service';
import { OptionalCurrentUserId } from './users.decorator';
import { membersQuerySchema } from './members-map.schemas';

@Controller('users/map')
export class MembersMapController {
  constructor(
    private readonly membersMap: MembersMapService,
    private readonly users: UserLookupService,
  ) {}

  /** Public: everyone sees counts; only verified members see faces and who is online. */
  @UseGuards(OptionalAuthGuard)
  @Throttle({ default: { limit: rateLimitLimit('publicRead', 60), ttl: rateLimitTtl('publicRead', 60) } })
  @Get()
  async summary(@OptionalCurrentUserId() userId: string | undefined): Promise<{ data: MembersMapSummaryDto }> {
    const membersVisible = await this.users.viewerCanSeeMembers(userId);
    return { data: await this.membersMap.summary({ membersVisible, viewerUserId: userId ?? null }) };
  }

  @UseGuards(AuthGuard, VerifiedGuard)
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
