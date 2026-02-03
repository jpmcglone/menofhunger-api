import { Controller, Get, UseGuards } from '@nestjs/common';
import { OptionalCurrentUserId } from '../users/users.decorator';
import { Throttle } from '@nestjs/throttler';
import { OptionalAuthGuard } from '../auth/optional-auth.guard';
import { FollowsService } from '../follows/follows.service';
import { PresenceService } from './presence.service';
import { rateLimitLimit, rateLimitTtl } from '../../common/throttling/rate-limit.resolver';

@Controller('presence')
export class PresenceController {
  constructor(
    private readonly presence: PresenceService,
    private readonly follows: FollowsService,
  ) {}

  @UseGuards(OptionalAuthGuard)
  @Throttle({
    default: {
      limit: rateLimitLimit('interact', 60),
      ttl: rateLimitTtl('interact', 60),
    },
  })
  @Get('online')
  async online(@OptionalCurrentUserId() userId: string | undefined) {
    const viewerUserId = userId ?? null;
    const userIds = this.presence.getOnlineUserIds();
    const users = await this.follows.getFollowListUsersByIds({
      viewerUserId,
      userIds,
    });
    const orderMap = new Map(userIds.map((id, i) => [id, i]));
    users.sort((a, b) => (orderMap.get(a.id) ?? 999) - (orderMap.get(b.id) ?? 999));
    const lastConnectAtById = new Map(userIds.map((id) => [id, this.presence.getLastConnectAt(id) ?? 0]));
    const idleById = new Map(userIds.map((id) => [id, this.presence.isUserIdle(id)]));
    const data = users.map((u) => ({
      ...u,
      lastConnectAt: lastConnectAtById.get(u.id),
      idle: idleById.get(u.id) ?? false,
    }));
    return { data, pagination: { totalOnline: userIds.length } };
  }
}
